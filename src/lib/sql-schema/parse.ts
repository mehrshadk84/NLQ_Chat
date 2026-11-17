import type { ParsedSchema, SchemaColumn, SchemaForeignKey, SchemaIssue, SchemaSummary, SchemaTable } from "@/types/schema";

/*
 * Deterministic parser for SQL Server schema scripts in the format SSMS "Generate Scripts"
 * produces (the documented input format):
 *
 *   -- 01. gnd_hrprs.tblEmployee: کارمند                       (optional caption comment)
 *   CREATE TABLE [gnd_hrprs].[tblEmployee] (
 *       [ID] [int] IDENTITY(1,1) NOT NULL, -- شناسه | CaptionID=1   (one column per line)
 *       [Total] AS ([dbo].[fn]([ID])) -- مبلغ                        (computed column)
 *   );
 *   ALTER TABLE [s].[t] ADD CONSTRAINT [PK] PRIMARY KEY CLUSTERED ([ID] ASC) ...;
 *   ALTER TABLE [s].[t] WITH CHECK ADD CONSTRAINT [FK] FOREIGN KEY ([A]) REFERENCES [s].[p] ([ID]);
 *
 * Every statement is on one line. UNIQUE, CHECK, DEFAULT constraints, constraint toggles,
 * indexes and GO are recognized and skipped. Free text before the first SQL statement is
 * treated as notes. Any other line is reported as an issue rather than silently ignored, and
 * nothing that isn't explicitly declared (types, nullability, relationships) is inferred.
 */

const ID = String.raw`\[([^\]]+)\]`;
const QUALIFIED = String.raw`${ID}\.${ID}`;
const COLUMN_LIST = String.raw`\(([^)]*)\)`;

