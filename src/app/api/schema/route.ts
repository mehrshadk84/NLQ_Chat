import { connection } from "next/server";
import { loadDefaultMetadata } from "@/lib/erp-metadata/default-metadata";
import { ErpConfigError, contextSource, usesMetadataFile } from "@/lib/erp/prompt";
import { agentConfig } from "@/lib/mcp-agent/agent";
import { McpError, getErpConnection, mcpConfig, openMcpSession } from "@/lib/mcp/client";
import { MAX_SCHEMA_FILE_BYTES, checkSchemaFileSize, parseSchemaUpload } from "@/lib/schema-upload";
import { decodeTextFile } from "@/lib/text-file";
import type { SchemaConfigResponse, SchemaUploadResponse } from "@/types/schema";

const reject = (status: number, error: string) => Response.json({ ok: false, error } satisfies SchemaUploadResponse, { status });

/**
 * The database knowledge source: in file mode the default metadata file every conversation uses (its
 * name, size and counts only; the file and its parsed structure stay on the server).
 */
export async function GET(): Promise<Response> {
  // Read at request time, never prerendered at build: the file and the mode can change.
  await connection();
  const headers = { "Cache-Control": "no-store" };
  let mode: "file" | "hybrid" = "file";
  try {
    const source = contextSource();
    if (source === "mcp") return Response.json({ mode: "mcp" } satisfies SchemaConfigResponse, { headers });
    if (source === "mcp-agent") return Response.json(await agentTools(), { headers });
    mode = source;
    const { fileName, size, summary } = loadDefaultMetadata();
    // Counts only: the issue texts name tables and lines of the file (they are in the server log).
    return Response.json({ mode, metadata: { fileName, size, summary: { ...summary, issues: [] } } } satisfies SchemaConfigResponse, { headers });
  } catch (error) {
    if (!(error instanceof ErpConfigError)) throw error;
    console.error(`[metadata] configuration error (${error.code}): ${error.message}`);
    return Response.json({ mode, error: error.message } satisfies SchemaConfigResponse, { status: 503, headers });
  }
}

/**
 * MCP Agent mode: the names of the tools the assistant may use, from a short MCP session (tool listing
 * only, nothing is called). Which tools are withheld and why stays in the server log.
 */
async function agentTools(): Promise<SchemaConfigResponse> {
  const erp = getErpConnection();
  if (!mcpConfig.url) return { mode: "mcp-agent", error: "MCP_SERVER_URL is not set" };
  if (erp && "error" in erp) return { mode: "mcp-agent", error: "the ERP database connection is not configured correctly" };
  try {
    const session = await openMcpSession(erp, { allowedTools: agentConfig.allowedTools });
    void session.close();
    return { mode: "mcp-agent", tools: session.tools.map((t) => t.name) };
  } catch (error) {
    const code = error instanceof McpError ? error.code : "unavailable";
    return { mode: "mcp-agent", error: code === "timeout" ? "the MCP server timed out" : "the MCP server could not be reached" };
  }
}

/**
 * Parses an uploaded database file (a GreenXERP AI metadata document or a SQL Server CREATE TABLE
 * script, up to 300 KiB) and returns its structure. Nothing is stored on the server and nothing is
 * sent to the model; the browser keeps the result with the conversation.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const source = contextSource();
    if (usesMetadataFile(source)) return reject(409, "This mode uses the server's database metadata file for every conversation; uploads are not used.");
    if (source === "mcp-agent") return reject(409, "MCP Agent mode works through the MCP server's tools; database files are not used.");
  } catch (error) {
    if (error instanceof ErpConfigError) return reject(503, error.message);
    throw error;
  }
  if (Number(request.headers.get("content-length") ?? 0) > MAX_SCHEMA_FILE_BYTES + 64 * 1024) {
    return reject(413, checkSchemaFileSize(MAX_SCHEMA_FILE_BYTES + 1)!);
  }
  let file: FormDataEntryValue | null;
  try {
    file = (await request.formData()).get("file");
  } catch {
    return reject(400, "Invalid upload.");
  }
  if (!(file instanceof File)) return reject(400, "No file was uploaded.");
  const tooLarge = checkSchemaFileSize(file.size);
  if (tooLarge) return reject(413, tooLarge);

  const decoded = decodeTextFile(file.name, new Uint8Array(await file.arrayBuffer()));
  if (!decoded.ok) return reject(400, decoded.error);

  const parsed = parseSchemaUpload(decoded.text);
  if (!parsed) {
    return reject(
      422,
      "This file is neither a GreenXERP AI metadata document (## NOTATION … ## SCHEMA with TABLE blocks) nor SQL Server CREATE TABLE definitions. " +
        "To attach an ordinary text file, use the paperclip instead.",
    );
  }
  const { summary } = parsed;
  console.info(
    `[schema] parsed ${decoded.name} (${parsed.format}): ${summary.tables} tables, ${summary.columns} columns, ${summary.foreignKeys} foreign keys, ` +
      `${summary.entities !== undefined ? `${summary.entities} entities, ` : ""}${summary.externalTables} undefined tables, ${summary.issueCount} issues`,
  );
  return Response.json({ ok: true, fileName: decoded.name, size: file.size, summary, schema: parsed.schema } satisfies SchemaUploadResponse);
}
