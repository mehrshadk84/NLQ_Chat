/*
 * GreenXERP metadata as declared in the ERP system prompt itself: its INTENT LIST rows and its
 * "Available ERP domains and systems" rows. The prompt is the only source; nothing here is a
 * separate list. The parsed rows drive application-level checks: the procedure allowlist and
 * parameter validation, resolve targets, the initial-procedure gate and get_context_specific_prompt
 * arguments. Anything that doesn't parse is a configuration error, never skipped or filled in.
 */

export interface IntentParameter {
  name: string;
  /** Declared type, lower-case (e.g. "date", "int", "nvarchar"). */
  type: string;
  required: boolean;
  /** FK:Schema.Table annotation of *ID / *IDs parameters. */
  fk?: string;
}

export interface IntentProcedure {
  intentId: string;
  /** The intent name as the model uses it ("Query (DEFAULT)" → "Query"). */
  intent: string;
  procedure: string;
  description: string;
  parameters: IntentParameter[];
  /** The intent's base-data procedure: its name contains "Initial" (INTENT LIST, FLOW step 3.1). */
  initial: boolean;
}

export interface ErpDomainSystem {
  domainName: string;
  domainSchema: string;
  systemName: string;
  /** null: a domain-level entry without a specific system. */
  systemSchema: string | null;
  description: string;
}

export interface ErpMetadata {
  /** Every procedure the model may request, keyed by lower-case name. */
  procedures: Map<string, IntentProcedure>;
  domains: ErpDomainSystem[];
}

const PROCEDURE_NAME = /^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$/;
const PARAMETER_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$/;

/** Splits on commas that are not inside parentheses. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const c of text) {
    if (c === "(") depth++;
    if (c === ")") depth--;
    if (c === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += c;
    }
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** `none`, or `Name(type, required|not-required[, FK:Schema.Table])` separated by commas. */
export function parseParameters(text: string): IntentParameter[] | string {
  if (/^none$/i.test(text.trim())) return [];
  const parameters: IntentParameter[] = [];
  for (const item of splitTopLevel(text)) {
    const match = /^([^()\s]+)\s*\((.*)\)$/.exec(item);
    if (!match) return `parameter "${item}" is not Name(type, required|not-required)`;
    const [, name, inner] = match;
    if (!PARAMETER_NAME.test(name)) return `invalid parameter name "${name}"`;
    const fields = splitTopLevel(inner);
    if (fields.length < 2 || fields.length > 3) return `parameter "${name}" needs (type, required|not-required[, FK:Schema.Table])`;
    const [type, requirement, fk] = fields;
    if (!/^[A-Za-z][A-Za-z0-9]*(\(\s*(\d+|max)\s*(,\s*\d+\s*)?\))?$/i.test(type)) return `parameter "${name}" has an invalid type "${type}"`;
    if (!/^(required|not-required)$/i.test(requirement)) return `parameter "${name}" must be "required" or "not-required"`;
    let table: string | undefined;
    if (fk !== undefined) {
      const fkMatch = /^FK:\s*(\S+)$/i.exec(fk);
      if (!fkMatch || !TABLE_NAME.test(fkMatch[1])) return `parameter "${name}" has an invalid FK annotation "${fk}"`;
      if (!/IDs?$/.test(name)) return `parameter "${name}" has an FK annotation but its name doesn't end with ID or IDs`;
      table = fkMatch[1];
    }
    parameters.push({ name, type: type.toLowerCase().replace(/\s+/g, ""), required: /^required$/i.test(requirement), ...(table && { fk: table }) });
  }
  if (new Set(parameters.map((p) => p.name.toLowerCase())).size !== parameters.length) return "duplicate parameter names";
  return parameters;
}

/** "Query (DEFAULT)" is the Query intent; the marker only says it is the fallback intent. */
const intentName = (raw: string) => raw.replace(/\s*\(DEFAULT\)\s*$/i, "").trim();

/**
 * Intent rows: `ID | Intent | Procedure | Description | Parameters`. A row starts with its numeric
 * ID; a following line that doesn't is a continuation of the row above (a description may span
 * lines). The parameters are the last `|` field, so a description may itself contain " | ".
 */
export function parseIntents(lines: string[]): IntentProcedure[] | string {
  const rows: { line: number; text: string }[] = [];
  for (const [index, raw] of lines.entries()) {
    if (/^\s*\d+\s*\|/.test(raw)) rows.push({ line: index + 1, text: raw.trim() });
    else if (rows.length && raw.trim()) rows[rows.length - 1].text += `\n${raw.trim()}`;
    else if (raw.trim()) return `line ${index + 1}: an intent row must start with its numeric ID`;
  }
  if (rows.length === 0) return "no intent rows";

  const procedures: IntentProcedure[] = [];
  for (const { line, text } of rows) {
    const fields = text.split("|").map((f) => f.trim());
    if (fields.length < 5) return `row at line ${line}: expected "ID | Intent | Procedure | Description | Parameters"`;
    const [id, rawIntent, procedure] = fields;
    const description = fields.slice(3, -1).join(" | ");
    const intent = intentName(rawIntent);
    if (!intent) return `row at line ${line}: missing intent name`;
    if (!PROCEDURE_NAME.test(procedure)) return `row at line ${line}: invalid procedure name "${procedure}"`;
    if (!description) return `row at line ${line}: missing description`;
    const parameters = parseParameters(fields.at(-1)!);
    if (typeof parameters === "string") return `row at line ${line}: ${parameters}`;
    procedures.push({ intentId: id, intent, procedure, description, parameters, initial: /Initial/.test(procedure.split(".")[1]) });
  }
  const names = procedures.map((p) => p.procedure.toLowerCase());
  const duplicate = names.find((n, i) => names.indexOf(n) !== i);
  if (duplicate) return `procedure "${duplicate}" is listed twice`;
  // One ID is one intent name.
  for (const p of procedures) {
    const other = procedures.find((q) => q.intentId === p.intentId && q.intent !== p.intent);
    if (other) return `intent ID ${p.intentId} has two names ("${p.intent}", "${other.intent}")`;
  }
  return procedures;
}

