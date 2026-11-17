import sql from "mssql";
import type { ErpConnection } from "@/lib/mcp/client";
import type { ProcedureParameter } from "@/types/chat";
import type { IntentProcedure } from "./metadata";
import { checkSelectSql } from "./sql-guard";

/*
 * Trusted server-side execution of the backend side of the ERP workflow: allowlisted stored
 * procedures from the intent metadata (parameterized) and model-generated SELECTs (guarded).
 *
 * Off unless ERP_SQL_EXECUTION=enabled. Even then it only runs after a live check that the ERP_*
 * login is least-privilege, which is the primary safety control: no server role or permission beyond
 * connecting, no owner/writer/DDL/security database roles, no effective database permission to
 * change data, schema or security or to run code (INSERT/UPDATE/DELETE/ALTER/CONTROL/CREATE/EXECUTE/...),
 * no write, ALTER or EXECUTE grant on any gnd_* schema and no writable table or view. Each SELECT is
 * checked again here (read-only guard and the caller's execution policy). Every statement also runs
 * with a timeout and a row limit, in a transaction that is always rolled back (a last layer, not the
 * control). Credentials never leave this module except to the SQL Server driver; errors are reported
 * without them.
 */

const readNumber = (name: string, fallback: number) => {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
};

export const executionConfig = {
  enabled: /^enabled$/i.test(process.env.ERP_SQL_EXECUTION?.trim() ?? ""),
  /** Rows returned per statement; more are cut off and the result is marked truncated. */
  maxRows: readNumber("ERP_SQL_MAX_ROWS", 200),
  timeoutMs: readNumber("ERP_SQL_TIMEOUT_MS", 15_000),
  /** Characters of JSON rows per result passed to the model. */
  maxResultChars: readNumber("ERP_SQL_MAX_RESULT_CHARS", 12_000),
  trustServerCertificate: /^true$/i.test(process.env.ERP_SQL_TRUST_SERVER_CERTIFICATE?.trim() ?? ""),
};

export type Row = Record<string, unknown>;

export interface ExecutionResult {
  /** Rows of the first result set, or every result set when there are several. */
  data: Row[] | Row[][];
  truncated: boolean;
  /** Column names of the first result set, as the database declared them (also when it has no rows). */
  columns?: string[];
}

export interface Executor {
  runSelect(query: string, signal: AbortSignal): Promise<ExecutionResult>;
  runProcedure(procedure: IntentProcedure, parameters: Record<string, ProcedureParameter>, signal: AbortSignal): Promise<ExecutionResult>;
  close(): Promise<void>;
}

/** An execution failure; `message` is safe to show (no SQL text, data or credentials). */
export class ExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecutionError";
  }
}

function poolConfig(erp: ErpConnection): sql.config {
  const [hostPart, port] = erp.server.split(",");
  const [server, instanceName] = hostPart.split("\\");
  return {
    server,
    ...(port ? { port: Number(port) } : {}),
    database: erp.database,
    user: erp.username,
    password: erp.password,
    connectionTimeout: 10_000,
    requestTimeout: executionConfig.timeoutMs,
    pool: { max: 1, min: 0 },
    options: {
      encrypt: erp.ssl,
      trustServerCertificate: executionConfig.trustServerCertificate,
      ...(instanceName ? { instanceName } : {}),
      readOnlyIntent: true,
    },
  };
}

