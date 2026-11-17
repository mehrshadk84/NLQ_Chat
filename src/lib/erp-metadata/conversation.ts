import { normalize } from "@/lib/sql-schema/retrieve";
import type { ApiMessage } from "@/types/chat";

/*
 * What file mode takes from the conversation itself, deterministically: the SQL of earlier turns (so a
 * follow-up keeps its tables), whether the message answers a clarifying question, and the values the
 * user actually stated (so a category filter is never a value the model guessed).
 */

/** SQL of earlier assistant turns ("query" / "query-diagram"), oldest first. */
export function previousSql(messages: ApiMessage[]): string[] {
  return messages.flatMap((m) =>
    m.role === "assistant" ? m.steps.flat().flatMap((o) => ((o.action === "query" || o.action === "query-diagram") && o.sql ? [o.sql] : [])) : [],
  );
}

/** The text of the assistant's clarifying question ("ask") right before message `index`, if there is one. */
function precedingAsk(messages: ApiMessage[], index: number): string | null {
  const previous = messages[index - 1];
  if (previous?.role !== "assistant") return null;
  const asks = previous.steps.at(-1)?.filter((o) => o.action === "ask") ?? [];
  if (!asks.length) return null;
  return asks.map((o) => o.content_blocks.map((b) => (b.type === "list" ? b.items.join(" ") : b.text)).join(" ")).join(" ");
}

/** Whether the last message replies to a clarifying question of the assistant. */
export function answersClarification(messages: ApiMessage[]): boolean {
  return messages.at(-1)?.role === "user" && precedingAsk(messages, messages.length - 1) !== null;
}

const QUOTED = /['"«“‘`]([^'"«»“”‘’`\n]{1,120})['"»”’`]/g;

/**
 * Whether a literal compared with `column` is a value the user gave: quoted in one of their messages
 * ('Blog', «بلاگ»), or part of their reply to a clarifying question that asked about that column. A word
 * used to describe a rule ("ورود" in a definition of punctuality) is not a stored value of some column.
 */
export function userGivenValues(messages: ApiMessage[]): (literal: string, column: string, caption?: string) => boolean {
  const quoted = new Set<string>();
  const replies: { text: string; ask: string }[] = [];
  messages.forEach((m, i) => {
    if (m.role !== "user") return;
    for (const match of m.content.matchAll(QUOTED)) quoted.add(normalize(match[1].trim()));
    const ask = precedingAsk(messages, i);
    if (ask !== null) replies.push({ text: normalize(m.content), ask: normalize(ask) });
  });
  return (literal, column, caption) => {
    const value = normalize(literal.trim());
    if (quoted.has(value)) return true;
    // The question named the column, by its name or its Persian meaning.
    const names = [normalize(column), ...(caption ? [normalize(caption)] : [])];
    return replies.some((reply) => names.some((name) => reply.ask.includes(name)) && reply.text.includes(value));
  };
}
