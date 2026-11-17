import type { OllamaMessage } from "@/lib/ollama";

/*
 * Server-side memory of each chat turn's hidden context: tool calls and results (table
 * structures, context-specific prompts, entity lookups) and backend payloads (procedure and
 * query results). The ERP workflow reuses them in later turns of the same conversation
 * ("session history"), but they never go to the browser, which only keeps the model's own
 * response arrays and the turn id.
 *
 * In memory, per server process: bounded by count, size and age. When a turn is no longer here
 * (server restart, expiry), later turns are built from the browser's copy of the responses and
 * the model fetches what it needs again.
 */

export type StoredMessage = OllamaMessage;

interface StoredConversation {
  turns: Map<string, StoredMessage[]>;
  touched: number;
}

const MAX_CONVERSATIONS = 50;
const MAX_TURNS_PER_CONVERSATION = 40;
const MAX_TURN_CHARS = 400_000;
const TTL_MS = 6 * 60 * 60_000;

const conversations = new Map<string, StoredConversation>();

function prune(now: number) {
  for (const [id, c] of conversations) if (now - c.touched > TTL_MS) conversations.delete(id);
  while (conversations.size > MAX_CONVERSATIONS) {
    const oldest = [...conversations].sort((a, b) => a[1].touched - b[1].touched)[0];
    conversations.delete(oldest[0]);
  }
}

/** Saves a finished turn's messages (everything after the user's message). Oversized turns are not kept. */
export function saveTurn(conversationId: string, turnId: string, messages: StoredMessage[]): void {
  const now = Date.now();
  prune(now);
  const size = messages.reduce((sum, m) => sum + m.content.length + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0), 0);
  if (size > MAX_TURN_CHARS) return;
  const conversation = conversations.get(conversationId) ?? { turns: new Map(), touched: now };
  conversation.turns.set(turnId, messages);
  conversation.touched = now;
  while (conversation.turns.size > MAX_TURNS_PER_CONVERSATION) conversation.turns.delete(conversation.turns.keys().next().value!);
  conversations.set(conversationId, conversation);
}

/** A stored turn of this conversation, if the server still has it. */
export function loadTurn(conversationId: string, turnId: string): StoredMessage[] | undefined {
  const conversation = conversations.get(conversationId);
  if (!conversation) return undefined;
  conversation.touched = Date.now();
  return conversation.turns.get(turnId);
}
