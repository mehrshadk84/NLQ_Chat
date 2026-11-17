/*
 * The ERP response contract defined in RESPONSE FORMAT of prompts/erp-system-prompt.txt: every
 * model turn is a JSON array of objects, each with exactly these eight keys.
 */

export const ERP_ACTIONS = ["answer", "ask", "intent", "query", "query-diagram", "client-diagram", "resolve-query", "error"] as const;
export type ErpAction = (typeof ERP_ACTIONS)[number];

export const CHART_TYPES = ["line", "pie", "vertical-bar"] as const;
export type ChartType = (typeof CHART_TYPES)[number];

export type ContentBlock =
  | { type: "h1" | "h2" | "h3" | "paragraph"; text: string }
  | { type: "list"; items: string[] }
  | { type: "link"; text: string; url: string };

export interface ChartSeries {
  name: string;
  data: number[];
}

export interface ErpChart {
  /** "" unless the action is "client-diagram" or "query-diagram". */
  chart_type: ChartType | "";
  title: string;
  categories: string[];
  series: ChartSeries[];
}

export interface ProcedureParameter {
  value: string | number | boolean | null;
  type: string;
}

export interface ProcedureRequest {
  procedure: string;
  parameters: Record<string, ProcedureParameter>;
}

export interface ErpResolves {
  intent: string;
  procedure: string;
  parameter: string;
}

export interface ErpResponseObject {
  action: ErpAction;
  /** Only ever non-empty for "error". */
  content: string;
  /** Only for "answer" and "ask". */
  content_blocks: ContentBlock[];
  intent: string;
  /** Only for "intent". */
  procedures: ProcedureRequest[];
  /** Only for "query", "query-diagram", "resolve-query" (and the EXEC companion "query"). */
  sql: string;
  chart: ErpChart;
  /** Only for "resolve-query". */
  resolves: ErpResolves;
}

/** One validated model turn: a non-empty array of response objects. */
export type ErpResponse = ErpResponseObject[];

/**
 * What the backend did with the requests ("intent", "query", "query-diagram", "resolve-query")
 * in a step. Steps without requests have no execution.
 */
export type StepExecution =
  | { status: "executed"; requests: number; results?: ExecutedResult[] }
  /** SQL/procedure execution is disabled or not verified safe: nothing was run. */
  | { status: "unavailable"; reason: string }
  | { status: "failed"; reason: string };

/**
 * What the database actually returned for one executed SELECT (hybrid mode), for display: the SQL
 * it belongs to, the columns, the first rows, and a chart drawn from those rows when one was asked
 * for. Never model text.
 */
export interface ExecutedResult {
  sql: string;
  columns: string[];
  /** The first rows (up to the display limit), cells as returned (text, numbers, booleans, null). */
  rows: (string | number | boolean | null)[][];
  /** Rows returned by the database (up to the execution row limit). */
  rowCount: number;
  /** More rows existed than the execution row limit allowed. */
  truncated: boolean;
  /** For "query-diagram": the chart drawn from these rows, or why none could be drawn. */
  chart?: ErpChart | { unavailable: string };
}

/** The check of a step's SQL against the live database schema (through MCP) before execution. */
export type LiveSchemaCheck =
  | { status: "verified"; tables: string[] }
  | { status: "mismatch"; reason: string }
  | { status: "unavailable"; reason: string };

/**
 * One MCP tool call of an MCP Agent turn, as the backend handled it. Everything here is the
 * backend's record, never model text: the status says whether the server actually ran the tool.
 */
export interface ToolCallRecord {
  /** Order within the turn ("1", "2", …); a running call is later replaced by its finished record. */
  id: string;
  name: string;
  /** The arguments as JSON text (the validated ones when the call ran), redacted and capped. */
  arguments: string;
  /**
   * running: in progress. ok: the MCP server returned a result. error: the tool returned an error
   * result. failed: the call itself failed (timeout, connection). rejected: the backend refused it
   * (unknown or unauthorized tool, invalid or missing arguments) and nothing was sent to the server.
   * duplicate: identical to an earlier call of this turn, so not sent again.
   */
  status: "running" | "ok" | "error" | "failed" | "rejected" | "duplicate";
  /** Why it was rejected or failed, or the tool's own error text. */
  detail?: string;
  /** The tool's result text as returned (credentials redacted), capped for display. */
  result?: string;
  /** Length of the whole result text; `truncated` when `result` is cut off. */
  resultChars?: number;
  truncated?: boolean;
  durationMs?: number;
  /** "backend": run because the user named the tool and the model didn't call it. Absent: chosen by the model. */
  by?: "backend";
}

