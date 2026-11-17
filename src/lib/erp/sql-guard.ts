import { tokenize, type Token } from "@/lib/sql-schema/validate-sql";

/*
 * Read-only checks for model-generated T-SQL, on tokens (string literals, [quoted] and "quoted"
 * identifiers and comments are handled by the tokenizer, so a column named [Update] or the text
 * N'delete' is not a false positive, and a keyword hidden in a comment is not a false negative).
 *
 * A SELECT must be one statement that starts with SELECT or WITH and uses no statement, function
 * or object that writes, executes code, changes session state, or reaches outside the current
 * database, and calls no user-defined function. This is a deny-by-structure check on tokens, not
 * a full parser; execution adds its own protections (schema validation and the execution policy,
 * a verified least-privilege login, row limit, timeout, and a rolled-back transaction as a last layer).
 */

export const MAX_SQL_LENGTH = 20_000;

/** Words that start or imply anything other than reading. */
const FORBIDDEN_WORDS = new Set(
  (
    "INSERT UPDATE DELETE MERGE DROP ALTER CREATE TRUNCATE EXEC EXECUTE GRANT REVOKE DENY BACKUP RESTORE DBCC BULK RECONFIGURE " +
    "SHUTDOWN KILL OPENROWSET OPENDATASOURCE OPENQUERY OPENXML INTO DECLARE SET USE WAITFOR GOTO BEGIN COMMIT ROLLBACK SAVE " +
    "TRAN TRANSACTION RAISERROR THROW PRINT CHECKPOINT READTEXT WRITETEXT UPDATETEXT LOAD DUMP ENABLE DISABLE REVERT SETUSER " +
    "CURSOR SEND RECEIVE CONVERSATION IF WHILE RETURN BREAK CONTINUE"
  ).split(" "),
);

/** Catalogs whose objects are outside the business schema. */
const FORBIDDEN_SCHEMAS = new Set(["SYS", "INFORMATION_SCHEMA", "MASTER", "MSDB", "TEMPDB", "MODEL"]);

const isName = (t: Token | undefined) => t !== undefined && (t.kind === "word" || t.kind === "ident");

/** Returns why the SQL is not an acceptable read-only SELECT, or null when it is. */
export function checkSelectSql(sql: string): string | null {
  if (!sql.trim()) return "empty SQL";
  if (sql.length > MAX_SQL_LENGTH) return "SQL is too long";
  const tokens = tokenize(sql);
  if (typeof tokens === "string") return tokens;

  // One statement: a single trailing semicolon is the only one allowed.
  const body = tokens.at(-1)?.value === ";" ? tokens.slice(0, -1) : tokens;
  if (body.length === 0) return "empty SQL";
  if (body.some((t) => t.kind === "symbol" && t.value === ";")) return "more than one statement";
  if (body[0].kind !== "word" || (body[0].upper !== "SELECT" && body[0].upper !== "WITH")) return "must start with SELECT or WITH";
  if (!body.some((t) => t.kind === "word" && t.upper === "SELECT")) return "no SELECT";

  for (let i = 0; i < body.length; i++) {
    const t = body[i];
    if (t.kind === "variable") return `variables and system functions are not allowed (${t.value.slice(0, 40)})`;
    if (t.kind !== "word") continue;
    if (t.value.startsWith("#")) return "temporary tables are not allowed";
    if (FORBIDDEN_WORDS.has(t.upper)) return `"${t.upper}" is not allowed in a read-only query`;
    if (/^(SP|XP)_/.test(t.upper)) return `system procedures are not allowed (${t.value.slice(0, 40)})`;
    // NEXT VALUE FOR increments a sequence.
    if (t.upper === "NEXT" && body[i + 1]?.upper === "VALUE") return "NEXT VALUE FOR is not allowed";
  }

  // T-SQL needs no semicolon between statements: a second top-level SELECT that doesn't follow
  // UNION/EXCEPT/INTERSECT starts another statement.
  let depth = 0;
  let topLevelSelects = 0;
  for (let i = 0; i < body.length; i++) {
    const t = body[i];
    if (t.value === "(") depth++;
    else if (t.value === ")") depth--;
    else if (depth === 0 && t.kind === "word" && t.upper === "SELECT") {
      const before = body[i - 1]?.upper === "ALL" ? body[i - 2]?.upper : body[i - 1]?.upper;
      if (before !== "UNION" && before !== "EXCEPT" && before !== "INTERSECT" && ++topLevelSelects > 1) return "more than one statement";
    }
    if (depth < 0) return "unbalanced parentheses";
  }
  if (depth !== 0) return "unbalanced parentheses";

  // Object names: no catalogs, no other databases or linked servers.
  for (let i = 0; i < body.length; i++) {
    if (!isName(body[i]) || (i > 0 && body[i - 1].value === ".")) continue;
    const parts = [body[i]];
    let j = i;
    let emptyPart = false;
    while (body[j + 1]?.value === ".") {
      const next = body[j + 2];
      if (next?.value === "*") break; // alias.*
      if (!isName(next)) {
        emptyPart = true; // db..table
        break;
      }
      j += 2;
      parts.push(next);
    }
    if (emptyPart) return "cross-database references are not allowed";
    if (parts.length >= 4) return "linked-server or cross-database references are not allowed";
    // schema.function(...): user-defined (scalar or table-valued) functions run code the policy can't
    // see (CLR functions can have side effects); only built-in functions are allowed.
    if (parts.length >= 2 && body[j + 1]?.value === "(") return `user-defined functions are not allowed (${parts.map((p) => p.value).join(".").slice(0, 80)})`;
    if (parts.length >= 2 && FORBIDDEN_SCHEMAS.has(parts[0].upper)) return `system catalog "${parts[0].value}" is not allowed`;
    // After FROM/JOIN/APPLY a three-part name is database.schema.object.
    const before = body[i - 1]?.upper;
    if (parts.length === 3 && (before === "FROM" || before === "JOIN" || before === "APPLY")) return "cross-database references are not allowed";
    i = j;
  }
  return null;
}

/**
 * The display-only "EXEC schema.procedure @P = value, ..." companion of a final answer (FLOW step 8).
 * Returns the procedure name when the text has that shape, or null. It is never executed.
 */
export function parseExecCompanion(sql: string): string | null {
  const tokens = tokenize(sql);
  if (typeof tokens === "string" || tokens.length < 4) return null;
  const body = tokens.at(-1)?.value === ";" ? tokens.slice(0, -1) : tokens;
  if (body[0].upper !== "EXEC" && body[0].upper !== "EXECUTE") return null;
  if (!isName(body[1]) || body[2]?.value !== "." || !isName(body[3])) return null;
  if (body.some((t) => t.value === ";")) return null;
  // Only "@Param = literal" pairs separated by commas.
  for (let i = 4; i < body.length; i += 4) {
    if (body[i].kind !== "variable" || body[i + 1]?.value !== "=") return null;
    const value = body[i + 2];
    if (!value || !(value.kind === "string" || value.kind === "number" || value.upper === "NULL" || (value.value === "-" && body[i + 3]?.kind === "number"))) return null;
    if (value.value === "-") i++;
    if (body[i + 3] !== undefined && body[i + 3].value !== ",") return null;
  }
  return `${body[1].value}.${body[3].value}`;
}
