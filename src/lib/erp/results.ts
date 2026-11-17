import type { ChartType, ErpChart, ExecutedResult } from "@/types/chat";
import type { ExecutionResult, Row } from "./executor";

/*
 * What the database returned, turned into what the user sees and what the model may say (hybrid mode):
 *  - the result shown in the chat: its SQL, columns and first rows, never model text;
 *  - a chart drawn from the returned rows themselves (label column + numeric columns), or the reason
 *    none can be drawn: a chart is never made of values the database didn't return;
 *  - the numbers an analysis may state: values in the returned rows, row counts, column sums and
 *    percentages of two of them. A number outside that set is a number the model made up.
 */

/** Rows shown in the chat per result (the model gets more, up to the execution limit). */
export const DISPLAY_ROWS = 50;
const MAX_CELL_CHARS = 300;
const MAX_CHART_CATEGORIES = 50;

type Cell = string | number | boolean | null;

const cell = (value: unknown): Cell => {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" || typeof value === "boolean") return value;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > MAX_CELL_CHARS ? `${text.slice(0, MAX_CELL_CHARS - 1)}…` : text;
};

/** A cell as a number when it is one (SQL Server bigint and decimal arrive as numeric text). */
const numeric = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value.trim()) ? Number(value) : null;

/** The first result set's rows. */
export const firstRows = (result: ExecutionResult): Row[] =>
  result.data.length > 0 && Array.isArray(result.data[0]) ? ((result.data as Row[][])[0] ?? []) : (result.data as Row[]);

/** The chart for a "query-diagram": first column = labels, every other column a numeric series. */
export function chartFromRows(columns: string[], rows: Row[], chartType: ChartType, truncated: boolean): ErpChart | { unavailable: string } {
  if (rows.length === 0) return { unavailable: "the query returned no rows, so there is nothing to chart" };
  if (truncated) return { unavailable: "the result was cut off at the row limit, so a chart of it would be incomplete" };
  if (columns.length < 2) return { unavailable: "the result needs a label column and at least one numeric column" };
  if (rows.length > MAX_CHART_CATEGORIES) return { unavailable: `the result has ${rows.length} rows, too many categories for a chart (at most ${MAX_CHART_CATEGORIES})` };
  const [label, ...valueColumns] = columns;
  const series = [];
  for (const column of chartType === "pie" ? valueColumns.slice(0, 1) : valueColumns) {
    const data = rows.map((row) => numeric(row[column]));
    if (data.some((v) => v === null)) return { unavailable: `the column "${column}" has empty or non-numeric values` };
    series.push({ name: column, data: data as number[] });
  }
  return {
    chart_type: chartType,
    title: "",
    categories: rows.map((row) => (row[label] === null || row[label] === undefined ? "—" : String(row[label]))),
    series,
  };
}

/** The result shown in the chat for one executed SELECT. */
export function presentResult(sql: string, result: ExecutionResult, chartType: ChartType | null): ExecutedResult {
  const rows = firstRows(result);
  const columns = result.columns ?? Object.keys(rows[0] ?? {});
  return {
    sql,
    columns,
    rows: rows.slice(0, DISPLAY_ROWS).map((row) => columns.map((c) => cell(row[c]))),
    rowCount: rows.length,
    truncated: result.truncated,
    ...(chartType && { chart: chartFromRows(columns, rows, chartType, result.truncated) }),
  };
}

// ---------- Numbers an analysis may state ----------

/** Numbers written in a text (Persian or Latin digits, thousands separators, decimals), with whether each is a percentage. */
export function numbersIn(text: string): { value: number; percent: boolean; written: string }[] {
  const ascii = text.replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0)).replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));
  const found: { value: number; percent: boolean; written: string }[] = [];
  for (const m of ascii.matchAll(/\d+(?:[,٬]\d{3})*(?:[.٫]\d+)?(\s*(?:%|٪|درصد))?/g)) {
    const value = Number(m[0].replace(/(\s*(?:%|٪|درصد))$/, "").replace(/[,٬]/g, "").replace("٫", "."));
    if (Number.isFinite(value)) found.push({ value, percent: !!m[1], written: m[0].trim() });
  }
  return found;
}

/** The numbers returned rows justify: every numeric cell, the row count and each numeric column's sum. */
export function numbersFromRows(rows: Row[]): number[] {
  const values = new Set<number>([rows.length]);
  const sums = new Map<string, number>();
  for (const row of rows) {
    for (const [column, value] of Object.entries(row)) {
      const n = numeric(value);
      if (n !== null) {
        values.add(n);
        sums.set(column, (sums.get(column) ?? 0) + n);
      } else if (typeof value === "string") {
        // Numbers inside text cells (dates, codes) are data too.
        for (const inner of numbersIn(value)) values.add(inner.value);
      }
    }
  }
  for (const sum of sums.values()) values.add(sum);
  return [...values];
}

/**
 * Why an analysis states a number the data doesn't contain, or null. Numbers below 10 (ordinals,
 * small counts in wording) are not checked; a percentage must be the ratio of two allowed numbers.
 */
export function unsupportedNumbers(text: string, allowed: number[], source = "the returned rows don't contain"): string | null {
  const set = new Set(allowed.map((n) => Math.round(n * 100) / 100));
  const close = (v: number) => set.has(Math.round(v * 100) / 100) || allowed.some((a) => Math.abs(a - v) < 0.005 * Math.max(1, Math.abs(a)) || Math.round(a) === v);
  const ratios = () => {
    const small = allowed.filter((a) => a > 0).slice(0, 300);
    return (v: number) => small.some((a) => small.some((b) => b >= a && Math.abs((a / b) * 100 - v) < 0.6));
  };
  let isRatio: ((v: number) => boolean) | null = null;
  const bad: string[] = [];
  for (const n of numbersIn(text)) {
    if (Math.abs(n.value) < 10 && !n.percent) continue;
    if (close(n.value)) continue;
    if (n.percent) {
      isRatio ??= ratios();
      if (isRatio(n.value)) continue;
    }
    bad.push(n.written);
  }
  return bad.length ? `the answer states ${bad.slice(0, 5).map((b) => `"${b}"`).join(", ")}, which ${source}` : null;
}
