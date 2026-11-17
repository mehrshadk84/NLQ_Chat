/*
 * The explicit execution policy for model-generated SELECTs (hybrid mode), applied by the executor
 * itself on top of the read-only guard and the schema validation:
 *  - only tables of approved schemas (ERP_SQL_ALLOWED_SCHEMAS, default every gnd_* schema), never a
 *    denied table (ERP_SQL_DENIED_TABLES, e.g. tables holding credentials);
 *  - every table must be one the metadata file documents (the caller's usage comes from validating
 *    against it, so an undocumented table never gets here);
 *  - a bounded number of joins (ERP_SQL_MAX_JOINS) against runaway queries.
 * The database login's own permissions remain the primary control; this policy narrows what the
 * application will even send.
 */

const list = (value: string | undefined, fallback: string) =>
  (value?.trim() || fallback)
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

const readNumber = (name: string, fallback: number) => {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
};

export const policyConfig = {
  /** Schema patterns ("*" matches any characters). */
  allowedSchemas: list(process.env.ERP_SQL_ALLOWED_SCHEMAS, "gnd_*"),
  /** Schema-qualified tables never read, whatever the schema allows. */
  deniedTables: list(process.env.ERP_SQL_DENIED_TABLES, ""),
  maxJoins: readNumber("ERP_SQL_MAX_JOINS", 8),
};

const matches = (pattern: string, value: string) =>
  new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`, "i").test(value);

/**
 * Whether a validated SELECT may be executed. `usage` is what validation found it reads (table →
 * columns); `joins` is its number of JOIN clauses. Returns the reason it may not, or null.
 */
export function authorizeSelect(usage: Map<string, Set<string>>, joins: number): string | null {
  if (usage.size === 0) return "the query reads no documented table";
  for (const table of usage.keys()) {
    const [schema] = table.toLowerCase().split(".");
    if (!policyConfig.allowedSchemas.some((pattern) => matches(pattern, schema))) return `${table} is outside the approved schemas`;
    if (policyConfig.deniedTables.includes(table.toLowerCase())) return `${table} is not approved for querying`;
  }
  if (joins > policyConfig.maxJoins) return `the query joins ${joins} tables (at most ${policyConfig.maxJoins} are allowed)`;
  return null;
}
