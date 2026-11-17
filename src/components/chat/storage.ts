import { readErpResponse } from "@/lib/erp/contract";
import type { AssistantStep, Attachment, ChatMessage, Conversation, ExecutedResult, ToolCallRecord, TurnOutcome } from "@/types/chat";

const CONVERSATIONS_KEY = "qwen-chat:conversations";
const ACTIVE_KEY = "qwen-chat:active";

/** Reads a stored attachment. Text that wasn't saved is marked so the UI asks for the file again. */
function toAttachment(value: unknown): Attachment | null {
  if (typeof value !== "object" || value === null) return null;
  const { name, size, content, missing } = value as Record<string, unknown>;
  if (typeof name !== "string" || typeof size !== "number") return null;
  if (typeof content === "string" && content) return { name, size, content };
  return { name, size, missing: missing === "out_of_context" ? "out_of_context" : "not_saved" };
}

const TURN_OUTCOMES: readonly TurnOutcome[] = ["final", "execution_unavailable", "execution_failed", "step_limit"];

const isCell = (v: unknown) => v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean";

/** A stored chart drawn from returned rows, or the reason none was drawn; null when malformed. */
function toResultChart(value: unknown): ExecutedResult["chart"] | null {
  if (typeof value !== "object" || value === null) return null;
  const c = value as Record<string, unknown>;
  if (typeof c.unavailable === "string") return { unavailable: c.unavailable };
  const types: unknown[] = ["line", "pie", "vertical-bar"];
  if (!types.includes(c.chart_type) || typeof c.title !== "string" || !Array.isArray(c.categories) || !Array.isArray(c.series)) return null;
  if (!c.categories.every((x) => typeof x === "string")) return null;
  const series = c.series as { name?: unknown; data?: unknown }[];
  if (!series.every((s) => typeof s.name === "string" && Array.isArray(s.data) && s.data.every((n) => typeof n === "number"))) return null;
  return value as ExecutedResult["chart"];
}

/** A stored result of an executed SELECT; null when malformed (it is then dropped, not shown). */
function toExecutedResult(value: unknown): ExecutedResult | null {
  if (typeof value !== "object" || value === null) return null;
  const r = value as Record<string, unknown>;
  if (typeof r.sql !== "string" || typeof r.rowCount !== "number" || typeof r.truncated !== "boolean") return null;
  if (!Array.isArray(r.columns) || !r.columns.every((c) => typeof c === "string")) return null;
  if (!Array.isArray(r.rows) || !r.rows.every((row) => Array.isArray(row) && row.every(isCell))) return null;
  const result: ExecutedResult = { sql: r.sql, columns: r.columns, rows: r.rows, rowCount: r.rowCount, truncated: r.truncated };
  if (r.chart !== undefined) {
    const chart = toResultChart(r.chart);
    if (chart) result.chart = chart;
  }
  return result;
}

const TOOL_STATUSES: readonly ToolCallRecord["status"][] = ["running", "ok", "error", "failed", "rejected", "duplicate"];

/** A tool call record (stored, or from the server's stream); null when malformed. Only known fields are kept. */
export function toToolCall(value: unknown): ToolCallRecord | null {
  if (typeof value !== "object" || value === null) return null;
  const r = value as Record<string, unknown>;
  const status = TOOL_STATUSES.find((s) => s === r.status);
  if (typeof r.id !== "string" || typeof r.name !== "string" || typeof r.arguments !== "string" || !status) return null;
  const record: ToolCallRecord = { id: r.id, name: r.name, arguments: r.arguments, status };
  if (typeof r.detail === "string") record.detail = r.detail;
  if (typeof r.result === "string") record.result = r.result;
  if (typeof r.resultChars === "number") record.resultChars = r.resultChars;
  if (r.truncated === true) record.truncated = true;
  if (typeof r.durationMs === "number") record.durationMs = r.durationMs;
  if (r.by === "backend") record.by = "backend";
  return record;
}

/** A stored ERP step: a contract-valid response with optional execution status, results and notices. */
function toStep(value: unknown): AssistantStep | null {
  if (typeof value !== "object" || value === null) return null;
  const { response, execution, notices, liveSchema, toolCalls } = value as Record<string, unknown>;
  const read = readErpResponse(response);
  if (!read.ok) return null;
  const step: AssistantStep = { response: read.value };
  if (typeof execution === "object" && execution !== null) {
    const e = execution as Record<string, unknown>;
    if (e.status === "executed" && typeof e.requests === "number") {
      const results = Array.isArray(e.results) ? e.results.map(toExecutedResult).filter((x) => x !== null) : undefined;
      step.execution = { status: "executed", requests: e.requests, ...(results?.length && { results }) };
    } else if ((e.status === "unavailable" || e.status === "failed") && typeof e.reason === "string") step.execution = { status: e.status, reason: e.reason };
  }
  if (typeof liveSchema === "object" && liveSchema !== null) {
    const l = liveSchema as Record<string, unknown>;
    if (l.status === "verified" && Array.isArray(l.tables) && l.tables.every((t) => typeof t === "string")) step.liveSchema = { status: "verified", tables: l.tables };
    else if ((l.status === "mismatch" || l.status === "unavailable") && typeof l.reason === "string") step.liveSchema = { status: l.status, reason: l.reason };
  }
  if (Array.isArray(notices) && notices.every((n) => typeof n === "string")) step.notices = notices;
  if (Array.isArray(toolCalls)) {
    const calls = toolCalls.map(toToolCall).filter((c) => c !== null);
    if (calls.length) step.toolCalls = calls;
  }
  return step;
}

