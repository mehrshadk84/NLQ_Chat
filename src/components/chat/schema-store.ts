import type { ParsedSchema, SchemaSummary } from "@/types/schema";

/**
 * Per-conversation database schemas, kept in IndexedDB (they are too large for localStorage
 * and don't belong inside chat messages). One record per conversation.
 */
export interface StoredSchema {
  conversationId: string;
  fileName: string;
  size: number;
  /** The file's text. It is sent with each request so the server can validate and parse it itself. */
  text: string;
  summary: SchemaSummary;
  schema: ParsedSchema;
  savedAt: number;
}

const DB_NAME = "qwen-chat";
const DB_VERSION = 1;
const STORE = "schemas";

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is not available"));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE, { keyPath: "conversationId" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB could not be opened"));
    request.onblocked = () => reject(new Error("IndexedDB is blocked by another tab"));
  });
}

async function withStore<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      const request = action(transaction.objectStore(STORE));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"));
      transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction was aborted"));
    });
  } finally {
    db.close();
  }
}

function isStoredSchema(value: unknown): value is StoredSchema {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Partial<StoredSchema>;
  return (
    typeof r.conversationId === "string" &&
    typeof r.fileName === "string" &&
    typeof r.size === "number" &&
    typeof r.text === "string" &&
    typeof r.savedAt === "number" &&
    typeof r.summary?.tables === "number" &&
    Array.isArray(r.schema?.tables) &&
    Array.isArray(r.schema?.foreignKeys)
  );
}

/** Returns the conversation's schema, null if it has none, or "corrupt" if the record was unreadable (it is then removed). */
export async function loadSchema(conversationId: string): Promise<StoredSchema | null | "corrupt"> {
  const record = await withStore<unknown>("readonly", (store) => store.get(conversationId));
  if (record === undefined) return null;
  if (isStoredSchema(record)) return record;
  await deleteSchema(conversationId).catch(() => {});
  return "corrupt";
}

export async function saveSchema(record: StoredSchema): Promise<void> {
  await withStore("readwrite", (store) => store.put(record));
}

export async function deleteSchema(conversationId: string): Promise<void> {
  await withStore("readwrite", (store) => store.delete(conversationId));
}

/** Removes schemas whose conversation no longer exists (e.g. deleted while storage was unavailable). */
export async function pruneSchemas(conversationIds: Set<string>): Promise<void> {
  const keys = await withStore<IDBValidKey[]>("readonly", (store) => store.getAllKeys());
  await Promise.all(keys.filter((key) => typeof key !== "string" || !conversationIds.has(key)).map((key) => withStore("readwrite", (store) => store.delete(key))));
}
