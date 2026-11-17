import type { ParsedSchema, SchemaTable } from "@/types/schema";
import { tableKey } from "./parse";

/*
 * Checks a generated T-SQL query against the uploaded schema without executing it.
 *
 * The query is tokenized (strings, comments, [quoted] identifiers handled properly), then:
 *  - it must be one read-only statement starting with SELECT or WITH (no INTO, DML, DDL, EXEC);
 *  - every table in FROM/JOIN must exist in the schema (or be a CTE / derived table);
 *  - every alias.column / table.column reference must name a declared column; for tables that
 *    are only referenced by foreign keys (columns unknown), only those key columns are allowed;
 *    a CTE or derived table has the columns its select list names;
 *  - unqualified column names must exist in one of the referenced tables (skipped only when a
 *    CTE or derived table selects * and so has unknown columns);
 *  - every column-to-column equality in a JOIN's ON clause must match a declared foreign key;
 *  - optionally, a text literal compared with a category column must be a value the user gave.
 *
 * Every column and join problem is reported, not only the first, so one correction can fix them all.
 * This is structural validation, not a full T-SQL parser: it does not check types, GROUP BY
 * rules, column scoping inside nested subqueries, or comma joins / CROSS APPLY (rejected).
 */

export type TokenKind = "word" | "ident" | "string" | "number" | "symbol" | "variable";
export interface Token {
  kind: TokenKind;
  value: string;
  upper: string;
}

export function tokenize(sql: string): Token[] | string {
  const tokens: Token[] = [];
  const push = (kind: TokenKind, value: string) => tokens.push({ kind, value, upper: value.toUpperCase() });
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];
    if (/\s/.test(c)) {
      i++;
    } else if (c === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      i = end < 0 ? sql.length : end + 1;
    } else if (c === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      if (end < 0) return "Unterminated /* comment.";
      i = end + 2;
    } else if (c === "'" || ((c === "N" || c === "n") && next === "'")) {
      let j = c === "'" ? i + 1 : i + 2;
      let value = "";
      for (;;) {
        if (j >= sql.length) return "Unterminated string literal.";
        if (sql[j] === "'" && sql[j + 1] === "'") {
          value += "'";
          j += 2;
        } else if (sql[j] === "'") {
          break;
        } else {
          value += sql[j++];
        }
      }
      push("string", value);
      i = j + 1;
    } else if (c === "[" || c === '"') {
      const close = c === "[" ? "]" : '"';
      let j = i + 1;
      let value = "";
      for (;;) {
        if (j >= sql.length) return `Unterminated ${c} identifier.`;
        if (sql[j] === close && sql[j + 1] === close) {
          value += close;
          j += 2;
        } else if (sql[j] === close) {
          break;
        } else {
          value += sql[j++];
        }
      }
      push("ident", value);
      i = j + 1;
    } else if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(next ?? ""))) {
      const match = /^[0-9]*\.?[0-9]+(?:[eE][+-]?[0-9]+)?/.exec(sql.slice(i))!;
      push("number", match[0]);
      i += match[0].length;
    } else if (/[A-Za-z_@#\p{L}]/u.test(c)) {
      const match = /^[@#]*[\p{L}\p{N}_@#$]+/u.exec(sql.slice(i))!;
      push(match[0].startsWith("@") ? "variable" : "word", match[0]);
      i += match[0].length;
    } else {
      const two = sql.slice(i, i + 2);
      if (["<=", ">=", "<>", "!=", "!<", "!>"].includes(two)) {
        push("symbol", two);
        i += 2;
      } else {
        push("symbol", c);
        i++;
      }
    }
  }
  return tokens;
}

const WRITE_WORDS = new Set(
  "INSERT UPDATE DELETE MERGE DROP ALTER CREATE TRUNCATE EXEC EXECUTE GRANT REVOKE DENY BACKUP RESTORE DBCC BULK RECONFIGURE SHUTDOWN KILL OPENROWSET OPENDATASOURCE OPENQUERY OPENXML INTO DECLARE SET USE WAITFOR".split(" "),
);

/** Reserved words that can't be a table alias. */
const RESERVED = new Set(
  (
    "SELECT DISTINCT TOP PERCENT WITH TIES FROM WHERE AND OR NOT IN IS NULL LIKE BETWEEN EXISTS ANY ALL SOME AS ON JOIN INNER LEFT RIGHT FULL OUTER CROSS APPLY " +
    "GROUP BY HAVING ORDER ASC DESC OFFSET FETCH NEXT FIRST ROWS ROW ONLY UNION EXCEPT INTERSECT CASE WHEN THEN ELSE END OVER PARTITION RANGE UNBOUNDED PRECEDING FOLLOWING CURRENT " +
    "COLLATE ESCAPE NOLOCK READUNCOMMITTED HOLDLOCK TRUE FALSE"
  ).split(" "),
);

