"use client";

import { useRef } from "react";
import { CircleAlert, Database, LoaderCircle, Wrench, X } from "lucide-react";
import { formatFileSize } from "@/lib/text-file";
import type { SchemaState } from "./use-schema";

interface SchemaBarProps {
  state: SchemaState;
  onReplace: (file: File) => void;
  onRemove: () => void;
  onDismissError: () => void;
}

/** One line above the composer: the active schema, its processing state or an error. */
export function SchemaBar({ state, onReplace, onRemove, onDismissError }: SchemaBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  if (state.status === "none" || state.status === "loading") return null;
  if (state.status === "agent") {
    return (
      <div className="px-3 sm:px-6">
        <div className="mx-auto mb-2 flex w-full max-w-3xl flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-line bg-white/5 px-3 py-1.5 text-sm">
          <Wrench className="size-4 shrink-0 text-sky-300" />
          <span className="font-medium">MCP Agent</span>
          <span className="min-w-0 truncate text-muted" title={state.tools.join(", ")}>
            {state.tools.length ? `${state.tools.length} tools: ${state.tools.join(", ")}` : "no tools available"}
          </span>
        </div>
      </div>
    );
  }
  if (state.status === "default") {
    const { summary } = state;
    return (
      <div className="px-3 sm:px-6">
        <div className="mx-auto mb-2 flex w-full max-w-3xl flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-line bg-white/5 px-3 py-1.5 text-sm">
          <Database className="size-4 shrink-0 text-sky-300" />
          <span dir="auto" className="min-w-0 max-w-[50%] truncate font-medium" title={state.fileName}>
            {state.fileName}
          </span>
          <span className="text-muted">
            Database metadata for every conversation · {formatFileSize(state.size)} · {summary.tables} tables
            {summary.entities !== undefined && ` · ${summary.entities} entities`} · {summary.foreignKeys} relationships
          </span>
          {summary.issueCount > 0 && (
            <span className="text-amber-300/90" title="The details are in the server log.">
              {summary.issueCount} inconsistencies reported in the file
            </span>
          )}
        </div>
      </div>
    );
  }
  const record = state.status === "ready" ? state.record : state.status === "error" ? state.record : undefined;

  return (
    <div className="px-3 sm:px-6">
      <div className="mx-auto mb-2 flex w-full max-w-3xl flex-col gap-1.5 text-sm">
        {state.status === "processing" && (
          <div className="flex items-center gap-2 text-muted" role="status">
            <LoaderCircle className="size-4 animate-spin" />
            <span dir="auto" className="truncate">
              Processing schema {state.fileName}…
            </span>
          </div>
        )}
        {record && (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-line bg-white/5 px-3 py-1.5">
            <Database className="size-4 shrink-0 text-sky-300" />
            <span dir="auto" className="min-w-0 max-w-[50%] truncate font-medium" title={record.fileName}>
              {record.fileName}
            </span>
            <span className="text-muted">
              {formatFileSize(record.size)} · {record.summary.format === "erp-metadata" ? "ERP metadata" : "SQL schema"} · {record.summary.tables} tables
              {record.summary.entities !== undefined && ` · ${record.summary.entities} entities`} · {record.summary.foreignKeys} relationships
            </span>
            {record.summary.issueCount > 0 && (
              <span
                className="text-amber-300/90"
                title={record.summary.issues.map((issue) => `Line ${issue.line}: ${issue.message}`).join("\n")}
              >
                {record.summary.issueCount} {record.summary.format === "erp-metadata" ? "inconsistencies reported" : "unsupported lines"}, not fully validated
              </span>
            )}
            <span className="ms-auto flex items-center gap-1">
              <button
                type="button"
                onClick={() => inputRef.current?.click()}
                className="rounded-md px-2 py-0.5 text-muted transition-colors hover:bg-white/10 hover:text-fg"
              >
                Replace
              </button>
              <button
                type="button"
                onClick={onRemove}
                aria-label="Remove schema"
                title="Remove schema"
                className="rounded-md p-1 text-muted transition-colors hover:bg-white/10 hover:text-red-300"
              >
                <X className="size-4" />
              </button>
            </span>
            <input
              ref={inputRef}
              type="file"
              accept=".txt,text/plain"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) onReplace(file);
                event.target.value = "";
              }}
            />
          </div>
        )}
        {state.status === "error" && (
          <p role="alert" className="flex items-start gap-1.5 text-red-300">
            <CircleAlert className="mt-0.5 size-4 shrink-0" />
            <span className="flex-1">{state.error}</span>
            <button type="button" onClick={onDismissError} aria-label="Dismiss" className="rounded-md p-0.5 hover:bg-white/10">
              <X className="size-4" />
            </button>
          </p>
        )}
      </div>
    </div>
  );
}
