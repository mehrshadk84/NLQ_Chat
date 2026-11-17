import { McpError, type McpSession } from "@/lib/mcp/client";
import { CONTEXT_PROMPT_TOOL, validateArguments, wrapToolText, type OllamaTool, type PreparedTool } from "@/lib/mcp/tools";
import {
  MESSAGE_OVERHEAD_TOKENS,
  OllamaError,
  complete,
  measurePromptTokens,
  messageTokens,
  ollamaConfig,
  type OllamaMessage,
} from "@/lib/ollama";
import { estimateTokens } from "@/lib/tokens";
import type { AssistantStep, ChatStreamEvent, ErpResponse, ErpResponseObject, ExecutedResult, LiveSchemaCheck, TurnOutcome } from "@/types/chat";
import { ACTION_CONTRACTS, ERP_RESPONSE_JSON_SCHEMA, FILE_MODE_RESPONSE_JSON_SCHEMA, pendingRequests } from "./contract";
import { ExecutionError, executionConfig, type ExecutionResult, type Executor, type Row } from "./executor";
import { isKnownDomainSystem } from "./metadata";
import type { LoadedPrompt } from "./prompt";
import { numbersFromRows, numbersIn, presentResult, unsupportedNumbers } from "./results";
import { validateErpTurn } from "./validate";

/*
 * One chat turn of the ERP workflow (FLOW in the prompt), run on the server:
 *
 *   repeat (bounded):
 *     tool step     the model may call MCP tools (context-specific prompts, table structures,
 *                   entity lookups); calls are validated and executed, results go back to it
 *     response      a schema-constrained JSON array, validated (one regeneration if invalid)
 *     backend       requests in the array ("intent", "query", "query-diagram", "resolve-query")
 *                   are executed and returned as a procedure_result BACKEND PAYLOAD message;
 *                   without requests the turn is final
 *
 * When execution is unavailable the turn stops with the requests shown, unanswered: nothing is
 * fabricated. Every step is streamed to the browser; tool results and payloads stay here.
 */

const MAX_WORKFLOW_ROUNDS = 5;
const MAX_TOOL_ROUNDS_PER_STEP = 4;
const MAX_TOOL_CALLS_PER_TURN = 16;
const TOOL_STEP_NUM_PREDICT = 320;
/** Plain text in the tool step means "no tool call": stop reading after this many characters. */
const TOOL_STEP_TEXT_LIMIT = 40;
/** At temperature 0 the same input would reproduce the same invalid output, so the retry samples slightly. */
const RETRY_TEMPERATURE = 0.3;
/** A rejected response is shown back to the model on the retry only up to this size. */
const RETRY_PREVIOUS_MAX_CHARS = 6_000;
/**
 * Regenerations of a rejected response: one for a contract problem; for SQL that doesn't match the
 * schema one more, since each correction carries the verified definitions of the tables it used.
 */
const MAX_REGENERATIONS = 1;
const MAX_SQL_REGENERATIONS = 2;
/** Smallest room that must remain for the conversation after the prompt, tools and the reply. */
const MIN_CONVERSATION_TOKENS = 1_000;

const TOOLS_NOTE =
  "Tool step (application note, not part of your instructions): call now any tool your instructions require before the " +
  "response, for example get_context_specific_prompt or get_table_ai_struct before writing SQL. When no tool call is " +
  "needed, reply with an empty message: your JSON response is requested in the next step.";

/** The prompt names file_search, but no such lookup exists here; the model gets an explicit "unavailable", never a result. */
const FILE_SEARCH_TOOL: OllamaTool = {
  type: "function",
  function: {
    name: "file_search",
    description: "Looks up the id of a text value of a *Type column (rows of columnname, id, text).",
    parameters: { type: "object", properties: { columnname: { type: "string" }, text: { type: "string" } }, required: ["columnname", "text"] },
  },
};
const FILE_SEARCH_UNAVAILABLE = wrapToolText(
  "file_search",
  "file_search is not available in this deployment (no vector store of Type-column values is configured). " +
    "No lookup was performed and no id is known for this value. Do not invent an id.",
);

export const NOTICES = {
  fileSearch: "A Type-column value lookup (file_search) was needed, but it is not supported in this deployment; no id was resolved for it.",
  typeFilter: "This SQL filters on a Type column; its value could not be checked against the Type lookup (file_search is not supported here).",
  truncated: (rows: number, chars: number) => `A result was too large (over ${rows} rows or ${chars} characters); only its first rows were used.`,
} as const;

