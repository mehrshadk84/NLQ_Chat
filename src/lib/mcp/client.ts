import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { DEFAULT_ALLOWED_TOOLS, RESULT_CHAR_LIMITS, formatToolResult, prepareTools, toolResultBody, type PreparedTool } from "./tools";

/*
 * Server-side MCP client (official TypeScript SDK, Streamable HTTP). The MCP server needs no key
 * to initialize; it selects the SQL Server database from X-Erp-* headers, the same ones the
 * GreenXERP backend sends. Those connection details come from server-side configuration and are
 * never sent to the browser or the model, logged, or put into tool arguments.
 *
 * There is no shared connection state: every chat request opens its own MCP session with its own
 * database connection and closes it afterwards, so credentials and results can't mix between users.
 */

function readNumber(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export const mcpConfig = {
  /** MCP endpoint. mcp.example.com serves Streamable HTTP at its root path. Empty = MCP disabled. */
  url: (process.env.MCP_SERVER_URL ?? "").trim(),
  allowedTools: (process.env.MCP_ALLOWED_TOOLS?.trim() || DEFAULT_ALLOWED_TOOLS.join(","))
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean),
  connectTimeoutMs: readNumber("MCP_CONNECT_TIMEOUT_MS", 10_000),
  toolTimeoutMs: readNumber("MCP_TOOL_TIMEOUT_MS", 20_000),
  /** Characters of a tool result passed to the model (the rest is cut off, with a note). */
  maxResultChars: readNumber("MCP_MAX_RESULT_CHARS", 3_000),
};

/** Database connection the MCP server should use (sent as X-Erp-* headers). */
export interface ErpConnection {
  server: string;
  database: string;
  username: string;
  password: string;
  ssl: boolean;
}

/**
 * The database connection for this request. In this local single-user setup it comes from
 * server-side environment variables. With authentication, resolve it from the signed-in
 * user's session instead; never accept connection details sent by the browser.
 * Returns null when not configured, or an error message when the configuration is invalid.
 */
export function getErpConnection(): ErpConnection | null | { error: string } {
  const values = {
    server: process.env.ERP_SERVER?.trim() ?? "",
    database: process.env.ERP_DATABASE?.trim() ?? "",
    username: process.env.ERP_USERNAME?.trim() ?? "",
    password: process.env.ERP_PASSWORD ?? "",
  };
  const ssl = (process.env.ERP_SSL ?? "").trim();
  if (!Object.values(values).some(Boolean) && !ssl) return null;
  const missing = Object.entries(values)
    .filter(([, v]) => !v)
    .map(([k]) => `ERP_${k.toUpperCase()}`);
  if (!/^(true|false)$/i.test(ssl)) missing.push("ERP_SSL (true or false)");
  if (missing.length) return { error: `database connection incomplete: ${missing.join(", ")}` };
  const placeholders = Object.entries(values)
    .filter(([, v]) => /^<.*>$/.test(v))
    .map(([k]) => `ERP_${k.toUpperCase()}`);
  if (placeholders.length) return { error: `still set to the .env.example placeholder: ${placeholders.join(", ")}` };
  // HTTP header values: printable Latin-1 only (no line breaks that could inject headers).
  if (!Object.values(values).every((v) => /^[\x20-\x7E\xA0-\xFF]+$/.test(v))) {
    return { error: "database connection values contain characters that can't be sent in HTTP headers" };
  }
  return { ...values, ssl: /^true$/i.test(ssl) };
}

/** The headers the GreenXERP backend sends; SSL as .NET's bool.ToString() ("True"/"False"). */
function erpHeaders(erp: ErpConnection): Record<string, string> {
  return {
    "X-Erp-Server": erp.server,
    "X-Erp-Database": erp.database,
    "X-Erp-Username": erp.username,
    "X-Erp-Password": erp.password,
    "X-Erp-Ssl": erp.ssl ? "True" : "False",
  };
}

export type McpErrorCode = "unavailable" | "auth" | "timeout" | "discovery" | "invalid_arguments" | "tool_failed";

export class McpError extends Error {
  readonly code: McpErrorCode;

  constructor(code: McpErrorCode, message: string) {
    super(message);
    this.name = "McpError";
    this.code = code;
  }
}

/** Removes connection details from text before it is logged or passed on. */
function redactor(erp: ErpConnection | null): (text: string) => string {
  const secrets = erp ? [erp.password, erp.username, erp.server, erp.database].filter((s) => s.length >= 3) : [];
  return (text) => secrets.reduce((t, secret) => t.split(secret).join("[redacted]"), text);
}

