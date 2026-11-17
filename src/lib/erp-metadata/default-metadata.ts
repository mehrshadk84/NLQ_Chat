import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { ErpConfigError } from "@/lib/erp/prompt";
import { parseSchemaUpload, type ParsedUpload } from "@/lib/schema-upload";
import type { SchemaSummary } from "@/types/schema";

/*
 * The authoritative database metadata of file mode: one server-side file (data/ai-table-list.txt by
 * default, ERP_METADATA_FILE to change it), used by every conversation. It is read and parsed once,
 * cached, and parsed again only when the file changes on disk. Neither the file nor its parsed
 * structure leaves the server: the browser only learns its name, size and counts, and the model only
 * receives the subset that retrieval selects for each question.
 */

/** Far above the real file (~300 KB); a guard against pointing the setting at the wrong file. */
const MAX_METADATA_BYTES = 8 * 1024 * 1024;

export type ErpMetadataUpload = Extract<ParsedUpload, { format: "erp-metadata" }>;

export interface DefaultMetadata {
  fileName: string;
  size: number;
  sha256: string;
  upload: ErpMetadataUpload;
  summary: SchemaSummary;
}

const metadataFile = () => path.resolve(process.cwd(), process.env.ERP_METADATA_FILE?.trim() || "data/ai-table-list.txt");

/** Survives dev-mode module reloads, so editing code doesn't re-parse the file on every request. */
const cache = globalThis as typeof globalThis & { __erpDefaultMetadata?: { key: string; value: DefaultMetadata } };

/**
 * The parsed default metadata. Throws `ErpConfigError` when the file is missing, too large or not an
 * ERP metadata document; the message names only the file, never its content.
 */
export function loadDefaultMetadata(): DefaultMetadata {
  const file = metadataFile();
  const fileName = path.basename(file);
  let stats;
  try {
    stats = statSync(file);
  } catch {
    throw new ErpConfigError("metadata_missing", `The database metadata file (${fileName}) can't be read. Put it in data/ or set ERP_METADATA_FILE.`);
  }
  const key = `${file}:${stats.size}:${stats.mtimeMs}`;
  if (cache.__erpDefaultMetadata?.key === key) return cache.__erpDefaultMetadata.value;

  if (stats.size > MAX_METADATA_BYTES) {
    throw new ErpConfigError("metadata_invalid", `The database metadata file (${fileName}) is larger than ${MAX_METADATA_BYTES / 1024 / 1024} MB.`);
  }
  const started = performance.now();
  const bytes = readFileSync(file);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^﻿/, "");
  } catch {
    throw new ErpConfigError("metadata_invalid", `The database metadata file (${fileName}) is not UTF-8 text.`);
  }
  const upload = parseSchemaUpload(text);
  if (upload?.format !== "erp-metadata") {
    throw new ErpConfigError("metadata_invalid", `The database metadata file (${fileName}) is not an ERP metadata document (## NOTATION … ## SCHEMA).`);
  }
  if (path.relative(path.resolve(process.cwd(), "public"), file).split(path.sep)[0] !== "..") {
    console.warn(`[metadata] ${fileName} is inside public/, so anyone can download it; move it to data/`);
  }
  const value: DefaultMetadata = {
    fileName,
    size: stats.size,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    upload,
    summary: upload.summary,
  };
  const { summary } = upload;
  console.info(
    `[metadata] loaded ${fileName} (sha256 ${value.sha256.slice(0, 12)}, ${stats.size} bytes) in ${Math.round(performance.now() - started)} ms: ` +
      `${summary.tables} tables, ${summary.columns} columns, ${summary.foreignKeys} foreign keys, ${summary.entities} entities, ${summary.issueCount} issues`,
  );
  for (const issue of upload.document.issues) console.warn(`[metadata] ${fileName} line ${issue.line}: ${issue.message}`);
  cache.__erpDefaultMetadata = { key, value };
  return value;
}
