"use client";

import { memo, useEffect, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { ArrowUp, CircleAlert, Database, FileText, Paperclip, Square, X } from "lucide-react";
import { checkTextFile, decodeTextFile, formatFileSize } from "@/lib/text-file";
import type { DraftAttachment } from "./use-chat";

const MAX_TEXTAREA_HEIGHT = 200;

interface ComposerProps {
  /** Resolves to an error message if the server rejected the message before generating. */
  onSend: (text: string, attachment?: DraftAttachment) => Promise<string | null>;
  onStop: () => void;
  /** A reply is being generated in this conversation (shows the stop button). */
  generatingHere: boolean;
  /** A reply is being generated anywhere; new messages wait until it ends. */
  busy: boolean;
  /** Uploads a database schema TXT for this conversation. */
  onSchemaFile: (file: File) => void;
  schemaProcessing: boolean;
  /** False in file-based mode, where the server's metadata file serves every conversation. */
  schemaUploads: boolean;
}

const hasFiles = (event: DragEvent) => event.dataTransfer.types.includes("Files");

export const Composer = memo(function Composer({
  onSend,
  onStop,
  generatingHere,
  busy,
  onSchemaFile,
  schemaProcessing,
  schemaUploads,
}: ComposerProps) {
  const [value, setValue] = useState("");
  const [attachment, setAttachment] = useState<DraftAttachment | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const schemaInputRef = useRef<HTMLInputElement>(null);
  const canSend = (value.trim().length > 0 || attachment !== null) && !busy && !reading;

  // Grow with the content up to a limit, then scroll. Width changes re-wrap the text,
  // so re-measure on resize too.
  useEffect(() => {
    const fit = () => {
      const el = textareaRef.current;
      if (!el) return;
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_HEIGHT)}px`;
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [value]);

  // Focus on devices with a real pointer; on touch screens this would pop up the keyboard.
  useEffect(() => {
    if (window.matchMedia("(pointer: fine)").matches) textareaRef.current?.focus();
  }, []);

  /** Validates a picked or dropped file here for quick feedback; the server checks it again. */
  const attach = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    if (files.length > 1) {
      setError("Attach one .txt file at a time.");
      return;
    }
    const file = files[0];
    const problem = checkTextFile(file.name, file.size);
    if (problem) {
      setError(problem);
      return;
    }
    setReading(true);
    try {
      const result = decodeTextFile(file.name, new Uint8Array(await file.arrayBuffer()));
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setAttachment({ file, name: result.name, size: file.size, text: result.text });
      setError(null);
      textareaRef.current?.focus();
    } catch {
      setError("The file couldn't be read.");
    } finally {
      setReading(false);
    }
  };

  const submit = async () => {
    if (!canSend) return;
    const text = value;
    const file = attachment;
    setValue("");
    setAttachment(null);
    setError(null);
    const rejection = await onSend(text, file ?? undefined);
    if (rejection) {
      // Nothing was sent: give the draft back unless something new was typed meanwhile.
      setValue((current) => current || text);
      setAttachment((current) => current ?? file);
      setError(rejection);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  };

  return (
    <div
      className="px-3 pb-3 sm:px-6 sm:pb-4"
      onDragOver={(event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        setDragging(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={(event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        setDragging(false);
        void attach(event.dataTransfer.files);
      }}
    >
      <form
        className={`mx-auto flex w-full max-w-3xl flex-col rounded-[28px] bg-panel p-2 shadow-lg shadow-black/20 focus-within:ring-1 focus-within:ring-white/15 ${
          dragging ? "ring-2 ring-sky-400/60" : ""
        }`}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {(attachment || error) && (
          <div className="flex flex-col gap-1.5 px-2 pb-2 pt-1">
            {attachment && (
              <div className="flex max-w-full items-center gap-2 self-start rounded-xl border border-line bg-white/5 px-3 py-2 text-sm">
                <FileText className="size-4 shrink-0 text-muted" />
                <span dir="auto" className="min-w-0 truncate">
                  {attachment.name}
                </span>
                <span className="shrink-0 text-xs text-muted">{formatFileSize(attachment.size)}</span>
                <button
                  type="button"
                  onClick={() => setAttachment(null)}
                  aria-label={`Remove ${attachment.name}`}
                  title="Remove file"
                  className="-me-1 rounded-md p-0.5 text-muted transition-colors hover:bg-white/10 hover:text-fg"
                >
                  <X className="size-4" />
                </button>
              </div>
            )}
            {error && (
              <p role="alert" className="flex items-start gap-1.5 text-sm text-red-300">
                <CircleAlert className="mt-0.5 size-4 shrink-0" />
                <span>{error}</span>
              </p>
            )}
          </div>
        )}
        <div className="flex items-end gap-1">
          <input
            ref={fileInputRef}
            type="file"
            accept=".txt,text/plain"
            className="hidden"
            onChange={(event) => {
              void attach(event.target.files);
              event.target.value = "";
            }}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={reading}
            aria-label="Attach a .txt file"
            title="Attach a .txt file (up to 1 MB)"
            className="flex size-9 shrink-0 items-center justify-center rounded-full text-muted transition-colors hover:bg-white/10 hover:text-fg disabled:opacity-40"
          >
            <Paperclip className="size-5" />
          </button>
          {schemaUploads && (
            <>
              <input
                ref={schemaInputRef}
                type="file"
                accept=".txt,text/plain"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) onSchemaFile(file);
                  event.target.value = "";
                }}
              />
              <button
                type="button"
                onClick={() => schemaInputRef.current?.click()}
                disabled={schemaProcessing}
                aria-label="Upload a database schema (.txt)"
                title="Upload a SQL Server schema (.txt, up to 1 MB) for this conversation"
                className="-ms-1 flex size-9 shrink-0 items-center justify-center rounded-full text-muted transition-colors hover:bg-white/10 hover:text-fg disabled:opacity-40"
              >
                <Database className="size-5" />
              </button>
            </>
          )}
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={onKeyDown}
            rows={1}
            dir="auto"
            placeholder={dragging ? "Drop a .txt file" : "Message Qwen"}
            aria-label="Message"
            className="max-h-[200px] min-h-10 flex-1 resize-none bg-transparent px-1 py-2 leading-6 text-fg outline-none placeholder:text-muted"
          />
          {generatingHere ? (
            <button
              type="button"
              onClick={onStop}
              aria-label="Stop generating"
              title="Stop generating"
              className="flex size-9 shrink-0 items-center justify-center rounded-full bg-fg text-app transition-opacity hover:opacity-80"
            >
              <Square className="size-3.5 fill-current" />
            </button>
          ) : (
            <button
              type="submit"
              disabled={!canSend}
              aria-label="Send message"
              title={busy ? "Wait for the current response to finish" : "Send message"}
              className="flex size-9 shrink-0 items-center justify-center rounded-full bg-fg text-app transition-opacity hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-30"
            >
              <ArrowUp className="size-5" strokeWidth={2.25} />
            </button>
          )}
        </div>
      </form>
      <p className="mt-2 text-center text-xs text-muted">
        Responses are generated locally and can be inaccurate.
      </p>
    </div>
  );
});