/** A previous turn as the model sees it: the user message, then the turn's own messages. */
export interface HistoryTurn {
  messages: OllamaMessage[];
  /** How many API messages (user + assistant) the turn came from, for the "omitted" event. */
  apiMessages: number;
}

export interface TurnInput {
  prompt: LoadedPrompt;
  history: HistoryTurn[];
  user: OllamaMessage;
  /** Reference notes sent as extra system messages after the prompt (uploaded schema, tool availability). */
  referenceNotes: string[];
  checkSql?: (sql: string) => string | null;
  /** For a correction after rejected SQL: the verified schema definitions that SQL needs (file mode). */
  repairContext?: (sql: string) => string;
  /** Hybrid: reconciles a validated query with the live database schema before it may run. */
  liveCheck?: (sql: string, signal: AbortSignal) => Promise<LiveSchemaCheck>;
  tools: PreparedTool[];
  callTool?: McpSession["call"];
  executor: Executor | { unavailable: string };
  /** Shown with the turn's first step: facts about this turn's setup (never model text). */
  initialNotices?: string[];
  signal: AbortSignal;
  emit: (event: ChatStreamEvent) => void;
}

export interface TurnResult {
  /** The messages of this turn after the user's message (tool exchange, responses, payloads). */
  messages: OllamaMessage[];
  outcome: TurnOutcome;
}

const toolMessage = (name: string, content: string): OllamaMessage => ({ role: "tool", tool_name: name, content });

function describeToolFailure(error: unknown): string {
  if (error instanceof McpError) {
    switch (error.code) {
      case "auth":
        return "the MCP server rejected the request (authentication missing or invalid)";
      case "timeout":
        return "the tool timed out";
      case "unavailable":
        return "the MCP server could not be reached";
      case "invalid_arguments":
        return "the MCP server rejected the arguments";
      default:
        return "the tool call failed";
    }
  }
  return "the tool call failed";
}

/** Shortens tool-result text until it fits in `maxTokens` (estimated), saying so in the text. */
function fitToolText(name: string, text: string, maxTokens: number): string {
  if (estimateTokens(text) <= maxTokens) return text;
  if (maxTokens < 80) return wrapToolText(name, "[Result not included: no context space left. Do not guess its content.]");
  let keep = text.length;
  let shortened = text;
  while (keep > 0 && estimateTokens(shortened) > maxTokens) {
    keep = Math.floor(keep * 0.8);
    shortened = `${text.slice(0, keep)}\n[truncated to fit the context window]\n>>>`;
  }
  return shortened;
}

/** JSON rows for the model, cut from the end (and marked) when they exceed the character limit. */
function fitRows(result: ExecutionResult): { data: unknown; truncated: boolean } {
  const multiple = result.data.length > 0 && Array.isArray(result.data[0]);
  const sets = (multiple ? (result.data as unknown[][]) : [result.data as unknown[]]).map((set) => [...set]);
  let truncated = result.truncated;
  while (JSON.stringify(sets).length > executionConfig.maxResultChars) {
    const largest = sets.reduce((a, b) => (b.length > a.length ? b : a));
    if (largest.length === 0) break;
    largest.splice(Math.floor(largest.length * 0.8));
    truncated = true;
  }
  return { data: multiple ? sets : sets[0], truncated };
}

/** Every BACKEND PAYLOAD message starts with this (it is the JSON.stringify of the payload object). */
const PAYLOAD_PREFIX = '{"type":"procedure_result"';

const TYPE_FILTER = /\b\w*Type\]?\s*(=|<>|!=|\bIN\b|\bLIKE\b)/i;

/** Cache key of a (DomainSchema, SystemSchema) pair; system null is its own pair. */
const pairKey = (domain: unknown, system: unknown) => `${String(domain).toLowerCase()}/${system === null ? "null" : String(system).toLowerCase()}`;

/** Tool definitions sent to the model: the offered MCP tools plus the file_search stub. */
export const toolDefinitionsFor = (tools: PreparedTool[]): OllamaTool[] => (tools.length ? [...tools.map((t) => t.definition), FILE_SEARCH_TOOL] : []);