/** One model turn inside a chat turn, as shown in the UI. */
export interface AssistantStep {
  response: ErpResponse;
  /** MCP Agent mode: the tool calls the backend handled for this step, in order. */
  toolCalls?: ToolCallRecord[];
  execution?: StepExecution;
  liveSchema?: LiveSchemaCheck;
  /** Facts the application adds about this step (unsupported lookups, truncated results). Never model text. */
  notices?: string[];
}

/**
 * How a chat turn ended. "final": the last step needed nothing more from the backend.
 * The others stop the workflow with the last step's requests unanswered.
 */
export type TurnOutcome = "final" | "execution_unavailable" | "execution_failed" | "step_limit";

/** A TXT file attached to a user message. Its text is kept so later turns can include it. */
export interface Attachment {
  name: string;
  /** Size of the original file in bytes. */
  size: number;
  /** Extracted text. Absent when the file is no longer part of the model's context. */
  content?: string;
  /**
   * Why `content` is absent: it couldn't be saved in browser storage, or older messages
   * no longer fit in the model's context window. Either way the file must be reattached.
   */
  missing?: "not_saved" | "out_of_context";
}

export type ChatMessage =
  /** `content` may be empty when the message is only an attachment. */
  | { id: string; role: "user"; content: string; attachment?: Attachment }
  /** One chat turn of the ERP workflow: every validated model step, in order. */
  | { id: string; role: "assistant"; turnId: string; steps: AssistantStep[]; outcome: TurnOutcome }
  /** An application error shown in the chat. Never sent to the model. */
  | { id: string; role: "error"; content: string }
  /** Saved by an older version (free text or the old {action, content} replies). Shown as-is, never sent to the model. */
  | { id: string; role: "legacy"; content: string };

export interface Conversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  updatedAt: number;
}

/** A file's name and text as sent to `POST /api/chat` inside earlier user messages. */
export interface ApiAttachment {
  name: string;
  content: string;
}

/**
 * A message as sent to `POST /api/chat`. Assistant turns carry the model's validated arrays
 * and the server's turn id (to find tool results and backend payloads kept on the server).
 * Earlier user turns carry their attachment text; the current turn's file is uploaded as
 * multipart form data instead.
 */
export type ApiMessage =
  | { role: "user"; content: string; attachment?: ApiAttachment }
  | { role: "assistant"; turnId: string; steps: ErpResponse[] };

export type ChatErrorCode = "invalid_attachment" | "context_overflow" | "invalid_schema" | "erp_config";

/** JSON body returned by `/api/chat` when a request is rejected before streaming starts. */
export interface ChatErrorBody {
  error: string;
  code?: ChatErrorCode;
}

/** Work in progress, for the UI's progress notice. Carries no data or identifiers. */
export type ProgressStage = "tools" | "generating" | "checking" | "executing";

/**
 * `/api/chat` streams newline-delimited JSON events: `status`/`progress` while working, at most
 * one `context` event, a `step` for every validated model turn, then exactly one `done` or
 * `error`. A stream that ends without one was interrupted.
 */
export type ChatStreamEvent =
  | { type: "status"; state: "generating" | "retrying" }
  | { type: "progress"; stage: ProgressStage }
  /** The oldest `omitted` messages of the request didn't fit in the context window. */
  | { type: "context"; omitted: number }
  | { type: "step"; step: AssistantStep }
  /** MCP Agent mode: a tool call started or finished (same id: the finished record replaces the running one). */
  | { type: "tool"; call: ToolCallRecord }
  | { type: "done"; turnId: string; outcome: TurnOutcome }
  | { type: "error"; error: string; code?: ChatErrorCode };