/** Words that are never column references: reserved words, CAST target types and DATEPART names. */
const KEYWORDS = new Set([
  ...RESERVED,
  ...(
    // CAST/CONVERT target types
    "INT BIGINT SMALLINT TINYINT BIT DECIMAL NUMERIC MONEY SMALLMONEY FLOAT REAL DATE DATETIME DATETIME2 SMALLDATETIME TIME DATETIMEOFFSET CHAR VARCHAR NCHAR NVARCHAR TEXT NTEXT BINARY VARBINARY UNIQUEIDENTIFIER XML MAX " +
    // DATEADD/DATEPART/DATEDIFF part names
    "YEAR YY YYYY QUARTER QQ Q MONTH MM M DAYOFYEAR DY Y DAY DD D WEEK WK WW WEEKDAY DW W HOUR HH MINUTE MI N SECOND SS S MILLISECOND MS ISO_WEEK ISOWK ISOWW"
  ).split(" "),
]);

/** Clause words that end a FROM list or an ON condition. */
const CLAUSE_END = new Set("JOIN INNER LEFT RIGHT FULL CROSS OUTER WHERE GROUP ORDER HAVING UNION EXCEPT INTERSECT ON OPTION FOR".split(" "));

type Ref =
  | { kind: "table"; table: SchemaTable }
  | { kind: "external"; name: string; columns: Set<string> }
  /** CTE or derived table whose select list names its columns (upper case). */
  | { kind: "derived"; name: string; columns: Set<string> }
  | { kind: "opaque" }; // CTE or derived table selecting *: columns unknown

interface Name {
  parts: Token[];
  /** Index after the name. */
  end: number;
  star: boolean;
}

/** Reads a dotted name (a.b.c, [a].[b], a.*) starting at index i, or null. */
function readName(tokens: Token[], i: number): Name | null {
  const isPart = (t?: Token) => t && (t.kind === "word" || t.kind === "ident");
  if (!isPart(tokens[i])) return null;
  const parts = [tokens[i]];
  let j = i + 1;
  while (tokens[j]?.value === "." && (isPart(tokens[j + 1]) || tokens[j + 1]?.value === "*")) {
    if (tokens[j + 1].value === "*") return { parts, end: j + 2, star: true };
    parts.push(tokens[j + 1]);
    j += 2;
  }
  return { parts, end: j, star: false };
}

function closingParen(tokens: Token[], open: number): number {
  let depth = 0;
  for (let i = open; i < tokens.length; i++) {
    if (tokens[i].value === "(") depth++;
    else if (tokens[i].value === ")" && --depth === 0) return i;
  }
  return tokens.length;
}

/**
 * The column names a SELECT (tokens[start, end)) produces: aliases (AS x, bare x, x = expr) and plain
 * column references; null when it selects * (columns unknown). Only the first SELECT of a UNION counts.
 */
function selectOutputColumns(tokens: Token[], start: number, end: number): Set<string> | null {
  let i = start;
  while (i < end && tokens[i].upper !== "SELECT") i = tokens[i].value === "(" ? closingParen(tokens, i) + 1 : i + 1;
  if (i >= end) return null;
  i++;
  if (tokens[i]?.upper === "DISTINCT" || tokens[i]?.upper === "ALL") i++;
  if (tokens[i]?.upper === "TOP") {
    i += tokens[i + 1]?.value === "(" ? closingParen(tokens, i + 1) - i + 1 : 2;
    if (tokens[i]?.upper === "PERCENT") i++;
    if (tokens[i]?.upper === "WITH" && tokens[i + 1]?.upper === "TIES") i += 2;
  }
  const items: Token[][] = [];
  let item: Token[] = [];
  for (; i < end; i++) {
    const t = tokens[i];
    if (t.value === "(") {
      const close = closingParen(tokens, i);
      item.push(...tokens.slice(i, close + 1));
      i = close;
      continue;
    }
    if (t.upper === "FROM" || t.upper === "UNION" || t.upper === "EXCEPT" || t.upper === "INTERSECT") break;
    if (t.value === ",") {
      items.push(item);
      item = [];
    } else item.push(t);
  }
  items.push(item);
  const columns = new Set<string>();
  const isName = (t?: Token) => !!t && (t.kind === "ident" || (t.kind === "word" && !KEYWORDS.has(t.upper)));
  for (const parts of items) {
    if (!parts.length) continue;
    const last = parts.at(-1)!;
    if (last.value === "*") return null;
    if (parts.length >= 3 && isName(parts[0]) && parts[1].value === "=") columns.add(parts[0].upper);
    else if (isName(last)) columns.add(last.upper);
  }
  return columns;
}