export interface ErpBudget {
  /** The prompt alone and with the tool definitions, for the configured model. */
  promptTokens: number;
  withTools: number;
  /** Tokens left for notes, history, the message and the turn's exchange after the prompt, tools and reserved reply. */
  available: number;
  /** Both counts come from Ollama (the model's own tokenizer and template), not from the estimate. */
  exact: boolean;
}

/**
 * Token budget of a turn from Ollama's own counts of the prompt, alone and with the tool definitions
 * (which the chat template renders into the system block), minus OLLAMA_NUM_PREDICT for the reply.
 * Only exact counts can reject a request here: when the prompt and tools really leave too little room,
 * this throws `context_overflow` with the counted numbers. Connection failures propagate as such.
 */
export async function erpBudget(prompt: LoadedPrompt, toolDefinitions: OllamaTool[]): Promise<ErpBudget> {
  const base = await measurePromptTokens(prompt.text);
  const tools = toolDefinitions.length ? await measurePromptTokens(prompt.text, toolDefinitions) : base;
  const exact = base.exact && tools.exact;
  const available = ollamaConfig.numCtx - ollamaConfig.numPredict - tools.tokens - 2 * MESSAGE_OVERHEAD_TOKENS;
  if (exact && (tools.overflow || available < MIN_CONVERSATION_TOKENS)) {
    throw new OllamaError(
      "context_overflow",
      `ERP prompt ${base.tokens} tokens, with tools ${tools.tokens} (counted by Ollama for ${ollamaConfig.model}), reply ${ollamaConfig.numPredict}, num_ctx ${ollamaConfig.numCtx}`,
      `the ERP system prompt and tool definitions use ${tools.tokens} tokens (counted by Ollama for ${ollamaConfig.model}); with ${ollamaConfig.numPredict} reserved for the reply, ` +
        `too little of the ${ollamaConfig.numCtx}-token context window is left. Increase OLLAMA_NUM_CTX`,
    );
  }
  if (!exact) console.warn(`[erp] token budget is ESTIMATED (Ollama gave no count): ${tools.tokens} tokens; Ollama will refuse the request itself if it doesn't fit`);
  return { promptTokens: base.tokens, withTools: tools.tokens, available: Math.max(0, available), exact };
}

/**
 * The field contract of the action a rejection names ("[0] answer: …"), for the retry note: the model
 * learns what that action may and may not contain, not only that something was wrong.
 */
function contractFor(reason: string): string {
  const action = /^\[\d+\] ([a-z-]+)[:.]/.exec(reason)?.[1] as keyof typeof ACTION_CONTRACTS | undefined;
  return action && action in ACTION_CONTRACTS ? `Field rules: ${ACTION_CONTRACTS[action]} ` : "";
}

/**
 * Hybrid: what an answer may state once rows have arrived. Allowed numbers are the values in the
 * session's returned rows (and their row counts and column sums), the numbers the user wrote, and the
 * numbers in the executed SQL (dates, limits); percentages must be ratios of those.
 */
function answerChecker(messages: OllamaMessage[]): (text: string) => string | null {
  const allowed: number[] = [];
  for (const m of messages) {
    if (m.role === "user" && m.content.startsWith(PAYLOAD_PREFIX)) {
      try {
        for (const r of (JSON.parse(m.content) as { results?: { data?: unknown; row_count?: unknown; sql?: unknown }[] }).results ?? []) {
          const sets = Array.isArray(r.data) && Array.isArray(r.data[0]) ? (r.data as Row[][]) : [Array.isArray(r.data) ? (r.data as Row[]) : []];
          for (const rows of sets) allowed.push(...numbersFromRows(rows));
          if (typeof r.row_count === "number") allowed.push(r.row_count);
          if (typeof r.sql === "string") allowed.push(...numbersIn(r.sql).map((n) => n.value));
        }
      } catch {
        // Not a payload.
      }
    } else if (m.role === "user") {
      allowed.push(...numbersIn(m.content).map((n) => n.value));
    }
  }
  return (text) => unsupportedNumbers(text, allowed);
}

/** The SQL of a rejected response (its "query" objects), for the repair context. */
function rejectedSql(raw: string): string {
  try {
    const parsed: unknown = JSON.parse(raw);
    return (Array.isArray(parsed) ? parsed : [])
      .map((o) => (typeof o === "object" && o !== null && typeof (o as { sql?: unknown }).sql === "string" ? (o as { sql: string }).sql : ""))
      .join("\n");
  } catch {
    return "";
  }
}

