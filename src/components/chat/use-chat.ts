"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { readErpResponse } from "@/lib/erp/contract";
import type { ApiMessage, AssistantStep, ChatErrorBody, ChatMessage, ChatStreamEvent, Conversation, ProgressStage, ToolCallRecord, TurnOutcome } from "@/types/chat";
import { deleteSchema, pruneSchemas } from "./schema-store";
import { loadActiveId, loadConversations, saveActiveId, saveConversations, toToolCall } from "./storage";

/** A turn being generated. Only the completed turn is added to the conversation. */
export interface PendingReply {
  conversationId: string;
  /** The last output was invalid and the server is regenerating it once. */
  retrying: boolean;
  /** What the server is doing now. */
  stage: ProgressStage | null;
  /** Validated steps received so far (shown as progress). */
  steps: AssistantStep[];
  /** MCP Agent mode: tool calls of this turn so far (running or finished). */
  toolCalls: ToolCallRecord[];
}

/** A TXT file chosen in the composer and already validated there. */
export interface DraftAttachment {
  file: File;
  name: string;
  size: number;
  text: string;
}

const TITLE_LENGTH = 48;

function createId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function makeTitle(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > TITLE_LENGTH ? `${line.slice(0, TITLE_LENGTH).trimEnd()}…` : line;
}

/**
 * Assistant turns go back as their validated response arrays and turn id (the server keeps the
 * turn's tool results and backend data under that id). User turns carry their attachment's text
 * while it's available. Error and legacy messages were never validated ERP responses and are
 * not sent. `ids` maps each sent message back to its chat message.
 */
function toApiMessages(messages: ChatMessage[]): { apiMessages: ApiMessage[]; ids: string[] } {
  const apiMessages: ApiMessage[] = [];
  const ids: string[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      const file = m.attachment?.content !== undefined ? { name: m.attachment.name, content: m.attachment.content } : null;
      if (!m.content.trim() && !file) continue;
      apiMessages.push(file ? { role: "user", content: m.content, attachment: file } : { role: "user", content: m.content });
    } else if (m.role === "assistant" && m.steps.length > 0) {
      apiMessages.push({ role: "assistant", turnId: m.turnId, steps: m.steps.map((s) => s.response) });
    } else {
      continue;
    }
    ids.push(m.id);
  }
  return { apiMessages, ids };
}

async function readError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as Partial<ChatErrorBody>;
    if (typeof body.error === "string" && body.error) return body.error;
  } catch {
    // Not JSON; fall through.
  }
  return "Something went wrong. Please try again.";
}

const STAGES: readonly ProgressStage[] = ["tools", "generating", "checking", "executing"];
const OUTCOMES: readonly TurnOutcome[] = ["final", "execution_unavailable", "execution_failed", "step_limit"];

function parseEvent(line: string): ChatStreamEvent | null {
  try {
    const event = JSON.parse(line) as ChatStreamEvent;
    if (event.type === "status" && (event.state === "generating" || event.state === "retrying")) return event;
    if (event.type === "progress" && STAGES.includes(event.stage)) return event;
    if (event.type === "context" && Number.isInteger(event.omitted) && event.omitted > 0) return event;
    if (event.type === "step" && readErpResponse(event.step?.response).ok) return event;
    if (event.type === "tool" && toToolCall(event.call)) return event;
    if (event.type === "done" && typeof event.turnId === "string" && OUTCOMES.includes(event.outcome)) return event;
    if (event.type === "error" && typeof event.error === "string") return event;
  } catch {
    // Fall through.
  }
  return null;
}

/** Reads `/api/chat`'s newline-delimited JSON events. */
async function* readEvents(body: NonNullable<Response["body"]>): AsyncGenerator<ChatStreamEvent> {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const event = parseEvent(line);
      if (!event) throw new Error("Malformed stream event");
      yield event;
    }
  }
}

/** Marks the attachments of the given messages as no longer in the model's context. */
function dropAttachments(messages: ChatMessage[], ids: Set<string>): ChatMessage[] {
  return messages.map((m) =>
    m.role === "user" && m.attachment?.content !== undefined && ids.has(m.id)
      ? { ...m, attachment: { name: m.attachment.name, size: m.attachment.size, missing: "out_of_context" } }
      : m,
  );
}

