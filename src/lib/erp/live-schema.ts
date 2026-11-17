import { createHash } from "node:crypto";
import type { ErpConnection, McpSession } from "@/lib/mcp/client";
import type { LiveSchemaCheck } from "@/types/chat";

/*
 * Reconciles a query with the live database before it is executed (hybrid mode). The metadata file
 * is a snapshot: a table or column it documents may be gone or renamed in the database. For every
 * table the query reads, the live structure is fetched through the MCP tool get_table_ai_struct (same
 * notation as the file) and every column the query reads from it must physically exist there.
 *
 * Structures are cached per database connection (server, database and login, hashed: the cache never
 * serves one database's structure for another) for ERP_LIVE_SCHEMA_TTL_MS. Anything that can't be
 * confirmed (MCP unreachable, an error, a truncated structure) is "unavailable", which blocks execution.
 */

const STRUCT_TOOL = "get_table_ai_struct";

const readNumber = (name: string, fallback: number) => {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
};
const TTL_MS = readNumber("ERP_LIVE_SCHEMA_TTL_MS", 10 * 60_000);

/** A table as the live database describes it: its physical columns and the inherited ones (with owner). */
export interface LiveTable {
  name: string;
  /** Upper-case names of the columns stored in this table. */
  columns: Set<string>;
  /** Upper-case inherited column → owner table (physically stored there, not here). */
  inherited: Map<string, string>;
}

/**
 * Parses a get_table_ai_struct result (the tool's text, possibly wrapped by the MCP layer). Returns
 * null for an empty result (no such table), or "truncated" when the structure was cut off.
 */
export function parseLiveStructure(text: string): LiveTable | null | "truncated" {
  if (/\[truncated: \d+ more characters/.test(text)) return "truncated";
  const lines = text.split(/\r?\n/);
  const header = lines.findIndex((l) => /^TABLE [A-Za-z0-9_]+\.[A-Za-z0-9_]+/.test(l));
  if (header < 0) return null;
  const name = /^TABLE ([A-Za-z0-9_]+\.[A-Za-z0-9_]+)/.exec(lines[header])![1];
  const table: LiveTable = { name, columns: new Set(), inherited: new Map() };
  for (const line of lines.slice(header + 1)) {
    if (/^TABLE /.test(line) || /^>>>/.test(line)) break;
    const column = /^\s+([A-Za-z0-9_]+):[a-z]+\??/.exec(line);
    if (!column) continue;
    const owner = /@([A-Za-z0-9_]+\.[A-Za-z0-9_]+)\s*$/.exec(line);
    if (owner) table.inherited.set(column[1].toUpperCase(), owner[1]);
    else table.columns.add(column[1].toUpperCase());
  }
  return table;
}

const cache = new Map<string, { at: number; table: LiveTable | null }>();
const scopeOf = (erp: ErpConnection) => createHash("sha256").update(`${erp.server}\u0000${erp.database}\u0000${erp.username}`).digest("hex").slice(0, 16);

/**
 * A checker bound to one MCP session and database connection: given what a validated query reads
 * (table → upper-case columns), says whether the live database has all of it.
 */
export function liveSchemaChecker(session: McpSession | null, erp: ErpConnection | null, unavailable?: string) {
  return async (usage: Map<string, Set<string>>, signal: AbortSignal): Promise<LiveSchemaCheck> => {
    if (!session || !erp) return { status: "unavailable", reason: unavailable ?? "the MCP server is not connected" };
    const tool = session.tools.find((t) => t.name === STRUCT_TOOL);
    if (!tool) return { status: "unavailable", reason: `the MCP tool ${STRUCT_TOOL} is not available` };
    const scope = scopeOf(erp);
    const problems: string[] = [];
    for (const [name, columns] of usage) {
      const key = `${scope}|${name.toLowerCase()}`;
      let entry = cache.get(key);
      if (!entry || Date.now() - entry.at > TTL_MS) {
        let result;
        try {
          result = await session.call(tool, { tableName: name }, signal);
        } catch (error) {
          if (signal.aborted) throw error;
          return { status: "unavailable", reason: `the live structure of ${name} could not be read through MCP` };
        }
        if (result.isError) return { status: "unavailable", reason: `the MCP server reported an error for ${name}` };
        const parsed = parseLiveStructure(result.text);
        if (parsed === "truncated") return { status: "unavailable", reason: `the live structure of ${name} was too large to check completely` };
        entry = { at: Date.now(), table: parsed };
        cache.set(key, entry);
      }
      const live = entry.table;
      if (!live) {
        problems.push(`${name} does not exist in the live database`);
        continue;
      }
      for (const column of columns) {
        if (live.columns.has(column)) continue;
        const owner = live.inherited.get(column);
        problems.push(owner ? `${name}.${column} is stored in ${owner} in the live database` : `${name}.${column} does not exist in the live database`);
      }
    }
    if (problems.length) return { status: "mismatch", reason: `the metadata file doesn't match the live database: ${problems.slice(0, 5).join("; ")}` };
    return { status: "verified", tables: [...usage.keys()] };
  };
}

export type LiveSchemaChecker = ReturnType<typeof liveSchemaChecker>;