/** Permission checks, all fixed catalog queries. Any non-zero column means the login can write, administer or run code. */
const VERIFY_SQL = `
SELECT
  ISNULL(IS_SRVROLEMEMBER('sysadmin'), 0) AS sysadmin,
  ISNULL(HAS_PERMS_BY_NAME(NULL, NULL, 'CONTROL SERVER'), 0) AS control_server,
  ISNULL(IS_ROLEMEMBER('db_owner'), 0) AS db_owner,
  ISNULL(IS_ROLEMEMBER('db_datawriter'), 0) AS db_datawriter,
  ISNULL(IS_ROLEMEMBER('db_ddladmin'), 0) AS db_ddladmin,
  ISNULL(IS_ROLEMEMBER('db_securityadmin'), 0) AS db_securityadmin,
  ISNULL(IS_ROLEMEMBER('db_accessadmin'), 0) AS db_accessadmin,
  ISNULL(IS_ROLEMEMBER('db_backupoperator'), 0) AS db_backupoperator,
  ISNULL(HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'CONTROL'), 0) AS db_control,
  ISNULL(HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'ALTER'), 0) AS db_alter,
  ISNULL(HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'INSERT'), 0) AS db_insert,
  ISNULL(HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'UPDATE'), 0) AS db_update,
  ISNULL(HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'DELETE'), 0) AS db_delete,
  ISNULL(HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'CREATE TABLE'), 0) AS db_create_table,
  ISNULL(HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'CREATE PROCEDURE'), 0) AS db_create_procedure,
  (SELECT COUNT(*) FROM sys.objects o WHERE o.type = 'U' AND (
     HAS_PERMS_BY_NAME(QUOTENAME(SCHEMA_NAME(o.schema_id)) + '.' + QUOTENAME(o.name), 'OBJECT', 'INSERT') = 1 OR
     HAS_PERMS_BY_NAME(QUOTENAME(SCHEMA_NAME(o.schema_id)) + '.' + QUOTENAME(o.name), 'OBJECT', 'UPDATE') = 1 OR
     HAS_PERMS_BY_NAME(QUOTENAME(SCHEMA_NAME(o.schema_id)) + '.' + QUOTENAME(o.name), 'OBJECT', 'DELETE') = 1 OR
     HAS_PERMS_BY_NAME(QUOTENAME(SCHEMA_NAME(o.schema_id)) + '.' + QUOTENAME(o.name), 'OBJECT', 'ALTER') = 1)) AS writable_tables,
  (SELECT COUNT(*) FROM sys.schemas s WHERE s.name LIKE 'gnd[_]%' AND (
     HAS_PERMS_BY_NAME(s.name, 'SCHEMA', 'INSERT') = 1 OR HAS_PERMS_BY_NAME(s.name, 'SCHEMA', 'UPDATE') = 1 OR
     HAS_PERMS_BY_NAME(s.name, 'SCHEMA', 'DELETE') = 1 OR HAS_PERMS_BY_NAME(s.name, 'SCHEMA', 'ALTER') = 1 OR
     HAS_PERMS_BY_NAME(s.name, 'SCHEMA', 'CONTROL') = 1 OR HAS_PERMS_BY_NAME(s.name, 'SCHEMA', 'EXECUTE') = 1)) AS writable_or_executable_schemas`;

/** Effective database and server permissions beyond reading; only their names are reported. */
const RISKY_PERMISSIONS_SQL = `
SELECT 'DATABASE' AS scope, permission_name FROM fn_my_permissions(NULL, 'DATABASE')
WHERE permission_name NOT IN ('CONNECT', 'SELECT', 'SHOWPLAN', 'VIEW DEFINITION', 'VIEW DATABASE STATE', 'REFERENCES')
UNION ALL
SELECT 'SERVER', permission_name FROM fn_my_permissions(NULL, 'SERVER')
WHERE permission_name NOT IN ('CONNECT SQL', 'VIEW ANY DATABASE', 'VIEW ANY DEFINITION', 'VIEW SERVER STATE')`;

const VERIFY_TTL_MS = 10 * 60_000;
let verified: { key: string; at: number; result: Promise<LoginAssessment> } | undefined;

/** The outcome of the least-privilege check: what was found (role and permission names, counts; never data). */
export interface LoginAssessment {
  ok: boolean;
  /** Why the login may not be used for execution; empty when ok. */
  findings: string[];
  /** Set when the check itself couldn't run. */
  error?: string;
}

/**
 * Checks that the login is least-privilege, with fixed catalog queries only. Cached briefly per
 * connection. Execution is allowed only when every check passed.
 */