/** Must be rendered on the client only: initial state is read from localStorage. */
export function useChat() {
  const [conversations, setConversations] = useState<Conversation[]>(loadConversations);
  const [activeId, setActiveId] = useState<string | null>(() => {
    const id = loadActiveId();
    return id && conversations.some((c) => c.id === id) ? id : null;
  });
  const [pending, setPending] = useState<PendingReply | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [startupIds] = useState(() => new Set(conversations.map((c) => c.id)));

  useEffect(() => saveConversations(conversations), [conversations]);
  // Schemas of conversations deleted while IndexedDB was unavailable.
  useEffect(() => void pruneSchemas(startupIds).catch(() => {}), [startupIds]);
  useEffect(() => saveActiveId(activeId), [activeId]);
  useEffect(() => () => abortRef.current?.abort(), []);

  /**
   * Sends a message with an optional TXT file. Resolves to an error message when the server
   * rejects the request before generating (invalid file, too large for the context, busy);
   * the message is then removed again so the composer can restore the draft. Otherwise
   * resolves to null once the reply or an error has been added to the conversation.
   */
  const send = useCallback(
    async (text: string, draft?: DraftAttachment, schema?: { name: string; text: string }): Promise<string | null> => {
      // The ref is set synchronously, so double clicks or Enter repeats can't start a second request.
      if ((!text.trim() && !draft) || abortRef.current) return null;
      const controller = new AbortController();
      abortRef.current = controller;

      const existing = conversations.find((c) => c.id === activeId);
      const conversationId = existing?.id ?? createId();
      const userMessage: ChatMessage = {
        id: createId(),
        role: "user",
        content: text.trim(),
        ...(draft && { attachment: { name: draft.name, size: draft.size, content: draft.text } }),
      };
      const { apiMessages, ids } = toApiMessages([...(existing?.messages ?? []), userMessage]);
      // The current file is uploaded as-is and decoded by the server, not sent as text.
      apiMessages[apiMessages.length - 1] = { role: "user", content: userMessage.content };

      setConversations((prev) => [
        {
          id: conversationId,
          // A conversation created for a schema upload is still titled after its first message.
          title: existing?.messages.length ? existing.title : makeTitle(userMessage.content || draft?.name || existing?.title || "New chat"),
          messages: [...(existing?.messages ?? []), userMessage],
          updatedAt: Date.now(),
        },
        ...prev.filter((c) => c.id !== conversationId),
      ]);
      setActiveId(conversationId);
      setPending({ conversationId, retrying: false, stage: null, steps: [], toolCalls: [] });

      const updateMessages = (update: (messages: ChatMessage[]) => ChatMessage[]) =>
        setConversations((prev) => prev.map((c) => (c.id === conversationId ? { ...c, messages: update(c.messages) } : c)));

      let result: ChatMessage | null = null;
      let rejection: string | null = null;
      try {
        const body = new FormData();
        body.append("messages", JSON.stringify(apiMessages));
        body.append("conversationId", conversationId);
        if (draft) body.append("file", draft.file, draft.name);
        if (schema) {
          body.append("schema", schema.text);
          body.append("schemaName", schema.name);
        }
        const response = await fetch("/api/chat", { method: "POST", body, signal: controller.signal });

        if (!response.ok || !response.body) {
          rejection = await readError(response);
        } else {
          const steps: AssistantStep[] = [];
          for await (const event of readEvents(response.body)) {
            if (event.type === "status") {
              setPending((p) => p && { ...p, retrying: event.state === "retrying" });
            } else if (event.type === "progress") {
              setPending((p) => p && { ...p, stage: event.stage, retrying: false });
            } else if (event.type === "step") {
              steps.push(event.step);
              setPending((p) => p && { ...p, steps: [...steps], retrying: false });
            } else if (event.type === "tool") {
              // A finished call replaces its running record.
              const call = event.call;
              setPending((p) => p && { ...p, toolCalls: p.toolCalls.some((c) => c.id === call.id) ? p.toolCalls.map((c) => (c.id === call.id ? call : c)) : [...p.toolCalls, call] });
            } else if (event.type === "context") {
              // The oldest messages no longer fit; their files stop being sent and must be reattached.
              updateMessages((messages) => dropAttachments(messages, new Set(ids.slice(0, event.omitted))));
            } else if (event.type === "done") {
              result = steps.length
                ? { id: createId(), role: "assistant", turnId: event.turnId, steps, outcome: event.outcome }
                : { id: createId(), role: "error", content: "The response ended without any validated step. Please try again." };
            } else {
              if (event.code === "context_overflow") {
                updateMessages((messages) => dropAttachments(messages, new Set([userMessage.id])));
              }
              result = { id: createId(), role: "error", content: event.error };
            }
          }
          result ??= { id: createId(), role: "error", content: "The response was interrupted. Please try again." };
        }
      } catch {
        // A complete reply or error that already arrived stands even if the connection drops after it.
        if (!controller.signal.aborted) {
          result ??= {
            id: createId(),
            role: "error",
            content: "The response was interrupted or the chat server is unreachable. Please try again.",
          };
        }
      } finally {
        if (abortRef.current === controller) { abortRef.current = null; setPending(null); }
        if (rejection !== null) {
          // Nothing was generated: take the message back out (and a conversation it had just started).
          setConversations((prev) =>
            existing
              ? prev.map((c) => (c.id === conversationId ? existing : c))
              : prev.filter((c) => c.id !== conversationId),
          );
          if (!existing) setActiveId(null);
        } else if (result && !controller.signal.aborted) {
          // Stopping adds nothing: an unfinished turn is not kept.
          const message = result;
          setConversations((prev) =>
            prev.map((c) =>
              c.id === conversationId ? { ...c, messages: [...c.messages, message], updatedAt: Date.now() } : c,
            ),
          );
        }
      }
      return rejection;
    },
    [activeId, conversations],
  );

  const stop = useCallback(() => { const c = abortRef.current; abortRef.current = null; setPending(null); c?.abort(); }, []);

  const newChat = useCallback(() => setActiveId(null), []);

  /** The active conversation's id, creating an empty conversation first if there is none. */
  const ensureConversation = useCallback(
    (title: string): string => {
      if (activeId && conversations.some((c) => c.id === activeId)) return activeId;
      const id = createId();
      setConversations((prev) => [{ id, title: makeTitle(title), messages: [], updatedAt: Date.now() }, ...prev]);
      setActiveId(id);
      return id;
    },
    [activeId, conversations],
  );

  const selectChat = useCallback((id: string) => setActiveId(id), []);

  const deleteChat = useCallback(
    (id: string) => {
      if (pending?.conversationId === id) abortRef.current?.abort();
      void deleteSchema(id).catch(() => {});
      setConversations((prev) => prev.filter((c) => c.id !== id));
      setActiveId((current) => (current === id ? null : current));
    },
    [pending?.conversationId],
  );

  return {
    conversations,
    activeConversation: conversations.find((c) => c.id === activeId) ?? null,
    pending,
    isGenerating: pending !== null,
    send,
    stop,
    newChat,
    ensureConversation,
    selectChat,
    deleteChat,
  };
}
