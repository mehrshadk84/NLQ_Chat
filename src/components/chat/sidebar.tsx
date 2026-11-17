"use client";

import { memo } from "react";
import { MessageSquare, SquarePen, Trash2, X } from "lucide-react";
import type { Conversation } from "@/types/chat";

interface SidebarProps {
  conversations: Conversation[];
  activeId: string | null;
  open: boolean;
  onClose: () => void;
  onNewChat: () => void;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
}

export const Sidebar = memo(function Sidebar({
  conversations,
  activeId,
  open,
  onClose,
  onNewChat,
  onSelect,
  onDelete,
}: SidebarProps) {
  const sorted = conversations.toSorted((a, b) => b.updatedAt - a.updatedAt);

  return (
    <>
      {/* Mobile backdrop */}
      <div
        aria-hidden
        onClick={onClose}
        className={`fixed inset-0 z-30 bg-black/60 transition-opacity md:hidden ${
          open ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      />
      <aside
        className={`fixed inset-y-0 start-0 z-40 flex w-72 flex-col bg-sidebar transition-transform duration-200 md:static md:w-64 md:translate-x-0 ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
        aria-label="Conversations"
      >
        <div className="flex items-center gap-1 p-2">
          <button
            type="button"
            onClick={onNewChat}
            className="flex flex-1 items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors hover:bg-hover"
          >
            <SquarePen className="size-4" />
            New chat
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close sidebar"
            className="rounded-lg p-2 text-muted transition-colors hover:bg-hover hover:text-fg md:hidden"
          >
            <X className="size-5" />
          </button>
        </div>

        <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {sorted.length > 0 && <h2 className="px-3 pb-1 pt-3 text-xs font-medium text-muted">Chats</h2>}
          <ul className="flex flex-col gap-0.5">
            {sorted.map((conversation) => {
              const active = conversation.id === activeId;
              return (
                <li key={conversation.id} className="group relative">
                  <button
                    type="button"
                    onClick={() => onSelect(conversation.id)}
                    aria-current={active ? "page" : undefined}
                    className={`flex w-full items-center gap-2.5 rounded-lg py-2 pe-9 ps-3 text-start text-sm transition-colors ${
                      active ? "bg-hover text-fg" : "text-fg/85 hover:bg-hover/70"
                    }`}
                  >
                    <MessageSquare className="size-4 shrink-0 text-muted" />
                    <span dir="auto" className="min-w-0 flex-1 truncate">
                      {conversation.title}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (window.confirm(`Delete "${conversation.title}"?`)) onDelete(conversation.id);
                    }}
                    aria-label={`Delete conversation: ${conversation.title}`}
                    title="Delete"
                    className="absolute end-1.5 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-muted transition hover:bg-white/10 hover:text-red-300 focus-visible:opacity-100 md:opacity-0 md:group-hover:opacity-100"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>
      </aside>
    </>
  );
});