const CREATE_TABLE = new RegExp(String.raw`^CREATE TABLE ${QUALIFIED}\s*\($`, "i");
const TABLE_END = /^\);?$/;
const TYPED_COLUMN = new RegExp(String.raw`^${ID}\s+\[([A-Za-z0-9_]+)\](\s*\(\s*(?:max|\d+)(?:\s*,\s*\d+)?\s*\))?(.*)$`, "i");
const COMPUTED_COLUMN = new RegExp(String.raw`^${ID}\s+AS\s+\(.*\)(?:\s+PERSISTED)?(?:\s+NOT NULL)?$`, "i");
const ALTER = String.raw`^ALTER TABLE ${QUALIFIED}`;
const PRIMARY_KEY = new RegExp(String.raw`${ALTER} ADD CONSTRAINT ${ID} PRIMARY KEY(?: CLUSTERED| NONCLUSTERED)? ${COLUMN_LIST}`, "i");
const FOREIGN_KEY = new RegExp(
  String.raw`${ALTER}(?: WITH (?:NO)?CHECK)? ADD CONSTRAINT ${ID} FOREIGN KEY ${COLUMN_LIST} REFERENCES ${QUALIFIED} ${COLUMN_LIST}` +
    String.raw`(?: ON (?:DELETE|UPDATE) (?:CASCADE|NO ACTION|SET NULL|SET DEFAULT))*(?: NOT FOR REPLICATION)?;?$`,
  "i",
);
const SKIPPED_STATEMENTS = [
  new RegExp(String.raw`${ALTER} ADD CONSTRAINT ${ID} UNIQUE(?: CLUSTERED| NONCLUSTERED)? ${COLUMN_LIST}`, "i"),
  new RegExp(String.raw`${ALTER}(?: WITH (?:NO)?CHECK)? ADD CONSTRAINT ${ID} CHECK \(.*\);?$`, "i"),
  new RegExp(String.raw`${ALTER} ADD CONSTRAINT ${ID} DEFAULT .+ FOR ${ID};?$`, "i"),
  new RegExp(String.raw`${ALTER} (?:NO)?CHECK CONSTRAINT ${ID};?$`, "i"),
  new RegExp(String.raw`^CREATE (?:UNIQUE )?(?:CLUSTERED |NONCLUSTERED )?INDEX ${ID} ON ${QUALIFIED} \(`, "i"),
];
const USE_DATABASE = new RegExp(String.raw`^USE ${ID};?$`, "i");
/** Lines that look like SQL: once one appears, unrecognized lines are reported, not treated as notes. */
const SQL_LIKE = /^(CREATE|ALTER|USE|DROP|INSERT|UPDATE|DELETE|MERGE|EXEC|EXECUTE|SET|DECLARE|BEGIN|IF|PRINT|GRANT|TRUNCATE)\b/i;
const CAPTION_COMMENT = /^--\s*\d+\.\s*([\w$#@]+\.[\w$#@]+)\s*:\s*(.+)$/;
const CAPTION_NOTE = /^([\w$#@]+\.[\w$#@]+)\s*:\s*(.+)$/;

export const tableKey = (name: string) => name.toLowerCase();
const qualified = (schema: string, table: string) => `${schema}.${table}`;

/** Splits "a, [b] ASC, [c] DESC" into ["a", "b", "c"]. */
function columnList(list: string): string[] {
  return list
    .split(",")
    .map((part) => part.trim().replace(/\s+(ASC|DESC)$/i, "").replace(/^\[|\]$/g, ""))
    .filter(Boolean);
}

/** Splits a line at a `--` comment that isn't inside brackets or quotes. */
function splitComment(line: string): { code: string; comment?: string } {
  let bracket = false;
  let quote = false;
  for (let i = 0; i < line.length - 1; i++) {
    const c = line[i];
    if (quote) quote = c !== "'";
    else if (bracket) bracket = c !== "]";
    else if (c === "'") quote = true;
    else if (c === "[") bracket = true;
    else if (c === "-" && line[i + 1] === "-") return { code: line.slice(0, i), comment: line.slice(i + 2) };
  }
  return { code: line };
}

/** "کد ملی | CaptionID=30450" -> "کد ملی" */
function captionFrom(comment: string | undefined): string | undefined {
  const caption = comment?.split("|")[0].trim();
  return caption || undefined;
}

/** Parses one column line, or returns null if it isn't a supported column definition. */
function parseColumn(line: string): { column: SchemaColumn; unsupported?: string } | null {
  const { code, comment } = splitComment(line);
  const definition = code.trim().replace(/,$/, "").trim();
  const caption = captionFrom(comment);

  const computed = COMPUTED_COLUMN.exec(definition);
  if (computed) {
    return { column: { name: computed[1], type: null, nullable: null, identity: false, computed: true, caption } };
  }
  const typed = TYPED_COLUMN.exec(definition);
  if (!typed) return null;

  const [, name, baseType, args = "", rest] = typed;
  // Nullability is read before any DEFAULT so a default value can't be mistaken for it.
  const head = rest.split(/\bCONSTRAINT\b|\bDEFAULT\b/i)[0];
  const nullable = /\bNOT\s+NULL\b/i.test(head) ? false : /\bNULL\b/i.test(head) ? true : null;
  const leftover = rest
    .replace(/\bIDENTITY\s*\(\s*-?\d+\s*,\s*-?\d+\s*\)/i, "")
    .replace(/\bCOLLATE\s+\w+/i, "")
    .replace(/\bNOT\s+NULL\b|\bNULL\b/i, "")
    .replace(/\bCONSTRAINT\s+\[[^\]]+\]\s+DEFAULT\s+.*$/i, "")
    .replace(/\bDEFAULT\s+.*$/i, "")
    .replace(/\bSPARSE\b|\bROWGUIDCOL\b/gi, "")
    .trim();
  const column: SchemaColumn = {
    name,
    type: `${baseType.toLowerCase()}${args.replace(/\s+/g, "").toLowerCase()}`,
    nullable,
    identity: /\bIDENTITY\b/i.test(rest),
    computed: false,
    caption,
  };
  return leftover ? { column, unsupported: leftover } : { column };
}

/**
 * Parses a schema script. Returns null when the text contains no CREATE TABLE statement at
 * all, i.e. it isn't a SQL Server schema file.
 */
export function parseSchema(text: string): ParsedSchema | null {
  const lines = text.split(/\r?\n/);
  const issues: SchemaIssue[] = [];
  const tables: SchemaTable[] = [];
  const primaryKeys: { line: number; table: string; columns: string[] }[] = [];
  const foreignKeys: (SchemaForeignKey & { line: number })[] = [];
  const captions = new Map<string, string>();
  let database: string | null = null;
  let current: SchemaTable | null = null;
  let currentStart = 0;
  let inScript = false;

  for (const [index, raw] of lines.entries()) {
    const lineNo = index + 1;
    const line = raw.trim();

    if (current) {
      if (TABLE_END.test(line)) {
        if (current.columns.length === 0) issues.push({ line: currentStart, message: `Table ${current.name} has no columns.` });
        tables.push(current);
        current = null;
        continue;
      }
      if (!line || line.startsWith("--")) continue;
      const parsed = parseColumn(line);
      if (!parsed) {
        issues.push({ line: lineNo, message: `Unsupported line in CREATE TABLE ${current.name}: ${line.slice(0, 120)}` });
      } else {
        current.columns.push(parsed.column);
        if (parsed.unsupported) {
          issues.push({ line: lineNo, message: `Unsupported column syntax in ${current.name}.${parsed.column.name}: ${parsed.unsupported.slice(0, 80)}` });
        }
      }
      continue;
    }

    if (!line || /^GO;?$/i.test(line)) continue;
    if (line.startsWith("--")) {
      const caption = CAPTION_COMMENT.exec(line);
      if (caption) captions.set(tableKey(caption[1]), caption[2].trim());
      continue;
    }

    let match: RegExpExecArray | null;
    if ((match = CREATE_TABLE.exec(line))) {
      inScript = true;
      const name = qualified(match[1], match[2]);
      current = { name, caption: captions.get(tableKey(name)), columns: [], primaryKey: [] };
      currentStart = lineNo;
    } else if ((match = PRIMARY_KEY.exec(line))) {
      inScript = true;
      primaryKeys.push({ line: lineNo, table: qualified(match[1], match[2]), columns: columnList(match[4]) });
    } else if ((match = FOREIGN_KEY.exec(line))) {
      inScript = true;
      foreignKeys.push({
        line: lineNo,
        name: match[3],
        table: qualified(match[1], match[2]),
        columns: columnList(match[4]),
        refTable: qualified(match[5], match[6]),
        refColumns: columnList(match[7]),
      });
    } else if ((match = USE_DATABASE.exec(line))) {
      inScript = true;
      database = match[1];
    } else if (SKIPPED_STATEMENTS.some((pattern) => pattern.test(line))) {
      inScript = true;
    } else if (!inScript && !SQL_LIKE.test(line)) {
      // Free-text notes before the script; "schema.table: caption" lines provide captions.
      const caption = CAPTION_NOTE.exec(line);
      if (caption && !captions.has(tableKey(caption[1]))) captions.set(tableKey(caption[1]), caption[2].trim());
    } else {
      inScript = true;
      issues.push({ line: lineNo, message: `Unsupported statement: ${line.slice(0, 120)}` });
    }
  }
  if (current) issues.push({ line: currentStart, message: `CREATE TABLE ${current.name} is not closed.` });
  if (tables.length === 0) return null;

  // Cross-check keys against the declared tables and columns.
  const byName = new Map<string, SchemaTable>();
  for (const table of tables) {
    if (byName.has(tableKey(table.name))) issues.push({ line: 0, message: `Table ${table.name} is defined more than once.` });
    byName.set(tableKey(table.name), table);
    table.caption ??= captions.get(tableKey(table.name));
  }
  const hasColumns = (table: SchemaTable, columns: string[]) =>
    columns.every((c) => table.columns.some((col) => col.name.toLowerCase() === c.toLowerCase()));

  for (const pk of primaryKeys) {
    const table = byName.get(tableKey(pk.table));
    if (!table) issues.push({ line: pk.line, message: `Primary key on undefined table ${pk.table}.` });
    else if (!hasColumns(table, pk.columns)) issues.push({ line: pk.line, message: `Primary key of ${pk.table} uses undefined columns.` });
    else table.primaryKey = pk.columns;
  }

  const validForeignKeys: SchemaForeignKey[] = [];
  const external = new Set<string>();
  for (const { line, ...fk } of foreignKeys) {
    const table = byName.get(tableKey(fk.table));
    const refTable = byName.get(tableKey(fk.refTable));
    if (!table) {
      issues.push({ line, message: `Foreign key ${fk.name} is on undefined table ${fk.table}.` });
    } else if (!hasColumns(table, fk.columns) || fk.columns.length !== fk.refColumns.length) {
      issues.push({ line, message: `Foreign key ${fk.name} uses undefined columns of ${fk.table}.` });
    } else if (refTable && !hasColumns(refTable, fk.refColumns)) {
      issues.push({ line, message: `Foreign key ${fk.name} references undefined columns of ${fk.refTable}.` });
    } else {
      if (!refTable) external.add(fk.refTable);
      validForeignKeys.push(fk);
    }
  }

  return {
    database,
    tables,
    foreignKeys: validForeignKeys,
    externalTables: [...external].sort(),
    issues,
  };
}

export function summarizeSchema(schema: ParsedSchema): SchemaSummary {
  return {
    tables: schema.tables.length,
    columns: schema.tables.reduce((sum, t) => sum + t.columns.length, 0),
    foreignKeys: schema.foreignKeys.length,
    externalTables: schema.externalTables.length,
    issueCount: schema.issues.length,
    issues: schema.issues.slice(0, 10),
  };
}
