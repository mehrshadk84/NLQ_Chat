"use client";

import { useLayoutEffect, useRef } from "react";
import type { AssistantStep, ChatMessage, ProgressStage, ToolCallRecord } from "@/types/chat";
import { GeneratingIndicator, Message } from "./message";

/** How close to the bottom (px) still counts as "following" the conversation. */
const STICK_THRESHOLD = 80;

interface MessageListProps {
  messages: ChatMessage[];
  /** A reply is being generated for this conversation. */
  generating: boolean;
  retrying: boolean;
  stage: ProgressStage | null;
  /** Steps of the turn in progress. */
  steps: AssistantStep[];
  /** MCP Agent mode: tool calls of the turn in progress. */
  toolCalls: ToolCallRecord[];
}

export function MessageList({ messages, generating, retrying, stage, steps, toolCalls }: MessageListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const lastMessage = messages.at(-1);
  const lastUserMessageId = lastMessage?.role === "user" ? lastMessage.id : null;

  // A new message from the user always brings the view back to the bottom.
  // Declared before the scroll effect so it runs first in the same commit.
  useLayoutEffect(() => {
    if (lastUserMessageId) stickRef.current = true;
  }, [lastUserMessageId]);

  // Follow new content unless the user scrolled up to read.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [messages, generating, retrying, stage, steps, toolCalls]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (el) stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD;
  };

  return (
    <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6 sm:px-6">
        {messages.map((message) => (
          <Message key={message.id} message={message} />
        ))}
        {generating && <GeneratingIndicator retrying={retrying} stage={stage} steps={steps} toolCalls={toolCalls} />}
      </div>
    </div>
  );
}
