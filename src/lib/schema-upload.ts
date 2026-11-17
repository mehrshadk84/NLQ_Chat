import { looksLikeErpMetadata, parseErpMetadata, type ErpMetadataDocument } from "@/lib/erp-metadata/parse";
import { erpSchemaView, type ErpKeyRules, type InheritedColumns } from "@/lib/erp-metadata/schema-view";
import { parseSchema, summarizeSchema } from "@/lib/sql-schema/parse";
import type { ParsedSchema, SchemaSummary } from "@/types/schema";

export { MAX_SCHEMA_FILE_BYTES, checkSchemaFileSize } from "@/lib/text-file";

/*
 * The database file of a conversation (the database button), in either supported format:
 *  - "erp-metadata": the GreenXERP AI metadata document (## NOTATION … ## SCHEMA with TABLE blocks);
 *  - "ddl": SQL Server CREATE TABLE scripts (SSMS "Generate Scripts" style).
 * Server-side the file is always parsed again from its text: the browser's copy is untrusted.
 */

export type ParsedUpload =
  | { format: "ddl"; schema: ParsedSchema; summary: SchemaSummary }
  | { format: "erp-metadata"; schema: ParsedSchema; summary: SchemaSummary; document: ErpMetadataDocument; keyRules: ErpKeyRules | null; inherited: InheritedColumns };

/** Parses the text in its detected format, or returns null when it is neither format. */
export function parseSchemaUpload(text: string): ParsedUpload | null {
  if (looksLikeErpMetadata(text)) {
    const document = parseErpMetadata(text);
    if (!document) return null;
    const { schema, keyRules, inherited } = erpSchemaView(document);
    const summary: SchemaSummary = {
      format: "erp-metadata",
      tables: document.tables.length,
      columns: document.tables.reduce((sum, t) => sum + t.columns.length, 0),
      foreignKeys: document.tables.reduce((sum, t) => sum + t.foreignKeys.length, 0),
      entities: document.entities.length,
      externalTables: schema.externalTables.length,
      issueCount: document.issues.length,
      issues: document.issues.slice(0, 20),
    };
    return { format: "erp-metadata", schema, summary, document, keyRules, inherited };
  }
  const schema = parseSchema(text);
  if (!schema) return null;
  return { format: "ddl", schema, summary: { format: "ddl", ...summarizeSchema(schema) } };
}
