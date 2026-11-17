import type { PreparedTool } from "@/lib/mcp/tools";
import { numbersIn } from "@/lib/erp/results";
import type { ContentBlock, ErpResponseObject } from "@/types/chat";

/*
 * MCP Agent mode rules that need no I/O: which tools a message names, whether a model-chosen argument
 * value comes from the conversation, whether a reply is a tool call written as text, and how the final
 * text is shown. Kept separate from the loop so each rule can be tested on its own.
 */

/** Persian/Arabic digits and letter variants unified, ZWNJ as a space, lowercase, single spaces. */
export function normalize(text: string): string {
  return text
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/ي/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/‌/g, " ")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Words that look like tool names: snake_case identifiers such as get_form_types. */
const TOOL_LIKE = /(?<![A-Za-z0-9_.])[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+(?![A-Za-z0-9_]|\.[A-Za-z])/g;
/** An unknown snake_case word counts as a tool request only when it reads like one (get_…, run_…). */
const VERB_PREFIX = /^(get|list|run|set|create|update|delete|add|remove|exec|execute|fetch|find|search|query|insert|send|call)_/i;

export interface MentionedTools {
  /** Named tools that exist and are offered: the user asked for them explicitly. */
  requested: string[];
  /** Named tools the server has but this assistant may not use. */
  unauthorized: string[];
  /** Tool-like names the server doesn't have. */
  unknown: string[];
}

/** The tools a user message names, split by whether they exist and are offered. */
export function mentionedTools(text: string, discovered: string[], offered: string[]): MentionedTools {
  const result: MentionedTools = { requested: [], unauthorized: [], unknown: [] };
  for (const [word] of text.matchAll(TOOL_LIKE)) {
    const list = offered.includes(word) ? result.requested : discovered.includes(word) ? result.unauthorized : VERB_PREFIX.test(word) ? result.unknown : null;
    if (list && !list.includes(word)) list.push(word);
  }
  return result;
}

/**
 * Tools the previous turn tried to call but couldn't (a missing, empty or made-up argument) and never
 * ran: the model then asked the user, so this message is probably the answer to that question.
 */
export function awaitingArguments(previousTurn: { role: string; tool_name?: string; content: string }[]): string[] {
  const rejected = (m: { content: string }) => m.content.startsWith("Tool call rejected");
  const names = previousTurn.filter((m) => m.role === "tool" && m.tool_name && rejected(m)).map((m) => m.tool_name!);
  return [...new Set(names)].filter((name) => !previousTurn.some((m) => m.role === "tool" && m.tool_name === name && !rejected(m)));
}

/** Parts of identifiers that say nothing about what is meant (schema prefixes, "tbl"). */
const GENERIC_PARTS = new Set(["tbl", "gnd", "dbo", "vw", "sp", "the", "and", "for"]);

/** Meaningful lowercase parts of an identifier-like value: gnd_hrprs.tblEmployee → hrprs, employee. */
function valueParts(value: string): string[] {
  return value
    .split(/[^A-Za-z0-9؀-ۿ]+/)
    .flatMap((part) => part.split(/(?<=[a-z])(?=[A-Z])/))
    .map((part) => normalize(part))
    .filter((part) => part.length >= 3 && !GENERIC_PARTS.has(part));
}

export interface GroundingContext {
  /** Everything the conversation contains: user messages, earlier answers, tool results (normalized). */
  conversation: string;
  /** The user's own messages only (normalized). */
  userText: string;
}

/**
 * Why a model-chosen argument value is not backed by the conversation, or null. A value is backed when
 * it appears in the conversation (a user message, an earlier answer, a tool result), when it is quoted
 * in the tool's or parameter's description (a documented constant such as "form"), or, for text, when
 * one of its meaningful parts appears in the user's own messages ("employee table" → gnd_hrprs.tblEmployee).
 * Anything else was made up by the model: the call is refused and the model is told to ask.
 */
export function groundingProblem(tool: PreparedTool, args: Record<string, unknown>, context: GroundingContext): string | null {
  const documented = normalize(`${tool.definition.function.description} ${[...tool.parameters.values()].map((p) => p.description ?? "").join(" ")}`);
  for (const [name, value] of Object.entries(args)) {
    if (value === null || typeof value === "boolean") continue;
    if (typeof value === "number") {
      const pattern = new RegExp(`(^|[^0-9.])${String(value).replace(".", "\\.")}([^0-9]|$)`);
      if (!pattern.test(context.conversation)) return `the value ${value} for "${name}" doesn't appear in the user's messages or in an earlier tool result`;
      continue;
    }
    if (typeof value !== "string") continue;
    const v = normalize(value);
    if (!v) return `"${name}" is empty`;
    if (context.conversation.includes(v) || documented.includes(`"${v}"`)) continue;
    // Singular or plural of the user's word ("employee" → "Employees").
    if (valueParts(value).some((part) => context.userText.includes(part) || (part.length > 4 && context.userText.includes(part.replace(/(es|s)$/, ""))))) continue;
    return `the value "${value.slice(0, 80)}" for "${name}" doesn't come from the user's messages or an earlier tool result`;
  }
  return null;
}

/** Same call: the tool name and its arguments with keys in a fixed order. */
export function callKey(name: string, args: Record<string, unknown>): string {
  return `${name} ${JSON.stringify(Object.keys(args).sort().map((k) => [k, args[k]]))}`;
}

/**
 * Whether a text reply is a tool call written out as text (JSON with a tool name and arguments, or a
 * <tool_call> tag) instead of a native tool call. Such text is never executed.
 */
export function looksLikeTextToolCall(content: string, toolNames: string[]): boolean {
  if (/<\/?(tool_call|function_call|tools?)>/i.test(content)) return true;
  const named = /"(?:name|function|tool)"\s*:\s*"([A-Za-z0-9_.-]+)"/.exec(content);
  return !!named && toolNames.includes(named[1]) && /"(arguments|parameters|args)"\s*:/.test(content);
}

/** Numbers an answer may state: those in tool results, arguments and the user's messages, plus list sizes. */
export function allowedNumbers(texts: string[]): number[] {
  const numbers: number[] = [];
  for (const text of texts) {
    numbers.push(...numbersIn(text).map((n) => n.value));
    try {
      const counts = (value: unknown): void => {
        if (Array.isArray(value)) {
          numbers.push(value.length);
          value.forEach(counts);
        } else if (value && typeof value === "object") Object.values(value).forEach(counts);
      };
      counts(JSON.parse(text));
    } catch {
      // Not JSON.
    }
  }
  return numbers;
}

const MAX_BLOCKS = 100;
const MAX_BLOCK_TEXT = 8_000;

/**
 * The model's final text as answer blocks for the chat (the same renderer as other modes): "#"
 * headings, "-"/"*"/"1." list lines as lists, everything else as paragraphs that keep their line
 * breaks (so tables and code stay readable). Bold markers are dropped; nothing else is changed.
 */
export function textToBlocks(text: string): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  let paragraph: string[] = [];
  let items: string[] = [];
  const flush = () => {
    const joined = paragraph.join("\n").trim();
    for (let i = 0; i < joined.length; i += MAX_BLOCK_TEXT) blocks.push({ type: "paragraph", text: joined.slice(i, i + MAX_BLOCK_TEXT) });
    paragraph = [];
    if (items.length) blocks.push({ type: "list", items: items.map((item) => item.slice(0, MAX_BLOCK_TEXT)) });
    items = [];
  };
  for (const raw of text.replace(/\r\n?/g, "\n").replace(/\*\*(.+?)\*\*/g, "$1").split("\n")) {
    const heading = /^(#{1,3})\s+(.+?)\s*#*\s*$/.exec(raw);
    const item = /^\s*(?:[-*•]|\d+[.)])\s+(.+)$/.exec(raw);
    if (heading) {
      flush();
      blocks.push({ type: `h${heading[1].length}` as "h1" | "h2" | "h3", text: heading[2].slice(0, MAX_BLOCK_TEXT) });
    } else if (item) {
      // A paragraph line always closes an open list first, so here only the paragraph is pending.
      if (paragraph.length) flush();
      items.push(item[1].trim());
    } else if (!raw.trim()) {
      flush();
    } else {
      if (items.length) flush();
      paragraph.push(raw);
    }
  }
  flush();
  if (blocks.length <= MAX_BLOCKS) return blocks;
  return [...blocks.slice(0, MAX_BLOCKS - 1), { type: "paragraph", text: blocksText(blocks.slice(MAX_BLOCKS - 1)).slice(0, MAX_BLOCK_TEXT) }];
}

const EMPTY = {
  content: "",
  content_blocks: [],
  intent: "",
  procedures: [],
  sql: "",
  chart: { chart_type: "" as const, title: "", categories: [], series: [] },
  resolves: { intent: "", procedure: "", parameter: "" },
};

/** The response object shown for a final text (an "answer"), or an "error" with the backend's message. */
export const answerObject = (text: string): ErpResponseObject => ({ ...EMPTY, action: "answer", content_blocks: textToBlocks(text) });
export const errorObject = (message: string): ErpResponseObject => ({ ...EMPTY, action: "error", content: message.slice(0, MAX_BLOCK_TEXT) });

/** The plain text of answer blocks, as earlier turns are shown to the model when the server no longer has them. */
export function blocksText(blocks: ContentBlock[]): string {
  return blocks.map((b) => (b.type === "list" ? b.items.map((item) => `- ${item}`).join("\n") : b.type === "link" ? `${b.text} (${b.url})` : b.text)).join("\n\n");
}
