/**
 * TXT attachment validation, shared by the composer (early feedback) and the API route
 * (authoritative check). The extension is only a first filter: the bytes must decode as
 * UTF-8 and must not contain binary control characters.
 */

export const MAX_TEXT_FILE_BYTES = 1024 * 1024;

/** Upload limit for database files (the database button): 300 KiB, checked in the browser and on the server. */
export const MAX_SCHEMA_FILE_BYTES = 300 * 1024;

/** Size check for database files before reading. Null when acceptable. */
export function checkSchemaFileSize(size: number): string | null {
  return size > MAX_SCHEMA_FILE_BYTES ? `The file is larger than 300 KB (${MAX_SCHEMA_FILE_BYTES.toLocaleString("en-US")} bytes).` : null;
}
const MAX_FILE_NAME_LENGTH = 255;

// C0 controls other than tab, LF, VT, FF and CR, plus DEL: these don't occur in text files.
const BINARY_CHARACTERS = /[\u0000-\u0008\u000E-\u001F\u007F]/;

export type TextFileResult = { ok: true; name: string; text: string } | { ok: false; error: string };

export function isTxtFileName(name: string): boolean {
  return /\.txt$/i.test(name);
}

/** Checks the name and size before reading the file. */
export function checkTextFile(name: string, size: number): string | null {
  if (!isTxtFileName(name)) return "Only .txt files are supported.";
  if (name.length > MAX_FILE_NAME_LENGTH) return "The file name is too long.";
  if (size === 0) return "The file is empty.";
  if (size > MAX_TEXT_FILE_BYTES) return "The file is larger than 1 MB.";
  return null;
}

/** Decodes and validates a TXT file. Line breaks and whitespace are kept exactly. */
export function decodeTextFile(name: string, bytes: Uint8Array): TextFileResult {
  const problem = checkTextFile(name, bytes.byteLength);
  if (problem) return { ok: false, error: problem };

  let text: string;
  try {
    // A leading UTF-8 byte order mark is dropped; anything that isn't valid UTF-8 throws.
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, error: "The file isn't valid UTF-8 text." };
  }
  if (BINARY_CHARACTERS.test(text)) return { ok: false, error: "The file looks like a binary file, not text." };
  if (!text.trim()) return { ok: false, error: "The file is empty." };
  // The name ends up in the model prompt, so keep it on one line.
  return { ok: true, name: name.replace(/[\u0000-\u001F\u007F]/g, " "), text };
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