export function assessLogin(erp: ErpConnection): Promise<LoginAssessment> {
  const key = `${erp.server}|${erp.database}|${erp.username}`;
  if (verified && verified.key === key && Date.now() - verified.at < VERIFY_TTL_MS) return verified.result;
  const result = (async (): Promise<LoginAssessment> => {
    const pool = new sql.ConnectionPool(poolConfig(erp));
    try {
      await pool.connect();
      const row = (await pool.request().query(VERIFY_SQL)).recordset[0] as Record<string, number>;
      const findings = Object.entries(row)
        .filter(([, value]) => Number(value) !== 0)
        .map(([name, value]) => (/^writable/.test(name) ? `${name.replace(/_/g, " ")}: ${value}` : name));
      const risky = (await pool.request().query(RISKY_PERMISSIONS_SQL)).recordset as { scope: string; permission_name: string }[];
      for (const scope of ["SERVER", "DATABASE"]) {
        const names = risky.filter((r) => r.scope === scope).map((r) => r.permission_name);
        if (names.length) findings.push(`${scope.toLowerCase()} permissions beyond reading: ${names.length} (${names.slice(0, 12).join(", ")}${names.length > 12 ? ", ..." : ""})`);
      }
      return { ok: findings.length === 0, findings };
    } catch (error) {
      console.warn(`[erp-sql] permission check failed: ${describe(error)}`);
      return { ok: false, findings: [], error: "the database login's permissions could not be verified" };
    } finally {
      await pool.close().catch(() => {});
    }
  })();
  verified = { key, at: Date.now(), result };
  return result;
}

/** Why the login may not be used (short, for the user), or null when it passed. */
async function verifyLogin(erp: ErpConnection): Promise<string | null> {
  const assessment = await assessLogin(erp);
  if (assessment.error) return assessment.error;
  if (assessment.ok) return null;
  console.warn(`[erp-sql] execution blocked, the database login is not least-privilege: ${assessment.findings.join("; ")}`);
  return `the database login is not least-privilege (${assessment.findings.slice(0, 4).join("; ")})`;
}

/** Driver error codes and SQL Server error numbers only; never the message text (it can quote data or names). */
function describe(error: unknown): string {
  const e = error as { code?: unknown; number?: unknown; name?: unknown };
  return [e.name, e.code, e.number, (e as any).message].filter((v) => v !== undefined).join(" ") || "unknown error";
}

const SQL_TYPES: Record<string, () => sql.ISqlType> = {
  date: () => sql.Date(),
  datetime: () => sql.DateTime(),
  datetime2: () => sql.DateTime2(),
  smalldatetime: () => sql.SmallDateTime(),
  time: () => sql.Time(),
  int: () => sql.Int(),
  bigint: () => sql.BigInt(),
  smallint: () => sql.SmallInt(),
  tinyint: () => sql.TinyInt(),
  bit: () => sql.Bit(),
  boolean: () => sql.Bit(),
  decimal: () => sql.Decimal(38, 8),
  numeric: () => sql.Numeric(38, 8),
  float: () => sql.Float(),
  real: () => sql.Real(),
  money: () => sql.Money(),
  nvarchar: () => sql.NVarChar(sql.MAX),
  varchar: () => sql.NVarChar(sql.MAX),
  nchar: () => sql.NVarChar(sql.MAX),
  char: () => sql.NVarChar(sql.MAX),
  uniqueidentifier: () => sql.UniqueIdentifier(),
};

/** Converts a validated parameter value to the driver's input value. */
function toInput(type: string, value: ProcedureParameter["value"]): unknown {
  if (value === null) return null;
  if (type === "date" && typeof value === "string") return new Date(`${value}T00:00:00Z`);
  if (/datetime/.test(type) && typeof value === "string") return new Date(`${value.replace(" ", "T")}${value.length === 10 ? "T00:00:00" : ""}Z`);
  if (type === "bit" || type === "boolean") return value === 1 || value === true;
  return value;
}

/** JSON-safe row values: dates as ISO text, binary data omitted. */
function plainRow(row: Row): Row {
  const out: Row = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = value instanceof Date ? value.toISOString() : Buffer.isBuffer(value) ? "[binary]" : value;
  }
  return out;
}