/** Text category (lookup) columns of ERP metadata: *Type / *TypeL, stored as text; their values are not documented. */
const isCategoryColumn = (column: { name: string; type: string | null }) => /Type(L)?$/.test(column.name) && /char|text/i.test(column.type ?? "");

/**
 * ERP metadata documents (src/lib/erp-metadata) describe one more kind of join besides foreign keys:
 * the GLOBAL ENTITY KEY. A join to the registry view must use its key formula
 *   view.ID = CAST(<FT> AS bigint) * <multiplier> + <table>.ID
 * with the FT of a participating table (rules R1, R2, R5), and a polymorphic <polymorphicColumn>
 * pointer is followed with % / range arithmetic on the multiplier (R3).
 */
export interface KeyFormulaRules {
  view: string;
  multiplier: string;
  polymorphicColumn?: string;
  /** FormTypeID by lower-case table name, for tables that have registry rows (FT tag, PK named ID). */
  formTypes: Map<string, number>;
}

const ARITHMETIC = new Set(["+", "-", "*", "/", "%"]);

/** Returns null when the query is valid for the schema, otherwise the reason it isn't. */
export function validateSqlAgainstSchema(
  sql: string,
  schema: ParsedSchema,
  options: {
    keyRules?: KeyFormulaRules | null;
    /** ERP metadata: table → column → owner table that physically stores an inherited column. */
    inherited?: Map<string, Map<string, string>>;
    /**
     * When set, a text literal compared with a category column (*Type / *TypeL text: its stored
     * values are not documented) must be a value the user gave; this says whether one is.
     */
    isUserValue?: (literal: string, column: string, caption?: string) => boolean;
    /**
     * Filled with what the query reads: schema-qualified table → upper-case columns referenced on it
     * (tables only referenced, e.g. COUNT(*), get an empty set). For checks before execution.
     */
    usage?: Map<string, Set<string>>;
  } = {},
): string | null {
  // Column, join and value problems are collected (deduplicated); structural ones return at once.
  const problems: string[] = [];
  const report = (problem: string) => {
    if (!problems.includes(problem)) problems.push(problem);
  };
  const recordRead = (ref: Ref, column?: string) => {
    if (!options.usage || (ref.kind !== "table" && ref.kind !== "external")) return;
    const name = ref.kind === "table" ? ref.table.name : ref.name;
    const columns = options.usage.get(name) ?? new Set<string>();
    if (column) columns.add(column.toUpperCase());
    options.usage.set(name, columns);
  };
  const tokenized = tokenize(sql);
  if (typeof tokenized === "string") return tokenized;
  const tokens = tokenized;
  while (tokens.at(-1)?.value === ";") tokens.pop();
  if (tokens.length === 0) return "The query is empty.";
  if (tokens.some((t) => t.value === ";")) return "Only a single SQL statement is allowed.";
  if (tokens[0].upper !== "SELECT" && tokens[0].upper !== "WITH") return "The query must start with SELECT or WITH.";
  for (const t of tokens) {
    if (t.kind !== "word") continue;
    if (WRITE_WORDS.has(t.upper)) return `"${t.value}" is not allowed in a read-only query.`;
    if (/^(SP|XP)_/.test(t.upper)) return `Stored procedure "${t.value}" is not allowed.`;
  }

  const tables = new Map(schema.tables.map((t) => [tableKey(t.name), t]));
  const externalColumns = new Map<string, Set<string>>();
  for (const fk of schema.foreignKeys) {
    if (tables.has(tableKey(fk.refTable))) continue;
    const set = externalColumns.get(tableKey(fk.refTable)) ?? new Set<string>();
    fk.refColumns.forEach((c) => set.add(c.toUpperCase()));
    externalColumns.set(tableKey(fk.refTable), set);
  }
  const consumed = new Set<number>();
  const mark = (from: number, to: number) => {
    for (let k = from; k < to; k++) consumed.add(k);
  };

  // CTE names: WITH name [(cols)] AS ( ... ) [, name ...], each with the columns it produces.
  const ctes = new Map<string, Ref>();
  if (tokens[0].upper === "WITH") {
    let i = 1;
    for (;;) {
      const name = readName(tokens, i);
      if (!name || name.parts.length !== 1) return "Could not read the WITH clause.";
      let j = name.end;
      let declared: Set<string> | null = null;
      if (tokens[j]?.value === "(") {
        const close = closingParen(tokens, j);
        declared = new Set(tokens.slice(j + 1, close).filter((t) => t.kind === "word" || t.kind === "ident").map((t) => t.upper));
        j = close + 1;
      }
      mark(i, j);
      if (tokens[j]?.upper !== "AS" || tokens[j + 1]?.value !== "(") return "Could not read the WITH clause.";
      const close = closingParen(tokens, j + 1);
      const columns = declared ?? selectOutputColumns(tokens, j + 2, close);
      ctes.set(name.parts[0].upper, columns ? { kind: "derived", name: name.parts[0].value, columns } : { kind: "opaque" });
      i = close + 1;
      if (tokens[i]?.value !== ",") break;
      i++;
    }
  }

  const resolveTable = (parts: Token[]): Ref | string => {
    const names = parts.map((p) => p.value);
    if (names.length === 1 && ctes.has(parts[0].upper)) return ctes.get(parts[0].upper)!;
    const qualified = names.length >= 2 ? names.slice(-2).join(".") : null;
    if (names.length > 3) return `Unsupported table name "${names.join(".")}".`;
    if (qualified) {
      const table = tables.get(tableKey(qualified));
      if (table) return { kind: "table", table };
      const external = externalColumns.get(tableKey(qualified));
      if (external) return { kind: "external", name: qualified, columns: external };
      return `Table "${qualified}" is not in the database schema.`;
    }
    const byShortName = schema.tables.filter((t) => t.name.split(".")[1].toLowerCase() === names[0].toLowerCase());
    if (byShortName.length === 1) return { kind: "table", table: byShortName[0] };
    return `Table "${names[0]}" is not in the database schema (use the schema-qualified name).`;
  };

  // Table references in FROM / JOIN, with aliases.
  const aliases = new Map<string, Ref>();
  const joins: { index: number; ref: Ref; alias: string }[] = [];
  const addAlias = (key: string, ref: Ref) => aliases.set(key.toUpperCase(), ref);
  const readRef = (i: number): { end: number; ref: Ref; alias: string } | string => {
    let ref: Ref;
    let j: number;
    let alias = "";
    if (tokens[i]?.value === "(") {
      const close = closingParen(tokens, i);
      j = close + 1;
      const columns = selectOutputColumns(tokens, i + 1, close);
      ref = columns ? { kind: "derived", name: "derived table", columns } : { kind: "opaque" };
    } else {
      const name = readName(tokens, i);
      if (!name || name.star) return "Could not read a table name after FROM/JOIN.";
      if (tokens[name.end]?.value === "(") return `Table-valued function "${name.parts.map((p) => p.value).join(".")}" is not supported.`;
      const resolved = resolveTable(name.parts);
      if (typeof resolved === "string") return resolved;
      ref = resolved;
      j = name.end;
      mark(i, j);
      // The table name itself can qualify columns: tblEmployee.ID, gnd_hrprs.tblEmployee.ID
      addAlias(name.parts.at(-1)!.value, ref);
      if (ref.kind === "table" || ref.kind === "external") recordRead(ref);
      if (name.parts.length >= 2) addAlias(name.parts.slice(-2).map((p) => p.value).join("."), ref);
      alias = name.parts.at(-1)!.value;
    }
    if (tokens[j]?.upper === "AS") {
      mark(j, j + 1);
      j++;
    }
    const candidate = tokens[j];
    if (candidate && (candidate.kind === "ident" || (candidate.kind === "word" && !RESERVED.has(candidate.upper) && !CLAUSE_END.has(candidate.upper)))) {
      alias = candidate.value;
      if (ref.kind === "derived" && tokens[i]?.value === "(") ref.name = `derived table ${alias}`;
      addAlias(alias, ref);
      mark(j, j + 1);
      j++;
    }
    // Table hints: WITH (NOLOCK)
    if (tokens[j]?.upper === "WITH" && tokens[j + 1]?.value === "(") {
      const end = closingParen(tokens, j + 1) + 1;
      mark(j, end);
      j = end;
    }
    return { end: j, ref, alias };
  };

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind !== "word") continue;
    if (t.upper === "APPLY") return "CROSS/OUTER APPLY is not supported; use JOIN ... ON with a declared foreign key.";
    if (t.upper === "CROSS" && tokens[i + 1]?.upper === "JOIN") return "CROSS JOIN is not allowed; join on a declared foreign key.";
    if (t.upper !== "FROM" && t.upper !== "JOIN") continue;
    // FROM inside DATEPART/EXTRACT-like functions doesn't occur in T-SQL; TRIM(... FROM ...) is the exception.
    if (t.upper === "FROM" && tokens[i - 1]?.kind === "string") continue;
    const ref = readRef(i + 1);
    if (typeof ref === "string") return ref;
    if (t.upper === "JOIN") joins.push({ index: i, ref: ref.ref, alias: ref.alias });
    // A derived table's own FROM/JOIN clauses come next; anything else continues after the reference.
    i = tokens[i + 1]?.value === "(" ? i + 1 : ref.end - 1;
    if (t.upper === "FROM" && tokens[ref.end]?.value === ",") {
      return "Comma-separated tables are not allowed; use JOIN ... ON with a declared foreign key.";
    }
  }

  // Column aliases (AS name, name = expr, or a bare alias right after an expression) are not columns.
  const columnAliases = new Set<string>();
  const isName = (t?: Token) => !!t && (t.kind === "ident" || (t.kind === "word" && !KEYWORDS.has(t.upper) && !CLAUSE_END.has(t.upper)));
  const endsExpression = (k: number) => {
    const t = tokens[k];
    return !!t && (t.value === ")" || t.kind === "string" || t.kind === "number" || isName(t));
  };
  const endsSelectItem = (t?: Token) => !t || t.value === "," || t.value === ")" || t.upper === "FROM";
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.upper === "COLLATE") mark(i + 1, i + 2);
    if (consumed.has(i)) continue;
    if (t.upper === "AS" && isName(tokens[i + 1])) {
      columnAliases.add(tokens[i + 1].upper);
      mark(i + 1, i + 2);
    } else if (isName(t) && tokens[i + 1]?.value === "=" && (tokens[i - 1]?.upper === "SELECT" || tokens[i - 1]?.value === ",")) {
      columnAliases.add(t.upper);
      mark(i, i + 1);
    } else if (isName(t) && i > 0 && !consumed.has(i - 1) && endsExpression(i - 1) && endsSelectItem(tokens[i + 1]) && tokens[i - 1].value !== ".") {
      columnAliases.add(t.upper);
      mark(i, i + 1);
    }
  }

  const refs = [...new Set(aliases.values())];
  const hasOpaque = refs.some((r) => r.kind === "opaque");
  const describe = (ref: Ref) => (ref.kind === "table" ? ref.table.name : ref.kind === "external" || ref.kind === "derived" ? ref.name : "derived table");
  // An inherited column is not a column of the inheriting table: say where it is stored and how to reach it.
  const ownerOf = (ref: Ref, column: string) =>
    ref.kind === "table" ? options.inherited?.get(tableKey(ref.table.name))?.get(column.toUpperCase()) : undefined;
  const inheritedMessage = (ref: Ref, column: string, qualifier: string) => {
    const owner = ownerOf(ref, column);
    if (!owner || ref.kind !== "table") return null;
    return (
      `Column "${column}" is not stored in ${ref.table.name}: it is inherited from ${owner} (IS-A, same ID). ` +
      `Join that table and read the column there, e.g. INNER JOIN ${owner} AS o ON o.ID = ${qualifier}.ID, then o.${column}.`
    );
  };
  const hasColumn = (ref: Ref, column: string) =>
    ref.kind === "opaque" ||
    (ref.kind === "external" || ref.kind === "derived"
      ? ref.columns.has(column.toUpperCase())
      : ref.table.columns.some((c) => c.name.toUpperCase() === column.toUpperCase()));
  /** The declared column a reference resolves to, when it is a column of a schema table. */
  const tableColumnOf = (ref: Ref | undefined, column: string) =>
    ref?.kind === "table" ? { table: ref.table, column: ref.table.columns.find((c) => c.name.toUpperCase() === column.toUpperCase()) } : undefined;
  const columnRefs: { index: number; end: number; resolved?: { table: SchemaTable; column?: SchemaTable["columns"][number] } }[] = [];

  // Column references.
  for (let i = 0; i < tokens.length; i++) {
    if (consumed.has(i)) continue;
    const name = readName(tokens, i);
    if (!name) continue;
    const end = name.end;
    const isCall = tokens[end]?.value === "(";
    const parts = name.parts;
    if (isCall || (parts.length === 1 && !name.star && (KEYWORDS.has(parts[0].upper) || CLAUSE_END.has(parts[0].upper)))) {
      i = end - 1;
      continue;
    }
    if (parts.length >= 2 || name.star) {
      const qualifierParts = name.star ? parts : parts.slice(0, -1);
      const qualifier = qualifierParts.map((p) => p.value).join(".");
      const ref = aliases.get(qualifier.toUpperCase()) ?? (qualifierParts.length >= 2 ? aliases.get(qualifierParts.slice(-2).map((p) => p.value).join(".").toUpperCase()) : undefined);
      if (!ref) {
        report(`"${qualifier}" is not a table or alias in this query.`);
      } else if (!name.star) {
        const column = parts.at(-1)!.value;
        if (!hasColumn(ref, column)) {
          report(
            inheritedMessage(ref, column, qualifier) ??
              (ref.kind === "external"
                ? `Column "${column}" of ${ref.name} is unknown: that table is only referenced by foreign keys in the metadata, so only ${[...ref.columns].join(", ")} of it is documented.`
                : `Column "${column}" does not exist in ${describe(ref)}.`),
          );
        } else {
          columnRefs.push({ index: i, end, resolved: tableColumnOf(ref, column) });
          recordRead(ref, column);
        }
      }
    } else {
      const word = parts[0];
      const isNameLike = word.kind === "ident" || word.kind === "word";
      const known =
        columnAliases.has(word.upper) || aliases.has(word.upper) || ctes.has(word.upper) || refs.some((ref) => hasColumn(ref, word.value));
      if (isNameLike && !known && !hasOpaque) {
        const inheritedRef = refs.find((ref) => ownerOf(ref, word.value));
        report(
          inheritedRef
            ? inheritedMessage(inheritedRef, word.value, inheritedRef.kind === "table" ? inheritedRef.table.name : "t")!
            : refs.length === 1
              ? `Column "${word.value}" does not exist in ${describe(refs[0])}.`
              : `Column "${word.value}" does not exist in any table of the query.`,
        );
      } else if (isNameLike && !columnAliases.has(word.upper)) {
        // Every table that has a column of this name may be the one read (checked live for each).
        for (const ref of refs) if ((ref.kind === "table" || ref.kind === "external") && hasColumn(ref, word.value)) recordRead(ref, word.value);
        // Unqualified: resolved when every table that has the column is the same table (e.g. a derived
        // table over the same table as the outer query).
        const owners = refs.filter((ref) => ref.kind === "table" && hasColumn(ref, word.value));
        if (owners.length && owners.every((ref) => ref.kind === "table" && owners[0].kind === "table" && ref.table === owners[0].table)) {
          columnRefs.push({ index: i, end, resolved: tableColumnOf(owners[0], word.value) });
        }
      }
    }
    i = end - 1;
  }

  // Category columns: their stored values are not documented, so a compared value must come from the user.
  if (options.isUserValue) {
    const comparisons = new Set(["=", "<>", "!="]);
    const literalsAfter = (k: number): string[] => {
      const t = tokens[k];
      if (comparisons.has(t?.value ?? "") && tokens[k + 1]?.kind === "string") return [tokens[k + 1].value];
      const not = t?.upper === "NOT" ? 1 : 0;
      const op = tokens[k + not];
      if (op?.upper === "LIKE" && tokens[k + not + 1]?.kind === "string") return [tokens[k + not + 1].value.replace(/^[%_]+|[%_]+$/g, "")];
      if (op?.upper === "IN" && tokens[k + not + 1]?.value === "(") {
        const close = closingParen(tokens, k + not + 1);
        return tokens.slice(k + not + 2, close).filter((x) => x.kind === "string").map((x) => x.value);
      }
      return [];
    };
    for (const ref of columnRefs) {
      const column = ref.resolved?.column;
      if (!column || !isCategoryColumn(column)) continue;
      const values = [...literalsAfter(ref.end)];
      if (comparisons.has(tokens[ref.index - 1]?.value ?? "") && tokens[ref.index - 2]?.kind === "string") values.push(tokens[ref.index - 2].value);
      if (tokens[ref.index - 1]?.upper === "CASE") {
        for (let k = ref.end, depth = 0; k < tokens.length; k++) {
          if (tokens[k].upper === "CASE") depth++;
          if (tokens[k].upper === "END" && depth-- === 0) break;
          if (depth === 0 && tokens[k].upper === "WHEN" && tokens[k + 1]?.kind === "string") values.push(tokens[k + 1].value);
        }
      }
      for (const value of values) {
        if (!value.trim() || options.isUserValue(value, column.name, column.caption)) continue;
        report(
          `${ref.resolved!.table.name}.${column.name} is a category column whose stored values are not documented in the metadata, ` +
            `and the value N'${value}' was not given by the user. Do not guess a stored value: return an "ask" that names this column and asks for its exact stored value.`,
        );
      }
    }
  }

  // Every column-to-column equality in an ON clause must be a declared foreign key.
  const isForeignKey = (a: { ref: Ref; column: string }, b: { ref: Ref; column: string }) => {
    const keyOf = (ref: Ref) => (ref.kind === "table" ? tableKey(ref.table.name) : ref.kind === "external" ? tableKey(ref.name) : "");
    const [ka, kb] = [keyOf(a.ref), keyOf(b.ref)];
    return schema.foreignKeys.some((fk) =>
      fk.columns.some((col, i) => {
        const from = { table: tableKey(fk.table), column: col.toUpperCase() };
        const to = { table: tableKey(fk.refTable), column: fk.refColumns[i].toUpperCase() };
        return (
          (from.table === ka && from.column === a.column.toUpperCase() && to.table === kb && to.column === b.column.toUpperCase()) ||
          (from.table === kb && from.column === b.column.toUpperCase() && to.table === ka && to.column === a.column.toUpperCase())
        );
      }),
    );
  };
  /** Both sides are declared non-key columns of the same type (a date or text correlation, not a relationship). */
  const plainCorrelation = (a: { ref: Ref; column: string }, b: { ref: Ref; column: string }) => {
    const plain = (side: { ref: Ref; column: string }) => {
      if (side.ref.kind !== "table") return null;
      const table = side.ref.table;
      const column = table.columns.find((c) => c.name.toUpperCase() === side.column.toUpperCase());
      if (!column || /(ID|IG)$/i.test(column.name) || table.primaryKey.some((pk) => pk.toUpperCase() === column.name.toUpperCase())) return null;
      const inFk = schema.foreignKeys.some(
        (fk) =>
          (tableKey(fk.table) === tableKey(table.name) && fk.columns.some((c) => c.toUpperCase() === column.name.toUpperCase())) ||
          (tableKey(fk.refTable) === tableKey(table.name) && fk.refColumns.some((c) => c.toUpperCase() === column.name.toUpperCase())),
      );
      return inFk ? null : column;
    };
    const [ca, cb] = [plain(a), plain(b)];
    return !!ca && !!cb && !!ca.type && ca.type === cb.type;
  };
  for (const join of joins) {
    let i = join.index + 1;
    while (i < tokens.length && tokens[i].upper !== "ON") {
      if (tokens[i].value === "(") i = closingParen(tokens, i);
      i++;
    }
    if (tokens[i]?.upper !== "ON") {
      report("Every JOIN needs an ON condition on a declared foreign key.");
      continue;
    }
    let depth = 0;
    const condition: Token[] = [];
    for (i = i + 1; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.value === "(") depth++;
      if (t.value === ")" && --depth < 0) break;
      if (depth === 0 && CLAUSE_END.has(t.upper) && t.upper !== "ON") break;
      condition.push(t);
    }
    let foreignKeyPairs = 0;
    let uncheckedPairs = 0;
    const undeclared: { text: string; plain: boolean }[] = [];
    for (let k = 0; k < condition.length; k++) {
      const left = readName(condition, k);
      if (!left || left.parts.length < 2 || condition[left.end]?.value !== "=") continue;
      if (ARITHMETIC.has(condition[k - 1]?.value ?? "")) continue;
      const right = readName(condition, left.end + 1);
      if (!right || right.parts.length < 2 || condition[right.end]?.value === "(") continue;
      if (ARITHMETIC.has(condition[right.end]?.value ?? "")) continue;
      const side = (n: Name) => ({
        ref: aliases.get(n.parts.slice(0, -1).map((p) => p.value).join(".").toUpperCase()),
        column: n.parts.at(-1)!.value,
      });
      const a = side(left);
      const b = side(right);
      if (!a.ref || !b.ref || a.ref === b.ref) continue;
      if (a.ref.kind === "opaque" || b.ref.kind === "opaque" || a.ref.kind === "derived" || b.ref.kind === "derived") {
        // CTE or derived table: its rows come from tables checked on their own; the pairing can't be checked.
        uncheckedPairs++;
        k = right.end - 1;
        continue;
      }
      if (!isForeignKey({ ref: a.ref, column: a.column }, { ref: b.ref, column: b.column })) {
        const text = (n: Name) => n.parts.map((p) => p.value).join(".");
        undeclared.push({ text: `${text(left)} = ${text(right)}`, plain: plainCorrelation({ ref: a.ref, column: a.column }, { ref: b.ref, column: b.column }) });
      } else {
        foreignKeyPairs++;
      }
      k = right.end - 1;
    }
    // Beyond a declared relationship, an ON clause may correlate two plain columns of the same type
    // (sd.Date = cl.DayDate); a key column (PK, FK, *ID, *IG) on either side would be an invented relationship.
    for (const pair of undeclared) {
      uncheckedPairs++;
      if (foreignKeyPairs > 0 && pair.plain) continue;
      report(
        `JOIN condition ${pair.text} is not a declared foreign key, IS-A or entity-tree relationship` +
          (pair.plain ? " (a correlation of plain columns needs a declared relationship in the same JOIN)." : "."),
      );
    }
    const formula = options.keyRules ? checkKeyFormula(condition, join.ref, aliases, options.keyRules) : null;
    if (typeof formula === "string") report(formula);
    else if (foreignKeyPairs === 0 && uncheckedPairs === 0 && join.ref.kind !== "opaque" && join.ref.kind !== "derived" && formula !== true) {
      report(`The JOIN of ${describe(join.ref)} is not on a declared foreign key relationship.`);
    }
  }
  return problems.length ? problems.slice(0, 6).join(" ") : null;
}