/**
 * Domain rows: `DomainName | DomainSchema | SystemName | SystemSchema | SystemDescription`.
 * A combination is the pair (DomainSchema, SystemSchema); it must be unique. ("NULL" as a
 * description is kept as written: it is descriptive text only.)
 */
export function parseDomains(lines: string[]): ErpDomainSystem[] | string {
  const domains: ErpDomainSystem[] = [];
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (!line) continue;
    const fields = line.split("|").map((f) => f.trim());
    if (fields.length < 5) return `line ${index + 1}: expected "DomainName | DomainSchema | SystemName | SystemSchema | SystemDescription"`;
    const [domainName, domainSchema, systemName, systemSchema] = fields;
    // get_context_specific_prompt documents the domain as a two-character code.
    if (!domainName || !/^[A-Za-z]{2}$/.test(domainSchema)) return `line ${index + 1}: DomainSchema must be a two-letter code`;
    const noSystem = systemSchema === "" || /^null$/i.test(systemSchema);
    if (!noSystem && !/^[A-Za-z0-9_]{1,32}$/.test(systemSchema)) return `line ${index + 1}: invalid SystemSchema "${systemSchema}"`;
    domains.push({ domainName, domainSchema, systemName, systemSchema: noSystem ? null : systemSchema, description: fields.slice(4).join(" | ") });
  }
  if (domains.length === 0) return "no domain rows";
  const pairs = domains.map((d) => `${d.domainSchema.toLowerCase()}/${d.systemSchema?.toLowerCase() ?? "null"}`);
  const duplicate = pairs.find((p, i) => pairs.indexOf(p) !== i);
  if (duplicate) return `the combination ${duplicate} is listed twice`;
  return domains;
}

/** The lines of a section: from the line after `start` up to (not including) the first line matching `end`. */
function section(lines: string[], start: RegExp, end: RegExp): string[] | null {
  const from = lines.findIndex((l) => start.test(l));
  if (from < 0) return null;
  const rest = lines.slice(from + 1);
  const to = rest.findIndex((l) => end.test(l));
  return to < 0 ? rest : rest.slice(0, to);
}

/**
 * Reads the intent list and the domains/systems from the prompt text. Returns the metadata, or
 * why it can't be read (the prompt is then not used).
 */
export function parsePromptMetadata(promptText: string): ErpMetadata | string {
  const lines = promptText.split(/\r?\n/);

  // INTENT LIST rows: after the "ID | Intent | ..." format line, from the first numbered row to the
  // first blank line after the rows.
  const intentSection = section(lines, /^INTENT LIST:\s*$/, /^={5,}/);
  if (!intentSection) return 'the prompt has no "INTENT LIST:" section';
  const first = intentSection.findIndex((l) => /^\s*\d+\s*\|/.test(l));
  if (first < 0) return "the INTENT LIST has no rows";
  const blank = intentSection.slice(first).findIndex((l) => !l.trim());
  const intents = parseIntents(intentSection.slice(first, blank < 0 ? undefined : first + blank));
  if (typeof intents === "string") return `INTENT LIST: ${intents}`;

  const domainSection = section(lines, /^Available ERP domains and systems:\s*$/, /^\s*$|^={5,}/);
  if (!domainSection) return 'the prompt has no "Available ERP domains and systems:" section';
  const domains = parseDomains(domainSection);
  if (typeof domains === "string") return `ERP domains and systems: ${domains}`;

  return { procedures: new Map(intents.map((p) => [p.procedure.toLowerCase(), p])), domains };
}

/** Whether (domain, system) is a declared combination; system null = the domain itself. */
export function isKnownDomainSystem(metadata: ErpMetadata, domain: unknown, system: unknown): boolean {
  if (typeof domain !== "string") return false;
  const inDomain = metadata.domains.filter((d) => d.domainSchema.toLowerCase() === domain.toLowerCase());
  if (inDomain.length === 0) return false;
  if (system === null) return true;
  return typeof system === "string" && inDomain.some((d) => d.systemSchema?.toLowerCase() === system.toLowerCase());
}

/** The intent's base-data ("Initial") procedure, if it has one. */
export const initialProcedureOf = (metadata: ErpMetadata, intent: string): IntentProcedure | undefined =>
  [...metadata.procedures.values()].find((p) => p.initial && p.intent.toLowerCase() === intent.toLowerCase());