/** Streams a request's result sets, stopping at the row limit; cancels on abort. */
function collect(request: sql.Request, start: () => void, signal: AbortSignal): Promise<ExecutionResult> {
  return new Promise((resolve, reject) => {
    const sets: Row[][] = [];
    let rows = 0;
    let truncated = false;
    let failure: unknown;
    const onAbort = () => request.cancel();
    signal.addEventListener("abort", onAbort, { once: true });
    request.stream = true;
    let columns: string[] | undefined;
    request.on("recordset", (meta: Record<string, unknown>) => {
      if (sets.length === 0) columns = Object.keys(meta ?? {});
      sets.push([]);
    });
    request.on("row", (row: Row) => {
      if (rows >= executionConfig.maxRows) {
        if (!truncated) {
          truncated = true;
          request.cancel();
        }
        return;
      }
      if (sets.length === 0) sets.push([]);
      sets[sets.length - 1].push(plainRow(row));
      rows++;
    });
    request.on("error", (error: unknown) => {
      // Cancelling at the row limit is not a failure.
      if (!(truncated && (error as { code?: unknown }).code === "ECANCEL")) failure ??= error;
    });
    request.on("done", () => {
      signal.removeEventListener("abort", onAbort);
      if (signal.aborted) reject(new DOMException("Aborted", "AbortError"));
      else if (failure) reject(new ExecutionError(`the database reported an error (${describe(failure)})`));
      else resolve({ data: sets.length > 1 ? sets : (sets[0] ?? []), truncated, ...(columns && { columns }) });
    });
    start();
  });
}

/** Runs `work` in a transaction that is always rolled back, so nothing it does can persist. */
async function inRolledBackTransaction(pool: sql.ConnectionPool, work: (request: sql.Request) => Promise<ExecutionResult>): Promise<ExecutionResult> {
  const transaction = new sql.Transaction(pool);
  await transaction.begin(sql.ISOLATION_LEVEL.READ_COMMITTED);
  try {
    return await work(new sql.Request(transaction));
  } finally {
    await transaction.rollback().catch(() => {});
  }
}

/**
 * An executor for one chat turn, or why execution is unavailable. Never throws for configuration
 * or permission problems; those make execution unavailable (development-safe mode).
 */
export async function openExecutor(
  erp: ErpConnection | null,
  options: {
    /** The caller's execution policy for SELECTs (hybrid mode): the reason a query may not run, or null. */
    authorize?: (query: string) => string | null;
  } = {},
): Promise<Executor | { unavailable: string }> {
  if (!executionConfig.enabled) return { unavailable: "SQL and procedure execution is disabled (ERP_SQL_EXECUTION is not \"enabled\")" };
  if (!erp) return { unavailable: "the ERP database connection is not configured" };
  const problem = process.env.ERP_ALLOW_PRIVILEGED_LOGIN === "true" ? null : await verifyLogin(erp);
  if (problem) return { unavailable: problem };

  const pool = new sql.ConnectionPool(poolConfig(erp));
  try {
    await pool.connect();
  } catch (error) {
    console.warn(`[erp-sql] connection failed: ${describe(error)}`);
    await pool.close().catch(() => {});
    return { unavailable: "the database could not be reached" };
  }

  const guard = async (work: () => Promise<ExecutionResult>): Promise<ExecutionResult> => {
    try {
      return await work();
    } catch (error) {
      if (error instanceof ExecutionError || (error as { name?: unknown }).name === "AbortError") throw error;
      throw new ExecutionError(`the database request failed (${describe(error)})`);
    }
  };

  return {
    runSelect(query, signal) {
      // Checked again here: execution never relies on the caller having validated it.
      const problem = checkSelectSql(query) ?? options.authorize?.(query) ?? null;
      if (problem) return Promise.reject(new ExecutionError(`the SQL was rejected (${problem})`));
      return guard(() => inRolledBackTransaction(pool, (request) => collect(request, () => void request.query(query), signal)));
    },
    runProcedure(procedure, parameters, signal) {
      return guard(() =>
        inRolledBackTransaction(pool, (request) => {
          for (const declared of procedure.parameters) {
            const given = Object.entries(parameters).find(([name]) => name.toLowerCase() === declared.name.toLowerCase())?.[1];
            const type = /IDs$/.test(declared.name) ? "nvarchar" : declared.type.replace(/\(.*$/, "");
            const sqlType = SQL_TYPES[type];
            if (!sqlType) throw new ExecutionError(`parameter ${declared.name} has a type the executor doesn't support (${type})`);
            request.input(declared.name, sqlType(), toInput(type, given?.value ?? null));
          }
          // The name comes from the metadata allowlist, never from the model's text.
          return collect(request, () => void request.execute(procedure.procedure), signal);
        }),
      );
    },
    close: () => pool.close().catch(() => {}),
  };
}
