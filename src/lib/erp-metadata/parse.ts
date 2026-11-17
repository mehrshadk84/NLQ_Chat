/*
 * Parser for the GreenXERP AI metadata document ("ai-table-list.txt"): sections NOTATION, GLOBAL
 * ENTITY KEY, DOMAINS, SUBSYSTEMS, ENTITY TREE and SCHEMA. The format and its semantics are the ones
 * the document states in its own NOTATION and GLOBAL ENTITY KEY sections:
 *
 *   TABLE <schema.table> [<Persian name>] FT=<FormTypeID> IS-A <parent table> rows=<approx. count>
 *     <col>:<type>[?] [PK] [IDENTITY] ["<Persian meaning>"] [@<owner table>]
 *     FK: <col>-><schema.table>.<col>; ...
 *
 * "?" = nullable; "@owner" = the column is inherited and physically lives in that ancestor table;
 * IS-A / "^" = the table's PK is also an FK to the parent's PK. ENTITY TREE lines "E <FT> <table>
 * [name]" are business entities; indented "> <child> (<FKcol>)" lines are child tables whose FK column
 * references the parent's PK. Pure and deterministic: nothing is inferred beyond what the file says,
 * and every line that doesn't match the format is reported as an issue rather than skipped silently.
 */

export const ERP_METADATA_FORMAT = "erp-metadata" as const;

/** Column types the document uses ("long" is bigint, "guid" uniqueidentifier). */
export const METADATA_TYPES = ["int", "long", "string", "decimal", "float", "bool", "date", "datetime", "time", "guid", "binary"] as const;
export type MetadataType = (typeof METADATA_TYPES)[number];

export interface MetaColumn {
  name: string;
  type: MetadataType;
  nullable: boolean;
  primaryKey: boolean;
  identity: boolean;
  label?: string;
  /** "@schema.table": inherited; the column physically lives in that ancestor table. */
  owner?: string;
}

export interface MetaForeignKey {
  column: string;
  refTable: string;
  refColumn: string;
}

export interface MetaTable {
  name: string;
  label?: string;
  /** FT=<FormTypeID>. */
  formTypeId?: number;
  /** IS-A <table>: PK-to-PK inheritance. */
  isA?: string;
  /** rows=<n>: an approximate count from the document, not a query result. */
  approxRows?: number;
  columns: MetaColumn[];
  foreignKeys: MetaForeignKey[];
  line: number;
}

export interface MetaEntityChild {
  table: string;
  /** The child's FK column that references `parent`'s PK; absent when the document gives none. */
  fkColumn?: string;
  parent: string;
  depth: number;
  line: number;
}

export interface MetaEntity {
  formTypeId: number;
  table: string;
  label: string;
  /** "^<table>": the entity's main table inherits from this table. */
  inheritsFrom?: string;
  children: MetaEntityChild[];
  line: number;
}

export interface MetaDomain {
  code: string;
  name: string;
  label: string;
}

export interface MetaSubsystem {
  /** Five letters: two for the domain, three for the subsystem (schema gnd_<code>). */
  code: string;
  domain: string;
  name: string;
  label: string;
}

/** The polymorphic entity registry (GLOBAL ENTITY KEY). */
export interface MetaEntityKey {
  view: string;
  columns: { name: string; type: string; description: string }[];
  /** vwErpEntity.ID = CAST(FT AS bigint) * multiplier + <table>.ID */
  multiplier: string;
  /** Name of the polymorphic pointer column (rule R3), e.g. ErpEntityID. */
  polymorphicColumn?: string;
}

export interface MetaIssue {
  line: number;
  message: string;
}

export interface ErpMetadataDocument {
  format: typeof ERP_METADATA_FORMAT;
  /** Section texts as in the file (they carry the document's own rules for the model). */
  notation: string;
  globalEntityKey: string;
  entityKey: MetaEntityKey | null;
  domains: MetaDomain[];
  subsystems: MetaSubsystem[];
  entities: MetaEntity[];
  tables: MetaTable[];
  /** Unrecognized or inconsistent lines. Non-empty means the document is not fully validated. */
  issues: MetaIssue[];
  /** Names the document references but never defines (their columns are unknown or partial). */
  undefinedTables: {
    foreignKeyTargets: string[];
    inheritanceOwners: string[];
    entityTreeTables: string[];
  };
}

