/** A column as declared in the uploaded schema file. */
export interface SchemaColumn {
  name: string;
  /** Declared SQL Server type, e.g. "nvarchar(200)"; null for computed columns. */
  type: string | null;
  /** Declared NULL / NOT NULL; null when not declared (e.g. computed columns). */
  nullable: boolean | null;
  identity: boolean;
  computed: boolean;
  /** Persian caption from the column's trailing comment, if present. */
  caption?: string;
}

export interface SchemaTable {
  /** Schema-qualified name, e.g. "gnd_hrprs.tblEmployee". */
  name: string;
  caption?: string;
  columns: SchemaColumn[];
  primaryKey: string[];
}

export interface SchemaForeignKey {
  name: string;
  table: string;
  columns: string[];
  refTable: string;
  refColumns: string[];
}

export interface SchemaIssue {
  line: number;
  message: string;
}

export interface ParsedSchema {
  /** From a `USE [db]` statement; null when the file doesn't declare one. */
  database: string | null;
  tables: SchemaTable[];
  foreignKeys: SchemaForeignKey[];
  /** Tables referenced by foreign keys but not defined in the file: their columns are unknown. */
  externalTables: string[];
  /** Unrecognized lines and inconsistencies. Non-empty means the schema is not fully validated. */
  issues: SchemaIssue[];
}

/** What the UI shows about a processed schema. */
export interface SchemaSummary {
  /** "erp-metadata" (GreenXERP AI metadata document) or "ddl" (CREATE TABLE script). Absent in records saved before formats existed (DDL). */
  format?: "ddl" | "erp-metadata";
  tables: number;
  /** Business entities of an ERP metadata document (its ENTITY TREE). */
  entities?: number;
  columns: number;
  foreignKeys: number;
  externalTables: number;
  issueCount: number;
  /** The first few issues, for display. */
  issues: SchemaIssue[];
}

/**
 * Response of `GET /api/schema`: where database knowledge comes from. In file mode every conversation
 * uses the server's default metadata file (only its name, size and counts are sent, never its content).
 */
export type SchemaConfigResponse =
  | { mode: "mcp" }
  /** MCP Agent mode: no database file; the names of the MCP tools the assistant may use, or why none are reachable. */
  | { mode: "mcp-agent"; tools: string[] }
  | { mode: "mcp-agent"; error: string }
  | { mode: "file" | "hybrid"; metadata: { fileName: string; size: number; summary: SchemaSummary } }
  | { mode: "file" | "hybrid"; error: string };

/** Response of `POST /api/schema`. */
export type SchemaUploadResponse =
  | { ok: true; fileName: string; size: number; summary: SchemaSummary; schema: ParsedSchema }
  | { ok: false; error: string };
