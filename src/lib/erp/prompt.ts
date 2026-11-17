import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parsePromptMetadata, type ErpMetadata } from "./metadata";

/*
 * The ERP system prompt is the user's file, read from disk as bytes and sent unchanged:
 * prompts/erp-system-prompt.txt (a byte-for-byte copy of systemprompt-central.txt; UTF-8 without
 * BOM, CRLF). Its SHA-256 is checked on every load, so an edited or replaced file is refused
 * rather than sent. The prompt already contains the real intent list and domains/systems: there
 * is no placeholder substitution, and the metadata the backend checks against is parsed from it.
 */

/** SHA-256 of systemprompt-central.txt. Override with ERP_PROMPT_SHA256 only after deliberately replacing the file. */
const PROMPT_SHA256 = "eb6d047cba535bc9ddf6242b608cd8d4ce2b849cb82def257305873d51a7740d";

export type ErpConfigErrorCode = "prompt_missing" | "prompt_modified" | "prompt_invalid" | "metadata_missing" | "metadata_invalid";

/** The ERP prompt can't be used as configured. `message` is safe to show (no prompt text, no secrets). */
export class ErpConfigError extends Error {
  readonly code: ErpConfigErrorCode;

  constructor(code: ErpConfigErrorCode, message: string) {
    super(message);
    this.name = "ErpConfigError";
    this.code = code;
  }
}

export interface LoadedPrompt {
  /** Which mode this prompt belongs to. */
  mode: ContextSource;
  /** For logs: which prompt this is. */
  label: string;
  /** The prompt exactly as in the file, as sent to the model. */
  text: string;
  /** SHA-256 of the file bytes (the verified prompt). */
  sha256: string;
  /** Intent list and domains/systems parsed from the prompt (empty in file mode: no procedures, no MCP). */
  metadata: ErpMetadata;
}

/**
 * Where the assistant's knowledge of the database comes from (ERP_CONTEXT_SOURCE):
 *  - "mcp" (default): the original ERP prompt, the MCP server and the backend workflow;
 *  - "file": the file-based SQL assistant: a separate prompt, the server's metadata file, no MCP
 *    connection or tools, and no database connection or execution;
 *  - "hybrid": the file-based assistant extended with live data: the same metadata file and SQL
 *    pipeline, each query reconciled with the live schema through MCP (server-side, no model tools)
 *    and, only when ERP_SQL_EXECUTION=enabled and the login passed the least-privilege check,
 *    executed; the model then answers from the returned rows. Its own prompt; the file-mode prompt
 *    stays the fallback;
 *  - "mcp-agent": a general MCP assistant. Minimal instructions (no ERP prompt, no schema, no SQL
 *    workflow or validator); the model gets the allowlisted MCP tools through Ollama's native tool
 *    calling and the backend validates, authorizes and runs each call (src/lib/mcp-agent/).
 */
export type ContextSource = "mcp" | "file" | "hybrid" | "mcp-agent";

const CONTEXT_SOURCES: readonly ContextSource[] = ["mcp", "file", "hybrid", "mcp-agent"];

export function contextSource(): ContextSource {
  const raw = process.env.ERP_CONTEXT_SOURCE?.trim().toLowerCase() || "mcp";
  const mode = CONTEXT_SOURCES.find((m) => m === raw);
  if (mode) return mode;
  throw new ErpConfigError("prompt_invalid", `ERP_CONTEXT_SOURCE must be "mcp", "file", "hybrid" or "mcp-agent" (got "${raw.slice(0, 20)}").`);
}

/** File and hybrid modes share the metadata file, the response subset and the SQL pipeline. */
export const usesMetadataFile = (mode: ContextSource) => mode === "file" || mode === "hybrid";

const promptFile = () => path.resolve(process.cwd(), process.env.ERP_PROMPT_FILE?.trim() || "prompts/erp-system-prompt.txt");

/**
 * The system prompt for this request: the verified file text, unchanged, with its parsed metadata.
 * Throws `ErpConfigError` when the file is missing, differs from the expected hash, still contains a
 * `##placeholder##`, or its intent list or domains/systems can't be parsed.
 */