const TABLE_NAME = String.raw`[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*`;
const SECTION = /^## (.+)$/;
const TABLE_LINE = new RegExp(
  String.raw`^TABLE (${TABLE_NAME})(?: \[([^\]]*)\])?(?: FT=(\d+))?(?: IS-A (${TABLE_NAME}))?(?: rows=(\d+))?$`,
);
const COLUMN_LINE = new RegExp(String.raw`^  ([A-Za-z_][A-Za-z0-9_]*):([a-z]+)(\?)?((?: PK| IDENTITY)*)(?: "(.*)")?(?: @(${TABLE_NAME}))?$`);
const FK_LINE = /^ {2}FK: (.+)$/;
const FK_ITEM = new RegExp(String.raw`^([A-Za-z_][A-Za-z0-9_]*)->(${TABLE_NAME})\.([A-Za-z_][A-Za-z0-9_]*)$`);
const ENTITY_LINE = new RegExp(String.raw`^E (\d+) (${TABLE_NAME}) \[([^\]]*)\](?: \^(${TABLE_NAME}))?$`);
const CHILD_LINE = new RegExp(String.raw`^( +)> (${TABLE_NAME})(?: \(([A-Za-z_][A-Za-z0-9_]*)\))?$`);
const DOMAIN_LINE = /^([a-z]{2}) (.+?) \| (.+)$/;
const SUBSYSTEM_LINE = /^([a-z]{5}) (.+?) \| (.+)$/;

/** Section names this parser understands (the header text before any " — " suffix). */
const KNOWN_SECTIONS = ["NOTATION", "GLOBAL ENTITY KEY", "DOMAINS", "SUBSYSTEMS", "ENTITY TREE", "SCHEMA"] as const;

/** Quick check used to pick this parser over the SQL DDL parser. */
export function looksLikeErpMetadata(text: string): boolean {
  return /^## SCHEMA\s*$/m.test(text) && /^TABLE [A-Za-z_]\w*\.\w+/m.test(text);
}

export const tableKey = (name: string) => name.toLowerCase();

function parseEntityKey(lines: string[], header: string): MetaEntityKey | null {
  const view = new RegExp(`(${TABLE_NAME})\\s*$`).exec(header)?.[1];
  if (!view) return null;
  const columns: MetaEntityKey["columns"] = [];
  for (const line of lines) {
    if (/^[A-Z]/.test(line)) break; // the next heading (PARTICIPATION, KEY FORMULA, ...)
    const m = /^\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.+)$/.exec(line);
    if (!m) continue;
    const type = /^(bigint|int|nvarchar|varchar|string)\b/i.exec(m[2])?.[1].toLowerCase();
    columns.push({ name: m[1], type: type === "bigint" ? "long" : type ?? "string", description: m[2].trim() });
  }
  const multiplier = lines.map((l) => /CAST\(FT AS bigint\)\s*\*\s*(\d+)/i.exec(l)?.[1]).find(Boolean);
  const polymorphicColumn = lines.map((l) => /column named ([A-Za-z_][A-Za-z0-9_]*)/i.exec(l)?.[1]).find(Boolean);
  if (!multiplier || !columns.some((c) => c.name === "ID")) return null;
  return { view, columns, multiplier, ...(polymorphicColumn && { polymorphicColumn }) };
}

