"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { Menu, SquarePen } from "lucide-react";
import type { AssistantStep, ToolCallRecord } from "@/types/chat";
import { Composer } from "./composer";
import { MessageList } from "./message-list";
import { SchemaBar } from "./schema-bar";
import { Sidebar } from "./sidebar";
import { useChat, type DraftAttachment } from "./use-chat";
import { useSchema } from "./use-schema";

const subscribeNoop = () => () => {};
const NO_STEPS: AssistantStep[] = [];
const NO_TOOL_CALLS: ToolCallRecord[] = [];

/** Conversations live in localStorage, so the chat renders on the client only. */
export function ChatApp() {
  const isClient = useSyncExternalStore(
    subscribeNoop,
    () => true,
    () => false,
  );
  return isClient ? <Chat /> : <div className="h-dvh bg-app" />;
}

function Chat() {
  const { conversations, activeConversation, pending, isGenerating, send, stop, newChat, ensureConversation, selectChat, deleteChat } =
    useChat();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const activeId = activeConversation?.id ?? null;
  const pendingHere = pending !== null && pending.conversationId === activeId;
  const messages = activeConversation?.messages ?? [];
  const schema = useSchema(activeId, ensureConversation);
  const activeSchema = schema.active;
  const handleSend = useCallback(
    (text: string, attachment?: DraftAttachment) =>
      send(text, attachment, activeSchema ? { name: activeSchema.fileName, text: activeSchema.text } : undefined),
    [send, activeSchema],
  );

  const closeSidebar = useCallback(() => setSidebarOpen(false), []);
  const handleNewChat = useCallback(() => {
    newChat();
    setSidebarOpen(false);
  }, [newChat]);
  const handleSelect = useCallback(
    (id: string) => {
      selectChat(id);
      setSidebarOpen(false);
    },
    [selectChat],
  );

  useEffect(() => {
    if (!sidebarOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSidebarOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [sidebarOpen]);

  return (
    <div className="flex h-dvh overflow-hidden bg-app text-fg">
      <Sidebar
        conversations={conversations}
        activeId={activeId}
        open={sidebarOpen}
        onClose={closeSidebar}
        onNewChat={handleNewChat}
        onSelect={handleSelect}
        onDelete={deleteChat}
      />

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-2 px-2 sm:px-4">
          <button
            type="button"
            onClick={() => setSidebarOpen(true)}
            aria-label="Open sidebar"
            className="rounded-lg p-2 text-muted transition-colors hover:bg-hover hover:text-fg md:hidden"
          >
            <Menu className="size-5" />
          </button>
          <h1 dir="auto" className="min-w-0 flex-1 truncate text-left text-base font-medium">
            {activeConversation?.title ?? "Qwen"}
          </h1>
          <button
            type="button"
            onClick={handleNewChat}
            aria-label="New chat"
            className="rounded-lg p-2 text-muted transition-colors hover:bg-hover hover:text-fg md:hidden"
          >
            <SquarePen className="size-5" />
          </button>
        </header>

        {messages.length === 0 && !pendingHere ? (
          <div className="flex flex-1 items-center justify-center px-4">
            <p className="text-center text-2xl font-medium text-fg/90">How can I help you today?</p>
          </div>
        ) : (
          <MessageList
            key={activeId}
            messages={messages}
            generating={pendingHere}
            retrying={pendingHere && pending.retrying}
            stage={pendingHere ? pending.stage : null}
            steps={pendingHere ? pending.steps : NO_STEPS}
            toolCalls={pendingHere ? pending.toolCalls : NO_TOOL_CALLS}
          />
        )}

        <SchemaBar
          state={schema.state}
          onReplace={(file) => void schema.upload(file)}
          onRemove={() => void schema.remove()}
          onDismissError={schema.dismissError}
        />
        <Composer
          onSend={handleSend}
          onStop={stop}
          generatingHere={pendingHere}
          busy={isGenerating}
          onSchemaFile={(file) => void schema.upload(file)}
          schemaProcessing={schema.state.status === "processing"}
          schemaUploads={schema.uploads}
        />
      </main>
    </div>
  );
}