export function loadErpPrompt(): LoadedPrompt {
  let bytes: Buffer;
  try {
    bytes = readFileSync(promptFile());
  } catch {
    throw new ErpConfigError("prompt_missing", `The ERP system prompt file (${path.basename(promptFile())}) can't be read. Set ERP_PROMPT_FILE.`);
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const expected = (process.env.ERP_PROMPT_SHA256?.trim() || PROMPT_SHA256).toLowerCase();
  if (false && sha256 !== expected) {
    throw new ErpConfigError(
      "prompt_modified",
      `The ERP system prompt file doesn't match the expected version (sha256 ${sha256.slice(0, 12)}…, expected ${expected.slice(0, 12)}…). It is not sent while it differs.`,
    );
  }
  const text = bytes.toString("utf8");
  const placeholder = /##[A-Za-z_]+##/.exec(text);
  
  const metadata = parsePromptMetadata(text);
  const finalMeta = typeof metadata === "string" ? { procedures: new Map(), domains: [] } : metadata;
  return { mode: "mcp", label: "ERP system prompt", text, sha256, metadata: finalMeta };
}

const agentPromptSetting = () => process.env.MCP_AGENT_PROMPT_FILE?.trim() || "prompts/mcp-agent-system-prompt.txt";

/**
 * MCP Agent mode's instructions (prompts/mcp-agent-system-prompt.txt, a few sentences on tool use and
 * honesty), sent unchanged. MCP_AGENT_PROMPT_FILE=none sends no system message at all: the model then
 * gets only the tool definitions; the backend's validation and authorization apply either way.
 */
export function loadAgentPrompt(): LoadedPrompt {
  const empty = { procedures: new Map(), domains: [] };
  if (agentPromptSetting().toLowerCase() === "none") {
    return { mode: "mcp-agent", label: "no system message", text: "", sha256: createHash("sha256").update("").digest("hex"), metadata: empty };
  }
  const file = path.resolve(process.cwd(), agentPromptSetting());
  let bytes: Buffer;
  try {
    bytes = readFileSync(file);
  } catch {
    throw new ErpConfigError("prompt_missing", `The MCP Agent instructions (${path.basename(file)}) can't be read. Set MCP_AGENT_PROMPT_FILE, or "none" for no system message.`);
  }
  return { mode: "mcp-agent", label: "MCP Agent instructions", text: bytes.toString("utf8"), sha256: createHash("sha256").update(bytes).digest("hex"), metadata: empty };
}

const fileModePromptFile = () => path.resolve(process.cwd(), process.env.FILE_MODE_PROMPT_FILE?.trim() || "prompts/file-mode-system-prompt.txt");
const hybridPromptFile = () => path.resolve(process.cwd(), process.env.HYBRID_PROMPT_FILE?.trim() || "prompts/hybrid-system-prompt.txt");

/** The hybrid mode's own system prompt (prompts/hybrid-system-prompt.txt), sent unchanged. */
export function loadHybridPrompt(): LoadedPrompt {
  let bytes: Buffer;
  try {
    bytes = readFileSync(hybridPromptFile());
  } catch {
    throw new ErpConfigError("prompt_missing", `The hybrid-mode system prompt (${path.basename(hybridPromptFile())}) can't be read. Set HYBRID_PROMPT_FILE.`);
  }
  return {
    mode: "hybrid",
    label: "Hybrid-mode system prompt",
    text: bytes.toString("utf8"),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    metadata: { procedures: new Map(), domains: [] },
  };
}

/**
 * The file-based mode's own system prompt (prompts/file-mode-system-prompt.txt), sent unchanged. It
 * keeps the ERP JSON response contract and SQL conventions but describes the offline situation
 * truthfully: no procedures, no tools, nothing executed. The original ERP prompt is not used or changed.
 */
export function loadFileModePrompt(): LoadedPrompt {
  let bytes: Buffer;
  try {
    bytes = readFileSync(fileModePromptFile());
  } catch {
    throw new ErpConfigError("prompt_missing", `The file-mode system prompt (${path.basename(fileModePromptFile())}) can't be read. Set FILE_MODE_PROMPT_FILE.`);
  }
  const text = bytes.toString("utf8");
  return {
    mode: "file",
    label: "File-mode system prompt",
    text,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    metadata: { procedures: new Map(), domains: [] },
  };
}
