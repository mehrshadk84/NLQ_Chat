import type { ErpResponse, ErpResponseObject, ProcedureRequest } from "@/types/chat";
import { isExecCompanion, readErpResponse } from "./contract";
import type { ContextSource } from "./prompt";
import { initialProcedureOf, type ErpMetadata, type IntentProcedure } from "./metadata";
import { checkSelectSql, parseExecCompanion } from "./sql-guard";

/*
 * Server-side validation of a model turn beyond the field structure: requested procedures and
 * parameters must exist in the intent list of the prompt with their declared types and follow the
 * initial-procedure gate, resolve targets must name a real procedure parameter, and every SQL must
 * pass the read-only guard.
 * Invalid output is rejected (and regenerated once by the caller), never repaired.
 */

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATETIME = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2})(?::(\d{2}))?)?$/;

/** Gregorian only: a Shamsi date such as 1403-07-01 is rejected (the prompt requires conversion). */
function isGregorianDate(value: string, pattern: RegExp): boolean {
  const m = pattern.exec(value);
  if (!m) return false;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return year >= 1900 && year <= 2200 && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

const INTEGER_TYPES = new Set(["int", "bigint", "smallint", "tinyint"]);
const NUMBER_TYPES = new Set(["decimal", "numeric", "float", "real", "money", "smallmoney"]);
const baseType = (type: string) => type.toLowerCase().replace(/\(.*$/, "").trim();

/** Checks one parameter value against its declared type. */
function checkValue(name: string, value: ProcedureRequest["parameters"][string]): string | null {
  if (value.value === null) return null;
  const type = baseType(value.type);
  const v = value.value;
  if (type === "date") return typeof v === "string" && isGregorianDate(v, DATE) ? null : `${name} must be a Gregorian date "YYYY-MM-DD"`;
  if (type === "datetime" || type === "datetime2" || type === "smalldatetime") {
    return typeof v === "string" && isGregorianDate(v, DATETIME) ? null : `${name} must be a Gregorian "YYYY-MM-DD HH:mm:ss"`;
  }
  if (type === "boolean" || type === "bit") return v === 1 || v === 0 ? null : `${name} must be 1 or 0`;
  if (INTEGER_TYPES.has(type)) return typeof v === "number" && Number.isInteger(v) ? null : `${name} must be an integer`;
  if (NUMBER_TYPES.has(type)) return typeof v === "number" ? null : `${name} must be a number`;
  if (/char|text/.test(type)) return typeof v === "string" ? null : `${name} must be a string`;
  return null;
}

/** A procedure request must match the metadata exactly: every declared parameter, no others, declared types. */
function checkProcedure(request: ProcedureRequest, metadata: ErpMetadata): string | null {
  const known = metadata.procedures.get(request.procedure.toLowerCase());
  if (!known) return `procedure "${request.procedure}" is not in the intent list`;
  const given = Object.keys(request.parameters);
  for (const p of known.parameters) {
    const entry = Object.entries(request.parameters).find(([name]) => name.toLowerCase() === p.name.toLowerCase());
    if (!entry) return `${request.procedure}: parameter ${p.name} is missing (every parameter must be sent, null when not given)`;
    const [, value] = entry;
    // *IDs parameters are always sent as a comma-joined "nvarchar" string.
    const expected = /IDs$/.test(p.name) ? "nvarchar" : baseType(p.type);
    if (baseType(value.type) !== expected) return `${request.procedure}: ${p.name} must have type "${expected}"`;
    if (/IDs$/.test(p.name) && value.value !== null && !(typeof value.value === "string" && /^\d+(,\d+)*$/.test(value.value))) {
      return `${request.procedure}: ${p.name} must be comma-separated ids`;
    }
    const problem = checkValue(p.name, value);
    if (problem) return `${request.procedure}: ${problem}`;
  }
  const extra = given.find((name) => !known.parameters.some((p) => p.name.toLowerCase() === name.toLowerCase()));
  return extra ? `${request.procedure}: unknown parameter "${extra}"` : null;
}

export interface TurnContext {
  /** Uploaded-schema grounding check for SQL. */
  checkSql?: (sql: string) => string | null;
  /** Lower-case names of procedures whose results arrived in a BACKEND PAYLOAD this session. */
  receivedProcedures?: Set<string>;
  /** Whether any BACKEND PAYLOAD (procedure or SQL results) has arrived this session. */
  dataReceived?: boolean;
  /**
   * "file": the file-based SQL assistant. There are no procedures and no backend, so procedure
   * requests and resolve-queries are rejected, and SQL is grounded in the uploaded metadata file
   * (`checkSql`) instead of a schema fetched during the session.
   */
  /** The ERP workflow modes only; MCP Agent mode has its own pipeline and never validates ERP turns. */
  mode?: Exclude<ContextSource, "mcp-agent">;
  /**
   * Hybrid mode, after rows arrived: why an answer's text states something the rows don't support
   * (a number the database didn't return), or null.
   */
  checkAnswer?: (text: string) => string | null;
}

/** File and hybrid modes: no procedures, no resolve-queries, SQL grounded in the metadata file. */
const usesFileContract = (context: TurnContext) => context.mode === "file" || context.mode === "hybrid";

const FILE_MODE_NO_REQUESTS =
  "file-based mode has no procedures, no backend and no execution; write one SELECT query (\"query\" or \"query-diagram\") from the metadata reference, or \"ask\"";

/**
 * An "intent" request: every procedure valid (see checkProcedure), each belonging to an intent the
 * object names, and the INITIAL PROCEDURE GATE (FLOW 3.1): an intent with an "Initial" procedure gets
 * only that one until its result has arrived, and a received Initial result is never requested again.
 */
function checkIntentRequest(object: ErpResponseObject, metadata: ErpMetadata, received: Set<string>): string | null {
  const named = object.intent.split(",").map((n) => n.trim().toLowerCase());
  for (const request of object.procedures) {
    const problem = checkProcedure(request, metadata);
    if (problem) return problem;
    const known = metadata.procedures.get(request.procedure.toLowerCase())!;
    if (!named.includes(known.intent.toLowerCase())) return `${known.procedure} belongs to the intent "${known.intent}", which the "intent" field must name`;
    if (known.initial) {
      if (received.has(known.procedure.toLowerCase())) return `${known.procedure} was already received this session and must not be requested again`;
    } else {
      const initial = initialProcedureOf(metadata, known.intent);
      if (initial && !received.has(initial.procedure.toLowerCase())) {
        return `${known.procedure} can't be requested before the "${known.intent}" initial procedure ${initial.procedure} has returned (request only ${initial.procedure} first)`;
      }
    }
  }
  const names = object.procedures.map((p) => p.procedure.toLowerCase());
  const duplicate = names.find((n, i) => names.indexOf(n) !== i);
  return duplicate ? `${duplicate} is requested twice` : null;
}

function checkObject(object: ErpResponseObject, response: ErpResponse, metadata: ErpMetadata, context: TurnContext): string | null {
  switch (object.action) {
    case "intent":
      if (usesFileContract(context)) return `"intent" is not available: ${FILE_MODE_NO_REQUESTS}`;
      return checkIntentRequest(object, metadata, context.receivedProcedures ?? new Set());
    case "query": {
      if (isExecCompanion(object, response)) {
        const name = parseExecCompanion(object.sql);
        if (!name) return 'the companion "query" must be "EXEC schema.procedure @Param = value, ..."';
        const known = metadata.procedures.get(name.toLowerCase());
        if (!known) return `the companion "query" names an unknown procedure "${name}"`;
        if (object.intent === "Query") return 'the Query intent never gets an EXEC companion "query"';
        if (known.intent.toLowerCase() !== object.intent.toLowerCase()) return `the companion "query" for ${known.procedure} must have intent "${known.intent}"`;
        return null;
      }
      if (object.intent !== "Query") return `generated SQL belongs to the Query intent ("intent":"Query"), not "${object.intent}"`;
      break;
    }
    case "query-diagram":
      if (object.intent !== "Query") return `generated SQL belongs to the Query intent ("intent":"Query"), not "${object.intent}"`;
      break;
    case "client-diagram": {
      // A chart is built from data the backend returned (ACTION MEANINGS), never from nothing.
      if (!context.dataReceived) return "a chart can only be built from data the backend returned, and none has arrived in this session; request the data first";
      const intents = new Set([...metadata.procedures.values()].map((p) => p.intent.toLowerCase()));
      if (!intents.has(object.intent.toLowerCase())) return `"${object.intent}" is not an intent of the INTENT LIST`;
      return null;
    }
    case "resolve-query": {
      if (usesFileContract(context)) return `"resolve-query" is not available: ${FILE_MODE_NO_REQUESTS}`;
      const target: IntentProcedure | undefined = metadata.procedures.get(object.resolves.procedure.toLowerCase());
      if (!target) return `resolves.procedure "${object.resolves.procedure}" is not in the intent list`;
      if (target.intent.toLowerCase() !== object.resolves.intent.toLowerCase()) return `resolves.intent must be "${target.intent}"`;
      const parameter = target.parameters.find((p) => p.name.toLowerCase() === object.resolves.parameter.toLowerCase());
      if (!parameter) return `resolves.parameter "${object.resolves.parameter}" is not a parameter of ${target.procedure}`;
      if (!/IDs?$/.test(parameter.name)) return `resolves.parameter "${parameter.name}" is not an ID/IDs parameter`;
      break;
    }
    default:
      return null;
  }
  // query, query-diagram, resolve-query: a single read-only SELECT.
  const problem = checkSelectSql(object.sql);
  if (problem) return `SQL rejected: ${problem}`;
  // SQL is written from a received map: Query SQL after the Query intent's schema fetch, a
  // resolve-query after its intent's Initial procedure (SCHEMA AND SQL RULES).
  const mapIntent = object.action === "resolve-query" ? object.resolves.intent : "Query";
  const map = usesFileContract(context) ? undefined : initialProcedureOf(metadata, mapIntent);
  if (map && !(context.receivedProcedures ?? new Set()).has(map.procedure.toLowerCase())) {
    return `SQL can't be written before the ${mapIntent} map (${map.procedure}) has been received; request it first`;
  }
  return context.checkSql?.(object.sql) ?? null;
}

/** "the query below" / "کوئری زیر": text that presents a query which must then be in the array. */
const ANNOUNCES_QUERY = /(کوئری|پرس[‌\s]?و[‌\s]?جو)(ی)?[‌\s]+(زیر|ذیل)|(query|sql)\s+below|following\s+(query|sql)/i;

/**
 * File mode: an "answer" that presents "the query below" while the array has no "query" object is a
 * data request answered with a description only (the SQL never comes). Rejected so the retry returns the query.
 */
function announcedMissingQuery(response: ErpResponse): string | null {
  if (response.some((o) => o.action === "query" || o.action === "query-diagram")) return null;
  const index = response.findIndex(
    (o) => o.action === "answer" && o.content_blocks.some((b) => ANNOUNCES_QUERY.test(b.type === "list" ? b.items.join(" ") : b.text)),
  );
  return index < 0
    ? null
    : `[${index}] answer: it presents a query ("the query below") but the array has no "query" object. ` +
        `A data request gets exactly one "query" object with the complete SELECT in sql, and no "answer" object.`;
}

export type TurnValidation ={ ok: true; response: ErpResponse } | { ok: false; reason: string; sqlProblem?: string };

/** Validates a complete model output: JSON array → contract → metadata, workflow and SQL rules. */
export function validateErpTurn(raw: string, metadata: ErpMetadata, context: TurnContext = {}): TurnValidation {
  const { checkSql } = context;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: `not valid JSON: ${raw.slice(0, 200)}` };
  }
  const read = readErpResponse(parsed);
  if (!read.ok) return { ok: false, reason: read.reason };
  for (const [i, object] of read.value.entries()) {
    const groundingProblem = { value: null as string | null };
    const problem = checkObject(object, read.value, metadata, { ...context, checkSql: checkSql && ((sql) => (groundingProblem.value = checkSql(sql))) });
    if (problem) {
      return { ok: false, reason: `[${i}] ${object.action}: ${problem}`, ...(groundingProblem.value && { sqlProblem: groundingProblem.value }) };
    }
  }
  if (usesFileContract(context)) {
    const announced = announcedMissingQuery(read.value);
    if (announced) return { ok: false, reason: announced };
  }
  // Hybrid: an analysis of returned rows may state only what the rows support.
  if (context.checkAnswer) {
    for (const [i, object] of read.value.entries()) {
      if (object.action !== "answer") continue;
      const problem = context.checkAnswer(object.content_blocks.map((b) => (b.type === "list" ? b.items.join(" ") : b.text)).join("\n"));
      if (problem) return { ok: false, reason: `[${i}] answer: ${problem}. State only values from the returned rows (or their totals and ratios).` };
    }
  }
  return { ok: true, response: read.value };
}