/** Parses the document. Returns null when it isn't this format at all (no SCHEMA section with tables). */
export function parseErpMetadata(text: string): ErpMetadataDocument | null {
  if (!looksLikeErpMetadata(text)) return null;
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  const issues: MetaIssue[] = [];
  const issue = (line: number, message: string) => issues.push({ line, message });

  // Split into sections.
  const sections = new Map<string, { header: string; start: number; lines: string[] }>();
  let current: { header: string; start: number; lines: string[] } | null = null;
  for (const [i, line] of lines.entries()) {
    const m = SECTION.exec(line);
    if (m) {
      const name = KNOWN_SECTIONS.find((s) => m[1] === s || m[1].startsWith(`${s} `));
      if (!name) issue(i + 1, `unknown section "${m[1]}"`);
      if (name && sections.has(name)) issue(i + 1, `section ${name} appears twice`);
      current = { header: m[1], start: i + 1, lines: [] };
      if (name && !sections.has(name)) sections.set(name, current);
      continue;
    }
    if (current) current.lines.push(line);
    else if (line.trim()) issue(i + 1, "text before the first section");
  }
  for (const name of KNOWN_SECTIONS) if (!sections.has(name)) issue(0, `section ${name} is missing`);
  const section = (name: (typeof KNOWN_SECTIONS)[number]) => sections.get(name) ?? { header: name, start: 0, lines: [] };

  // DOMAINS / SUBSYSTEMS
  const domains: MetaDomain[] = [];
  const domainSection = section("DOMAINS");
  for (const [k, line] of domainSection.lines.entries()) {
    if (!line.trim()) continue;
    const m = DOMAIN_LINE.exec(line);
    if (m) domains.push({ code: m[1], name: m[2].trim(), label: m[3].trim() });
    else issue(domainSection.start + 1 + k, "unrecognized domain line");
  }
  const subsystems: MetaSubsystem[] = [];
  const subsystemSection = section("SUBSYSTEMS");
  for (const [k, line] of subsystemSection.lines.entries()) {
    if (!line.trim()) continue;
    const m = SUBSYSTEM_LINE.exec(line);
    if (m) subsystems.push({ code: m[1], domain: m[1].slice(0, 2), name: m[2].trim(), label: m[3].trim() });
    else issue(subsystemSection.start + 1 + k, "unrecognized subsystem line");
  }

  // ENTITY TREE
  const entities: MetaEntity[] = [];
  const treeSection = section("ENTITY TREE");
  let entity: MetaEntity | null = null;
  // The table at each indentation depth, for finding a child's parent.
  let path: string[] = [];
  for (const [k, line] of treeSection.lines.entries()) {
    const lineNo = treeSection.start + 1 + k;
    if (!line.trim()) continue;
    const e = ENTITY_LINE.exec(line);
    if (e) {
      entity = { formTypeId: Number(e[1]), table: e[2], label: e[3].trim(), ...(e[4] && { inheritsFrom: e[4] }), children: [], line: lineNo };
      entities.push(entity);
      path = [e[2]];
      continue;
    }
    const c = CHILD_LINE.exec(line);
    if (c && entity) {
      const indent = c[1].length;
      if (indent % 2 !== 0) issue(lineNo, "child indentation is not a multiple of two spaces");
      const depth = Math.floor(indent / 2);
      const parent = path[depth - 1];
      if (depth < 1 || !parent) {
        issue(lineNo, "child line is indented deeper than its parent");
        continue;
      }
      if (!c[3]) issue(lineNo, `child table ${c[2]} has no FK column in parentheses; its link to ${parent} is not documented`);
      entity.children.push({ table: c[2], ...(c[3] && { fkColumn: c[3] }), parent, depth, line: lineNo });
      path = [...path.slice(0, depth), c[2]];
      continue;
    }
    issue(lineNo, c ? "child line before any entity line" : "unrecognized entity-tree line");
  }

  // SCHEMA
  const tables: MetaTable[] = [];
  const schemaSection = section("SCHEMA");
  let table: MetaTable | null = null;
  for (const [k, line] of schemaSection.lines.entries()) {
    const lineNo = schemaSection.start + 1 + k;
    if (!line.trim()) {
      table = null;
      continue;
    }
    const t = TABLE_LINE.exec(line);
    if (t) {
      table = {
        name: t[1],
        ...(t[2] !== undefined && { label: t[2].trim() }),
        ...(t[3] && { formTypeId: Number(t[3]) }),
        ...(t[4] && { isA: t[4] }),
        ...(t[5] && { approxRows: Number(t[5]) }),
        columns: [],
        foreignKeys: [],
        line: lineNo,
      };
      if (!t[5]) issue(lineNo, `table ${t[1]} has no rows= count`);
      if (tables.some((x) => tableKey(x.name) === tableKey(t[1]))) issue(lineNo, `table ${t[1]} is defined twice`);
      tables.push(table);
      continue;
    }
    if (!table) {
      issue(lineNo, line.startsWith("TABLE ") ? "unrecognized TABLE line" : "line outside a TABLE block");
      continue;
    }
    const fk = FK_LINE.exec(line);
    if (fk) {
      for (const item of fk[1].split(";").map((s) => s.trim()).filter(Boolean)) {
        const m = FK_ITEM.exec(item);
        if (m) table.foreignKeys.push({ column: m[1], refTable: m[2], refColumn: m[3] });
        else issue(lineNo, `unrecognized foreign key "${item.slice(0, 80)}"`);
      }
      continue;
    }
    const col = COLUMN_LINE.exec(line);
    if (col) {
      const type = col[2] as MetadataType;
      if (!METADATA_TYPES.includes(type)) issue(lineNo, `unknown column type "${col[2]}"`);
      if (table.columns.some((c) => c.name.toLowerCase() === col[1].toLowerCase())) issue(lineNo, `column ${col[1]} is listed twice in ${table.name}`);
      table.columns.push({
        name: col[1],
        type,
        nullable: col[3] === "?",
        primaryKey: col[4].includes("PK"),
        identity: col[4].includes("IDENTITY"),
        ...(col[5] !== undefined && { label: col[5] }),
        ...(col[6] && { owner: col[6] }),
      });
      continue;
    }
    issue(lineNo, "unrecognized SCHEMA line");
  }

  // Cross-checks: everything is reported, nothing is repaired.
  const defined = new Map(tables.map((t) => [tableKey(t.name), t]));
  const foreignKeyTargets = new Set<string>();
  const inheritanceOwners = new Set<string>();
  const entityTreeTables = new Set<string>();
  for (const t of tables) {
    const pk = t.columns.filter((c) => c.primaryKey);
    if (pk.length !== 1) issue(t.line, `${t.name} has ${pk.length} primary-key columns`);
    for (const f of t.foreignKeys) {
      if (!t.columns.some((c) => c.name.toLowerCase() === f.column.toLowerCase())) issue(t.line, `${t.name}: FK column ${f.column} is not a column of the table`);
      if (!defined.has(tableKey(f.refTable))) foreignKeyTargets.add(f.refTable);
    }
    for (const c of t.columns) {
      if (!c.owner) continue;
      const owner = defined.get(tableKey(c.owner));
      if (!owner) inheritanceOwners.add(c.owner);
      else if (!owner.columns.some((oc) => oc.name.toLowerCase() === c.name.toLowerCase() && !oc.owner)) {
        issue(t.line, `${t.name}.${c.name} is marked @${c.owner}, but ${c.owner} doesn't list it as its own column`);
      }
    }
    if (t.isA && !defined.has(tableKey(t.isA))) issue(t.line, `${t.name} IS-A ${t.isA}, which is not defined in SCHEMA`);
  }
  for (const e of entities) {
    const t = defined.get(tableKey(e.table));
    if (!t) entityTreeTables.add(e.table);
    else {
      if (t.formTypeId !== undefined && t.formTypeId !== e.formTypeId) issue(e.line, `entity ${e.table} has FT ${e.formTypeId} but SCHEMA says FT=${t.formTypeId}`);
      if ((e.inheritsFrom ?? "") !== (t.isA ?? "")) issue(e.line, `entity ${e.table}: ENTITY TREE says ^${e.inheritsFrom ?? "(none)"}, SCHEMA says IS-A ${t.isA ?? "(none)"}`);
    }
    for (const child of e.children) {
      const ct = defined.get(tableKey(child.table));
      if (!ct) entityTreeTables.add(child.table);
      else if (child.fkColumn && !ct.columns.some((c) => c.name.toLowerCase() === child.fkColumn!.toLowerCase())) {
        issue(child.line, `child ${child.table} has no column ${child.fkColumn}`);
      }
    }
  }

  const globalSection = section("GLOBAL ENTITY KEY");
  const entityKey = parseEntityKey(globalSection.lines, globalSection.header);
  if (!entityKey) issue(globalSection.start, "the GLOBAL ENTITY KEY section has no recognizable view, ID column and key formula");
  const sorted = (s: Set<string>) => [...s].sort();
  return {
    format: ERP_METADATA_FORMAT,
    notation: section("NOTATION").lines.join("\n").trim(),
    globalEntityKey: `## ${globalSection.header}\n${globalSection.lines.join("\n").trim()}`,
    entityKey,
    domains,
    subsystems,
    entities,
    tables,
    issues,
    undefinedTables: {
      foreignKeyTargets: sorted(foreignKeyTargets),
      inheritanceOwners: sorted(inheritanceOwners),
      entityTreeTables: sorted(entityTreeTables),
    },
  };
}

/** Ancestors through IS-A, nearest first (cycles are cut and reported by the caller's data). */
export function ancestorsOf(name: string, byKey: Map<string, MetaTable>): string[] {
  const chain: string[] = [];
  let current = byKey.get(tableKey(name));
  while (current?.isA && !chain.some((c) => tableKey(c) === tableKey(current!.isA!)) && chain.length < 10) {
    chain.push(current.isA);
    current = byKey.get(tableKey(current.isA));
  }
  return chain;
}