/**
 * Reads a stored message, or returns null if it's invalid. Assistant turns must be valid ERP
 * responses; replies saved by older versions (free text, or the old {action, content} object)
 * are kept as "legacy" messages, shown but never sent to the model again. An old `error` field
 * becomes a separate error message.
 */
function toMessages(value: unknown): ChatMessage[] | null {
  if (typeof value !== "object" || value === null) return null;
  const m = value as Record<string, unknown>;
  const { id, role } = m;
  if (typeof id !== "string") return null;

  if (role === "assistant" && Array.isArray(m.steps)) {
    const steps = m.steps.map(toStep);
    const outcome = TURN_OUTCOMES.find((o) => o === m.outcome);
    if (typeof m.turnId === "string" && outcome && steps.length > 0 && steps.every((s) => s !== null)) {
      return [{ id, role, turnId: m.turnId, steps: steps as AssistantStep[], outcome }];
    }
    return [{ id, role: "legacy", content: JSON.stringify(m.steps, null, 2).slice(0, 20_000) }];
  }

  const { content } = m;
  if (typeof content !== "string") return null;
  if (role === "user") {
    if (m.attachment === undefined) return [{ id, role, content }];
    const attachment = toAttachment(m.attachment);
    return attachment ? [{ id, role, content, attachment }] : null;
  }
  if (role === "error" || role === "legacy") return [{ id, role, content }];
  if (role !== "assistant") return null;

  const migrated: ChatMessage[] = [];
  const text = m.action !== undefined ? JSON.stringify({ action: m.action, content }, null, 2) : content;
  if (text.trim()) migrated.push({ id, role: "legacy", content: text });
  if (typeof m.error === "string") migrated.push({ id: `${id}-error`, role: "error", content: m.error });
  return migrated;
}

function toConversation(value: unknown): Conversation | null {
  if (typeof value !== "object" || value === null) return null;
  const c = value as Partial<Conversation>;
  if (typeof c.id !== "string" || typeof c.title !== "string" || typeof c.updatedAt !== "number") return null;
  if (!Array.isArray(c.messages)) return null;

  const messages: ChatMessage[] = [];
  for (const item of c.messages) {
    const converted = toMessages(item);
    if (!converted) return null;
    messages.push(...converted);
  }
  return { id: c.id, title: c.title, updatedAt: c.updatedAt, messages };
}

// localStorage can be unavailable (privacy mode) or full; the chat keeps working in memory.

export function loadConversations(): Conversation[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(CONVERSATIONS_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.map(toConversation).filter((c): c is Conversation => c !== null);
  } catch {
    return [];
  }
}

/** The same conversations without attachment text, for when the full data doesn't fit. */
function withoutAttachmentText(conversations: Conversation[]): Conversation[] {
  return conversations.map((c) => ({
    ...c,
    messages: c.messages.map((m) =>
      m.role === "user" && m.attachment?.content !== undefined
        ? { ...m, attachment: { name: m.attachment.name, size: m.attachment.size, missing: "not_saved" as const } }
        : m,
    ),
  }));
}

/**
 * Saves conversations. Attachment text is kept so later turns (and reloads) can include it;
 * if that exceeds the browser's storage quota, it is saved without attachment text, and
 * after a reload those files show as not saved and must be attached again.
 */
export function saveConversations(conversations: Conversation[]): void {
  try {
    localStorage.setItem(CONVERSATIONS_KEY, JSON.stringify(conversations));
  } catch {
    try {
      localStorage.setItem(CONVERSATIONS_KEY, JSON.stringify(withoutAttachmentText(conversations)));
    } catch {
      // Ignore quota and access errors.
    }
  }
}

export function loadActiveId(): string | null {
  try {
    return localStorage.getItem(ACTIVE_KEY);
  } catch {
    return null;
  }
}

export function saveActiveId(id: string | null): void {
  try {
    if (id) localStorage.setItem(ACTIVE_KEY, id);
    else localStorage.removeItem(ACTIVE_KEY);
  } catch {
    // Ignore quota and access errors.
  }
}
