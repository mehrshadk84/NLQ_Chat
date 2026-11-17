"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { checkSchemaFileSize, checkTextFile, decodeTextFile } from "@/lib/text-file";
import type { SchemaConfigResponse, SchemaSummary, SchemaUploadResponse } from "@/types/schema";
import { deleteSchema, loadSchema, saveSchema, type StoredSchema } from "./schema-store";

export type SchemaState =
  | { status: "none" }
  | { status: "loading" }
  | { status: "processing"; fileName: string }
  | { status: "ready"; record: StoredSchema }
  /** File-based mode: the server's metadata file, the same for every conversation. */
  | { status: "default"; fileName: string; size: number; summary: SchemaSummary }
  /** MCP Agent mode: no database file; the MCP tools the assistant may use. */
  | { status: "agent"; tools: string[] }
  /** `record` is the schema still in effect, if any (e.g. a failed replacement). */
  | { status: "error"; error: string; record?: StoredSchema };

const STORAGE_ERROR = "Browser storage (IndexedDB) is unavailable, so the schema can't be loaded or kept.";

/** The server's schema configuration, fetched once per page load (retried after a failure). */
let configRequest: Promise<SchemaConfigResponse | null> | null = null;
function loadSchemaConfig(): Promise<SchemaConfigResponse | null> {
  configRequest ??= fetch("/api/schema", { cache: "no-store" })
    .then((response) => response.json() as Promise<SchemaConfigResponse>)
    .catch(() => {
      configRequest = null;
      return null;
    });
  return configRequest;
}

/**
 * The database schema of the active conversation. In file-based mode it is the server's metadata file
 * for every conversation (nothing is uploaded, stored or sent). Otherwise it is loaded from IndexedDB
 * when the conversation changes, uploaded through `/api/schema` (which parses it), replaced or removed.
 */
export function useSchema(conversationId: string | null, ensureConversation: (title: string) => string) {
  // undefined while loading; null when it couldn't be fetched (uploads stay available).
  const [config, setConfig] = useState<SchemaConfigResponse | null | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    void loadSchemaConfig().then((result) => {
      if (!cancelled) setConfig(result);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  // State is tagged with its conversation; anything else means "still loading".
  const [state, setState] = useState<{ id: string | null; value: SchemaState }>({ id: null, value: { status: "none" } });
  const activeIdRef = useRef(conversationId);

  useEffect(() => {
    activeIdRef.current = conversationId;
    if (!conversationId) return;
    let cancelled = false;
    loadSchema(conversationId)
      .then((result) => {
        if (cancelled) return;
        const loaded: SchemaState =
          result === "corrupt"
            ? { status: "error", error: "The saved schema for this conversation was unreadable and has been removed. Upload it again." }
            : result
              ? { status: "ready", record: result }
              : { status: "none" };
        // An upload started for this conversation (e.g. a new chat) wins over the initial load, and so
        // does its rejection (e.g. a file over 300 KB), which would otherwise vanish here unseen.
        setState((prev) =>
          prev.id === conversationId && (prev.value.status === "processing" || (prev.value.status === "error" && !result))
            ? prev
            : { id: conversationId, value: loaded },
        );
      })
      .catch(() => {
        if (!cancelled) setState({ id: conversationId, value: { status: "error", error: STORAGE_ERROR } });
      });
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  const value: SchemaState = !conversationId ? { status: "none" } : state.id === conversationId ? state.value : { status: "loading" };
  const current = value.status === "ready" ? value.record : value.status === "error" ? value.record : undefined;

  const upload = useCallback(
    async (file: File) => {
      const problem = checkTextFile(file.name, file.size) ?? checkSchemaFileSize(file.size);
      const id = ensureConversation(file.name);
      const previous = current;
      // Ignore results that arrive after the user switched to another conversation.
      const set = (next: SchemaState) => {
        if (activeIdRef.current === id || activeIdRef.current === null) setState({ id, value: next });
      };
      if (problem) {
        set({ status: "error", error: problem, record: previous });
        return;
      }
      set({ status: "processing", fileName: file.name });
      try {
        const decoded = decodeTextFile(file.name, new Uint8Array(await file.arrayBuffer()));
        if (!decoded.ok) {
          set({ status: "error", error: decoded.error, record: previous });
          return;
        }
        const body = new FormData();
        body.append("file", file, file.name);
        const response = await fetch("/api/schema", { method: "POST", body });
        const result = (await response.json().catch(() => null)) as SchemaUploadResponse | null;
        if (!result?.ok) {
          set({ status: "error", error: result?.error ?? "The schema couldn't be processed. Please try again.", record: previous });
          return;
        }
        const record: StoredSchema = {
          conversationId: id,
          fileName: result.fileName,
          size: result.size,
          text: decoded.text,
          summary: result.summary,
          schema: result.schema,
          savedAt: Date.now(),
        };
        try {
          await saveSchema(record);
        } catch {
          set({ status: "error", error: STORAGE_ERROR, record: previous });
          return;
        }
        set({ status: "ready", record });
      } catch {
        set({ status: "error", error: "The schema couldn't be uploaded. Check that the app is running and try again.", record: previous });
      }
    },
    [current, ensureConversation],
  );

  const remove = useCallback(async () => {
    if (!conversationId) return;
    try {
      await deleteSchema(conversationId);
      setState({ id: conversationId, value: { status: "none" } });
    } catch {
      setState({ id: conversationId, value: { status: "error", error: STORAGE_ERROR, record: current } });
    }
  }, [conversationId, current]);

  const dismissError = useCallback(() => {
    setState((prev) =>
      prev.id === conversationId && prev.value.status === "error"
        ? { id: prev.id, value: prev.value.record ? { status: "ready", record: prev.value.record } : { status: "none" } }
        : prev,
    );
  }, [conversationId]);

  if (config?.mode === "mcp-agent") {
    const state: SchemaState = "tools" in config ? { status: "agent", tools: config.tools } : { status: "error", error: `The MCP tools can't be listed: ${config.error}` };
    return { state, active: undefined, upload, remove, dismissError, uploads: false };
  }
  if (config && config.mode !== "mcp") {
    const state: SchemaState =
      "metadata" in config ? { status: "default", ...config.metadata } : { status: "error", error: `The database metadata file can't be used: ${config.error}` };
    return { state, active: undefined, upload, remove, dismissError, uploads: false };
  }
  return { state: value, active: current, upload, remove, dismissError, uploads: config !== undefined };
}