/**
 * Checks a JOIN condition against the GLOBAL ENTITY KEY rules. Returns true for a valid key-formula
 * or polymorphic join, a reason for an invalid one, or null when the condition doesn't involve them.
 */
function checkKeyFormula(condition: Token[], joined: Ref, aliases: Map<string, Ref>, rules: KeyFormulaRules): true | string | null {
  const viewKey = tableKey(rules.view);
  const refOf = (n: Name) => aliases.get(n.parts.slice(0, -1).map((p) => p.value).join(".").toUpperCase());
  const keyOf = (ref?: Ref) => (ref?.kind === "table" ? tableKey(ref.table.name) : ref?.kind === "external" ? tableKey(ref.name) : "");
  const names: { ref?: Ref; column: string }[] = [];
  for (let k = 0; k < condition.length; k++) {
    const n = readName(condition, k);
    if (!n || n.parts.length < 2) continue;
    names.push({ ref: refOf(n), column: n.parts.at(-1)!.value });
    k = n.end - 1;
  }
  const involvesView = keyOf(joined) === viewKey || names.some((n) => keyOf(n.ref) === viewKey);
  const multiplier = condition.some((t) => t.kind === "number" && t.value === rules.multiplier);
  const polymorphic = !!rules.polymorphicColumn && names.some((n) => n.column.toUpperCase() === rules.polymorphicColumn!.toUpperCase());

  if (involvesView) {
    if (!multiplier) return `A join to ${rules.view} must use its key formula: ${rules.view}.ID = CAST(<FT> AS bigint) * ${rules.multiplier} + <table>.ID (never the table's ID alone).`;
    if (polymorphic) return true; // view.ID = <table>.<polymorphic column> scaled/compared as documented
    // CAST(<number> AS BIGINT): rule R1, and the FT that must match the other table.
    let ft: number | null = null;
    for (let k = 0; k + 5 < condition.length; k++) {
      if (condition[k].upper === "CAST" && condition[k + 1]?.value === "(" && condition[k + 2]?.kind === "number" && condition[k + 3]?.upper === "AS" && condition[k + 4]?.upper === "BIGINT") {
        ft = Number(condition[k + 2].value);
      }
    }
    if (ft === null) return `The ${rules.view} key formula must cast the FormTypeID to bigint first: CAST(<FT> AS bigint) * ${rules.multiplier} (plain int arithmetic overflows).`;
    const others = names.filter((n) => n.ref && keyOf(n.ref) !== viewKey);
    if (others.length === 0) return `The ${rules.view} join doesn't reference the table whose rows it names.`;
    for (const other of others) {
      const table = keyOf(other.ref);
      const expected = rules.formTypes.get(table);
      if (expected === undefined) return `${table} has no rows in ${rules.view} (it has no FT tag or its primary key is not ID); join through its parent instead.`;
      if (expected !== ft) return `${table} has FT=${expected}, but the ${rules.view} join uses ${ft}.`;
      if (other.column.toUpperCase() !== "ID") return `The ${rules.view} key formula adds the table's ID column, not ${other.column}.`;
    }
    return true;
  }
  // A polymorphic pointer: <target>.ID = <col> % multiplier (the FT part is checked with a range or division).
  if (polymorphic && multiplier) return true;
  return null;
}