/** Maps SDK/network errors to a code; the message is redacted. */
function classify(error: unknown, fallback: McpErrorCode, redact: (text: string) => string): McpError {
  if (error instanceof McpError) return error;
  const message = redact(error instanceof Error ? error.message : String(error));
  const code = (error as { code?: unknown })?.code;
  if (code === -32602) return new McpError("invalid_arguments", message);
  if (/\b(401|403)\b|unauthori[sz]ed|forbidden/i.test(message)) return new McpError("auth", message);
  if (code === -32001 || /timed? ?out/i.test(message)) return new McpError("timeout", message);
  if (/fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|socket|network/i.test(message)) return new McpError("unavailable", message);
  return new McpError(fallback, message);
}

/** How a tool reported its own failure, for logs (the text itself goes to the model, redacted). */
function toolErrorKind(text: string): string {
  if (/login failed|cannot open database|password|authentication/i.test(text)) return "database login failed";
  if (/x-api-key/i.test(text)) return "server requires X-Api-Key";
  return "tool error";
}

const CANCEL_GRACE_MS = 500;

export interface McpSession {
  /** Usable tools: discovered, allowlisted and compatible. */
  tools: PreparedTool[];
  /** Discovered tools that are not offered, with the reason (for logs; not shown to users or the model). */
  skipped: { name: string; reason: string }[];
  /**
   * Runs a validated call; aborting `signal` cancels it on the server. MCP failures throw `McpError`.
   * `text` is the result for the model (capped, labelled as untrusted data); `body` is the whole result
   * text as returned. Both are redacted.
   */
  call(tool: PreparedTool, args: Record<string, unknown>, signal: AbortSignal): Promise<{ text: string; body: string; isError: boolean }>;
  /** Removes this session's connection details from text (for anything shown or logged). */
  redact(text: string): string;
  close(): Promise<void>;
}

/**
 * Opens an MCP session for one chat request: initialize, then list tools. Close it when done.
 * `allowedTools` replaces MCP_ALLOWED_TOOLS (MCP Agent mode has its own allowlist).
 */
export async function openMcpSession(erp: ErpConnection | null, options: { allowedTools?: string[] } = {}): Promise<McpSession> {
  const redact = redactor(erp);
  const transport = new StreamableHTTPClientTransport(new URL(mcpConfig.url), {
    // Sent with every MCP HTTP request of this session (initialize, tools/list, tools/call).
    requestInit: { headers: erp ? erpHeaders(erp) : {} },
  });
  const client = new Client({ name: "qwen-chat", version: "0.1.0" });
  // After a cancelled call the SDK sends notifications/cancelled; closing the transport at once
  // would abort that message, so give it a moment to reach the server.
  let cancelled = false;
  const close = async () => {
    if (cancelled) await new Promise((resolve) => setTimeout(resolve, CANCEL_GRACE_MS));
    await client.close().catch(() => {});
  };
  try {
    await client.connect(transport, { timeout: mcpConfig.connectTimeoutMs });
  } catch (error) {
    await close();
    throw classify(error, "unavailable", redact);
  }

  let discovered;
  try {
    discovered = (await client.listTools(undefined, { timeout: mcpConfig.connectTimeoutMs })).tools;
  } catch (error) {
    await close();
    throw classify(error, "discovery", redact);
  }
  const { tools, skipped } = prepareTools(discovered, options.allowedTools ?? mcpConfig.allowedTools);
  const server = client.getServerVersion();
  console.info(
    `[mcp] session opened (${server?.name ?? "unknown"} ${server?.version ?? ""}, database headers ${erp ? "sent" : "not configured"}); ` +
      `${discovered.length} tools; offered: ${tools.map((t) => t.name).join(", ") || "none"}; ` +
      `not offered: ${skipped.map((s) => `${s.name} (${s.reason})`).join(", ") || "none"}`,
  );

  return {
    tools,
    skipped,
    redact,
    close,
    async call(tool, args, signal) {
      const started = Date.now();
      try {
        const raw = await client.callTool({ name: tool.name, arguments: args }, undefined, { signal, timeout: mcpConfig.toolTimeoutMs });
        // Older servers answer with { toolResult } instead of content parts.
        const result = "toolResult" in raw ? { structuredContent: raw.toolResult } : raw;
        // Redacted before anything is cut, so a cut can't leave part of a secret behind.
        const text = formatToolResult(tool.name, result, Math.max(mcpConfig.maxResultChars, RESULT_CHAR_LIMITS[tool.name] ?? 0), redact);
        const body = redact(toolResultBody(result));
        const isError = "isError" in result && result.isError === true;
        // Names, timing and sizes only: arguments and results may contain business data.
        console.info(
          `[mcp] ${tool.name} ${isError ? `returned an error (${toolErrorKind(text)})` : "ok"} in ${Date.now() - started} ms, ${text.length} chars`,
        );
        return { text, body, isError };
      } catch (error) {
        if (signal.aborted) {
          cancelled = true;
          throw error;
        }
        const failure = classify(error, "tool_failed", redact);
        console.warn(`[mcp] ${tool.name} failed (${failure.code}) after ${Date.now() - started} ms`);
        throw failure;
      }
    },
  };
}