export async function runErpTurn(input: TurnInput): Promise<TurnResult> {
  const { prompt, signal, emit } = input;
  const mode = prompt.mode;
  if (mode === "mcp-agent") throw new Error("MCP Agent mode has its own pipeline (src/lib/mcp-agent)");
  const metadata = prompt.metadata;
  const system: OllamaMessage = { role: "system", content: prompt.text };
  const notes: OllamaMessage[] = input.referenceNotes.map((content) => ({ role: "system", content }));
  const offered = input.callTool ? input.tools : [];
  const toolDefinitions = toolDefinitionsFor(offered);
  const describeSystem = `${prompt.label} OK (sha256 ${prompt.sha256.slice(0, 12)}, ${prompt.text.length} chars, sent unchanged)`;

  const { available } = await erpBudget(prompt, toolDefinitions);

  const exchange: OllamaMessage[] = [];
  let omittedReported = 0;

  /** The full request: prompt, notes, as much history as fits (whole turns, newest first), then this turn. */
  const assemble = (extraNotes: OllamaMessage[] = []): OllamaMessage[] => {
    // The turn itself (message, tool results, payloads) is never dropped. Its size here is the
    // conservative estimate, which is not a reason to refuse: when it looks too large, the request is
    // sent without history and Ollama, which counts exactly and has truncate: false, refuses it if it
    // really exceeds num_ctx. History is trimmed on the estimate, whole turns, oldest first.
    const required = [...notes, ...extraNotes, input.user, ...exchange].reduce((sum, m) => sum + messageTokens(m), 0);
    if (required > available) {
      console.warn(`[erp] this turn is ESTIMATED at ~${required} tokens, over the ~${available} left; sending without history for Ollama's exact check`);
    }
    let budget = Math.max(0, available - required);
    const turnLimit = Math.max(0, Math.floor(ollamaConfig.historyLimit / 2));
    const kept: HistoryTurn[] = [];
    for (let i = input.history.length - 1; i >= 0 && kept.length < turnLimit; i--) {
      const cost = input.history[i].messages.reduce((sum, m) => sum + messageTokens(m), 0);
      if (cost > budget) break;
      budget -= cost;
      kept.unshift(input.history[i]);
    }
    const omitted = input.history.slice(0, input.history.length - kept.length).reduce((sum, t) => sum + t.apiMessages, 0);
    if (omitted > omittedReported) {
      omittedReported = omitted;
      emit({ type: "context", omitted });
    }
    return [system, ...notes, ...extraNotes, ...kept.flatMap((t) => t.messages), input.user, ...exchange];
  };

  let toolCalls = 0;
  let pendingNotices = new Set<string>(input.initialNotices ?? []);

  /** Earlier messages of this conversation and this turn, oldest first. */
  const sessionMessages = () => [...input.history.flatMap((t) => t.messages), input.user, ...exchange];

  /** Procedures whose results arrived in a BACKEND PAYLOAD this session (for the initial-procedure gate). */
  const receivedProcedures = () => {
    const names = new Set<string>();
    for (const m of sessionMessages()) {
      if (m.role !== "user" || !m.content.startsWith(PAYLOAD_PREFIX)) continue;
      try {
        for (const r of (JSON.parse(m.content) as { results?: { procedure?: unknown }[] }).results ?? []) {
          if (typeof r.procedure === "string") names.add(r.procedure.toLowerCase());
        }
      } catch {
        // Not a payload.
      }
    }
    return names;
  };

  /** get_context_specific_prompt results of this session, by exact (domain, system) pair. */
  const contextPromptCache = () => {
    const cache = new Map<string, string>();
    const messages = sessionMessages();
    for (const [i, m] of messages.entries()) {
      if (m.role !== "assistant" || !m.tool_calls) continue;
      // Tool results follow their assistant message in call order.
      m.tool_calls.forEach((call, k) => {
        const result = messages[i + 1 + k];
        const args = call.function.arguments as { domain?: unknown; system?: unknown } | undefined;
        if (call.function.name !== CONTEXT_PROMPT_TOOL || result?.role !== "tool" || result.tool_name !== CONTEXT_PROMPT_TOOL) return;
        if (result.content.includes("Tool call rejected") || result.content.includes("Tool call failed")) return;
        cache.set(pairKey(args?.domain, args?.system ?? null), result.content);
      });
    }
    return cache;
  };

  /** Lets the model call tools until it stops asking (bounded); appends the exchange. */
  const toolStep = async () => {
    if (!toolDefinitions.length || !input.callTool) return;
    // Per the prompt, every tool use builds on a map that has already arrived: the Query schema
    // (context-specific prompts, table structures, entity lookups for SQL) or an intent's Initial
    // data (parameter resolution). Before any such result, tools only invite guessed identifiers.
    const received = receivedProcedures();
    if (![...metadata.procedures.values()].some((p) => p.initial && received.has(p.procedure.toLowerCase()))) return;
    const byName = new Map(offered.map((t) => [t.name, t]));
    const note: OllamaMessage = { role: "system", content: TOOLS_NOTE };
    for (let round = 0; round < MAX_TOOL_ROUNDS_PER_STEP && toolCalls < MAX_TOOL_CALLS_PER_TURN; round++) {
      emit({ type: "progress", stage: "tools" });
      const { toolCalls: requested } = await complete({
        messages: assemble([note]),
        temperature: 0,
        signal,
        tools: toolDefinitions,
        numPredict: TOOL_STEP_NUM_PREDICT,
        describeSystem,
        stopAfterTextChars: TOOL_STEP_TEXT_LIMIT,
      });
      if (requested.length === 0) return;
      const batch = requested.slice(0, MAX_TOOL_CALLS_PER_TURN - toolCalls);
      exchange.push({ role: "assistant", content: "", tool_calls: batch });
      for (const call of batch) {
        toolCalls++;
        const name = call.function.name;
        const results = (text: string) => {
          const used = [...notes, input.user, ...exchange].reduce((sum, m) => sum + messageTokens(m), 0);
          exchange.push(toolMessage(name, fitToolText(name, text, available - used - MESSAGE_OVERHEAD_TOKENS)));
        };
        if (name === "file_search") {
          console.info("[erp] file_search requested: not supported, answered as unavailable");
          pendingNotices.add(NOTICES.fileSearch);
          results(FILE_SEARCH_UNAVAILABLE);
          continue;
        }
        const tool = byName.get(name);
        if (!tool) {
          console.warn(`[mcp] rejected call to unavailable tool "${name.slice(0, 64)}"`);
          results(wrapToolText(name, `Tool call rejected: "${name}" is not an available tool. Nothing was executed.`));
          continue;
        }
        const args = validateArguments(tool, call.function.arguments);
        if (!args.ok) {
          console.warn(`[mcp] rejected call to ${name}: ${args.error}`);
          results(wrapToolText(name, `Tool call rejected: ${args.error}. Nothing was executed.`));
          continue;
        }
        if (name === CONTEXT_PROMPT_TOOL) {
          if (!isKnownDomainSystem(metadata, args.value.domain, args.value.system)) {
            const reason = "this domain/system combination is not in the ERP domains and systems list";
            // Domain/system codes are public identifiers from the prompt, not data: logged for diagnosis.
            console.warn(`[mcp] rejected call to ${name} (${String(args.value.domain).slice(0, 8)}, ${String(args.value.system).slice(0, 16)}): ${reason}`);
            results(wrapToolText(name, `Tool call rejected: ${reason}. Nothing was executed; do not invent its guidance.`));
            continue;
          }
          // Session cache by the exact (DomainSchema, SystemSchema) pair: an earlier result for this
          // same pair in the conversation is reused; any other pair is fetched.
          const cached = contextPromptCache().get(pairKey(args.value.domain, args.value.system));
          if (cached !== undefined) {
            console.info(`[mcp] ${name}: reused the session's result for the same domain/system pair`);
            results(cached);
            continue;
          }
        }
        try {
          results((await input.callTool(tool, args.value, signal)).text);
        } catch (error) {
          if (signal.aborted) throw error;
          results(wrapToolText(name, `Tool call failed: ${describeToolFailure(error)}. No data was returned; do not invent results.`));
        }
      }
    }
  };

  /** A schema-constrained response, validated; a bounded number of regenerations if invalid. */
  const respond = async (): Promise<ErpResponse> => {
    emit({ type: "progress", stage: "generating" });
    const messages = assemble();
    const received = receivedProcedures();
    const dataReceived = sessionMessages().some((m) => m.role === "user" && m.content.startsWith(PAYLOAD_PREFIX));
    // Hybrid: once rows have arrived, an answer may state only numbers they (or the user, or the SQL) contain.
    const checkAnswer = prompt.mode === "hybrid" && dataReceived ? answerChecker(sessionMessages()) : undefined;
    let raw = "";
    const attempt = async (request: OllamaMessage[], temperature: number) => {
      const format = prompt.mode === "mcp" ? ERP_RESPONSE_JSON_SCHEMA : FILE_MODE_RESPONSE_JSON_SCHEMA;
      raw = (await complete({ messages: request, temperature, signal, format, numPredict: ollamaConfig.numPredict, describeSystem })).content;
      return validateErpTurn(raw, metadata, { checkSql: input.checkSql, receivedProcedures: received, dataReceived, mode, checkAnswer });
    };
    let result = await attempt(messages, ollamaConfig.temperature);
    for (let regeneration = 1; !result.ok; regeneration++) {
      const limit = result.sqlProblem ? MAX_SQL_REGENERATIONS : MAX_REGENERATIONS;
      if (regeneration > limit) {
        const detail = `Invalid response after ${limit} regeneration${limit > 1 ? "s" : ""}: ${result.reason}`;
        if (result.sqlProblem) throw new OllamaError("ungrounded_sql", detail, result.sqlProblem);
        throw new OllamaError("invalid_reply", detail, result.reason.slice(0, 300));
      }
      console.warn(`[erp] invalid response, regenerating (${regeneration}/${limit}) with the reason: ${result.reason}`);
      emit({ type: "status", state: "retrying" });
      // Each regeneration states why the latest response was rejected (the same input alone tends to
      // reproduce the same mistake), with that response when it is short enough, and for SQL that doesn't
      // match the schema the verified definitions of the tables it used.
      const previous: OllamaMessage[] = raw.length <= RETRY_PREVIOUS_MAX_CHARS ? [{ role: "assistant", content: raw }] : [];
      const repair = result.sqlProblem && input.repairContext ? input.repairContext(rejectedSql(raw)) : "";
      const correction: OllamaMessage = {
        role: "system",
        content:
          `Application note: the backend rejected your previous response${previous.length ? "" : " (too long to repeat here)"}: ` +
          `${result.reason.slice(0, 1_200)}. ${contractFor(result.reason)}` +
          (repair
            ? `\n\n${repair}\n\nUse only these tables, columns and relationships. If none of them represents what the user asked for, ` +
              `return "ask" that says what is missing instead of SQL.\n\n`
            : "") +
          "Return a corrected JSON array that follows your instructions.",
      };
      const room = available - [...notes, input.user, ...exchange].reduce((sum, m) => sum + messageTokens(m), 0);
      const fits = (extra: OllamaMessage[]) => extra.reduce((sum, m) => sum + messageTokens(m), 0) <= room;
      const extra = [...previous, correction];
      result = await attempt(fits(extra) ? [...messages, ...extra] : fits([correction]) ? [...messages, correction] : messages, RETRY_TEMPERATURE);
    }
    return result.response;
  };

  /** Runs the requests and builds the BACKEND PAYLOAD (MESSAGE TYPES in the prompt) and the results shown. */
  const execute = async (executor: Executor, requests: ErpResponseObject[]) => {
    const results: Record<string, unknown>[] = [];
    const shown: ExecutedResult[] = [];
    let truncated = false;
    for (const request of requests) {
      if (request.action === "intent") {
        for (const call of request.procedures) {
          const procedure = metadata.procedures.get(call.procedure.toLowerCase());
          // Validation already required this; never run a name that isn't in the allowlist.
          if (!procedure) throw new ExecutionError(`procedure ${call.procedure} is not in the intent list`);
          const rows = fitRows(await executor.runProcedure(procedure, call.parameters, signal));
          truncated ||= rows.truncated;
          results.push({ procedure: procedure.procedure, parameters: call.parameters, sql: null, data: rows.data, resolves: null, ...(rows.truncated && { truncated: true }) });
        }
      } else {
        const result = await executor.runSelect(request.sql, signal);
        const rows = fitRows(result);
        truncated ||= rows.truncated;
        const presented = presentResult(request.sql, result, request.action === "query-diagram" ? request.chart.chart_type || "vertical-bar" : null);
        shown.push(presented);
        results.push({
          procedure: null,
          parameters: null,
          sql: request.sql,
          row_count: presented.rowCount,
          data: rows.data,
          resolves: request.action === "resolve-query" ? request.resolves : null,
          ...(rows.truncated && { truncated: true }),
        });
      }
    }
    const intents = [...new Set(requests.map((r) => r.intent).filter(Boolean))].join(", ");
    return { payload: { type: "procedure_result", intent: intents, results }, truncated, shown };
  };

  /**
   * Hybrid: every query of the step is reconciled with the live schema before anything runs. The
   * first mismatch or failure decides; all verified tables are reported together.
   */
  const checkLive = async (requests: ErpResponseObject[]): Promise<LiveSchemaCheck | undefined> => {
    if (!input.liveCheck) return undefined;
    const tables: string[] = [];
    for (const request of requests) {
      if (request.action !== "query" && request.action !== "query-diagram") continue;
      const check = await input.liveCheck(request.sql, signal);
      if (check.status !== "verified") return check;
      tables.push(...check.tables.filter((t) => !tables.includes(t)));
    }
    return { status: "verified", tables };
  };

  for (let round = 0; round < MAX_WORKFLOW_ROUNDS; round++) {
    await toolStep();
    const response = await respond();
    exchange.push({ role: "assistant", content: JSON.stringify(response) });

    const requests = pendingRequests(response);
    // One file_search notice is enough: the generic one only when the model never asked for the lookup.
    // File mode checks category values itself (only values the user gave pass); there is no lookup to mention.
    if (prompt.mode === "mcp" && !pendingNotices.has(NOTICES.fileSearch) && requests.some((r) => r.sql && TYPE_FILTER.test(r.sql))) pendingNotices.add(NOTICES.typeFilter);
    const step: AssistantStep = { response };
    const finish = (outcome: TurnOutcome): TurnResult => {
      if (pendingNotices.size) step.notices = [...pendingNotices];
      emit({ type: "step", step });
      return { messages: exchange, outcome };
    };
    if (requests.length === 0) return finish("final");

    // Hybrid: the live schema is checked even when execution is off (it is part of validating the SQL).
    if (input.liveCheck) emit({ type: "progress", stage: "checking" });
    const live = await checkLive(requests);
    if (live) {
      step.liveSchema = live;
      console.info(`[erp] live schema: ${live.status}${live.status === "verified" ? ` (${live.tables.length} tables)` : `: ${live.reason}`}`);
    }
    if (live?.status === "mismatch") {
      step.execution = { status: "unavailable", reason: `not run, because ${live.reason}` };
      return finish("execution_unavailable");
    }
    if ("unavailable" in input.executor) {
      step.execution = { status: "unavailable", reason: input.executor.unavailable };
      console.info(`[erp] ${requests.length} backend request(s) not executed: ${input.executor.unavailable}`);
      return finish("execution_unavailable");
    }
    if (live?.status === "unavailable") {
      step.execution = { status: "unavailable", reason: `not run, because the live database schema could not be checked (${live.reason})` };
      return finish("execution_unavailable");
    }
    emit({ type: "progress", stage: "executing" });
    let payload;
    let shown: ExecutedResult[] = [];
    try {
      const executed = await execute(input.executor, requests);
      payload = executed.payload;
      shown = executed.shown;
      if (executed.truncated) pendingNotices.add(NOTICES.truncated(executionConfig.maxRows, executionConfig.maxResultChars));
    } catch (error) {
      if (signal.aborted) throw error;
      const reason = error instanceof ExecutionError ? error.message : "the backend request failed";
      console.warn(`[erp] execution failed: ${reason}`);
      step.execution = { status: "failed", reason };
      return finish("execution_failed");
    }
    step.execution = { status: "executed", requests: requests.length, ...(shown.length && { results: shown }) };
    if (pendingNotices.size) step.notices = [...pendingNotices];
    emit({ type: "step", step });
    pendingNotices = new Set();
    exchange.push({ role: "user", content: JSON.stringify(payload) });
  }
  console.warn(`[erp] workflow stopped after ${MAX_WORKFLOW_ROUNDS} rounds`);
  return { messages: exchange, outcome: "step_limit" };
}
