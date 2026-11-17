import {
  CHART_TYPES,
  ERP_ACTIONS,
  type ContentBlock,
  type ErpAction,
  type ErpChart,
  type ErpResolves,
  type ErpResponse,
  type ErpResponseObject,
  type ProcedureRequest,
} from "@/types/chat";

/*
 * The ERP response contract (RESPONSE FORMAT, CONTENT BLOCK RULES and CHART RULES of the prompt).
 * Browser-safe: used by the server to validate model output and by the client to validate stored
 * and streamed responses. Metadata- and SQL-dependent checks live in ./validate.ts (server only).
 */

const MAX_OBJECTS = 12;
const MAX_TEXT = 8_000;
const MAX_SQL = 20_000;
const MAX_ITEMS = 500;

/** JSON Schema passed to Ollama's `format`: a top-level array of objects with all eight keys. */
export const ERP_RESPONSE_JSON_SCHEMA = {
  type: "array",
  minItems: 1,
  items: {
    type: "object",
    properties: {
      action: { type: "string", enum: ERP_ACTIONS },
      content: { type: "string" },
      content_blocks: {
        type: "array",
        items: {
          anyOf: [
            {
              type: "object",
              properties: { type: { type: "string", enum: ["h1", "h2", "h3", "paragraph"] }, text: { type: "string" } },
              required: ["type", "text"],
              additionalProperties: false,
            },
            {
              type: "object",
              properties: { type: { type: "string", enum: ["list"] }, items: { type: "array", items: { type: "string" } } },
              required: ["type", "items"],
              additionalProperties: false,
            },
            {
              type: "object",
              properties: { type: { type: "string", enum: ["link"] }, text: { type: "string" }, url: { type: "string" } },
              required: ["type", "text", "url"],
              additionalProperties: false,
            },
          ],
        },
      },
      intent: { type: "string" },
      procedures: {
        type: "array",
        items: {
          type: "object",
          properties: {
            procedure: { type: "string" },
            parameters: {
              type: "object",
              additionalProperties: {
                type: "object",
                properties: { value: { type: ["string", "number", "boolean", "null"] }, type: { type: "string" } },
                required: ["value", "type"],
                additionalProperties: false,
              },
            },
          },
          required: ["procedure", "parameters"],
          additionalProperties: false,
        },
      },
      sql: { type: "string" },
      chart: {
        type: "object",
        properties: {
          chart_type: { type: "string", enum: ["", ...CHART_TYPES] },
          title: { type: "string" },
          categories: { type: "array", items: { type: "string" } },
          series: {
            type: "array",
            items: {
              type: "object",
              properties: { name: { type: "string" }, data: { type: "array", items: { type: "number" } } },
              required: ["name", "data"],
              additionalProperties: false,
            },
          },
        },
        required: ["chart_type", "title", "categories", "series"],
        additionalProperties: false,
      },
      resolves: {
        type: "object",
        properties: { intent: { type: "string" }, procedure: { type: "string" }, parameter: { type: "string" } },
        required: ["intent", "procedure", "parameter"],
        additionalProperties: false,
      },
    },
    required: ["action", "content", "content_blocks", "intent", "procedures", "sql", "chart", "resolves"],
    additionalProperties: false,
  },
} as const;

const EMPTY_STRING = { type: "string", enum: [""] } as const;
const EMPTY_ARRAY = { type: "array", items: { type: "string" }, maxItems: 0 } as const;
const object = (properties: Record<string, unknown>) => ({
  type: "object",
  properties,
  required: ["action", "content", "content_blocks", "intent", "procedures", "sql", "chart", "resolves"],
  additionalProperties: false,
});
const chartOf = (chartType: unknown) => ({
  type: "object",
  properties: { chart_type: chartType, title: EMPTY_STRING, categories: EMPTY_ARRAY, series: EMPTY_ARRAY },
  required: ["chart_type", "title", "categories", "series"],
  additionalProperties: false,
});
const EMPTY_RESOLVES = {
  type: "object",
  properties: { intent: EMPTY_STRING, procedure: EMPTY_STRING, parameter: EMPTY_STRING },
  required: ["intent", "procedure", "parameter"],
  additionalProperties: false,
};
const BLOCKS = { ...ERP_RESPONSE_JSON_SCHEMA.items.properties.content_blocks, minItems: 1 };

/**
 * File-based mode's `format`: the same eight-key objects, one schema branch per action this mode
 * allows, with each action's field rules (RESPONSE FORMAT) built in, so generation itself keeps SQL out
 * of answers and text out of queries. Every field rule here is also enforced by `readErpResponse`.
 */
export const FILE_MODE_RESPONSE_JSON_SCHEMA = {
  type: "array",
  minItems: 1,
  items: {
    anyOf: [
      ...(["answer", "ask"] as const).map((action) =>
        object({ action: { type: "string", enum: [action] }, content: EMPTY_STRING, content_blocks: BLOCKS, intent: { type: "string" }, procedures: EMPTY_ARRAY, sql: EMPTY_STRING, chart: chartOf(EMPTY_STRING), resolves: EMPTY_RESOLVES }),
      ),
      object({ action: { type: "string", enum: ["query"] }, content: EMPTY_STRING, content_blocks: EMPTY_ARRAY, intent: { type: "string", enum: ["Query"] }, procedures: EMPTY_ARRAY, sql: { type: "string", minLength: 1 }, chart: chartOf(EMPTY_STRING), resolves: EMPTY_RESOLVES }),
      object({ action: { type: "string", enum: ["query-diagram"] }, content: EMPTY_STRING, content_blocks: EMPTY_ARRAY, intent: { type: "string", enum: ["Query"] }, procedures: EMPTY_ARRAY, sql: { type: "string", minLength: 1 }, chart: chartOf({ type: "string", enum: CHART_TYPES }), resolves: EMPTY_RESOLVES }),
      object({ action: { type: "string", enum: ["error"] }, content: { type: "string", minLength: 1 }, content_blocks: EMPTY_ARRAY, intent: { type: "string" }, procedures: EMPTY_ARRAY, sql: EMPTY_STRING, chart: chartOf(EMPTY_STRING), resolves: EMPTY_RESOLVES }),
    ],
  },
} as const;

/** The field contract of each action, for the single regeneration after an invalid response. */
export const ACTION_CONTRACTS: Record<ErpAction, string> = {
  answer: '"answer": text only in content_blocks (non-empty); content ""; sql ""; procedures []; chart and resolves empty. The SQL of a query never goes here, not even a copy.',
  ask: '"ask": the question only in content_blocks (non-empty); content ""; sql ""; procedures []; chart and resolves empty.',
  query: '"query": sql = one SQL Server SELECT statement (non-empty); content ""; content_blocks []; intent "Query"; procedures []; chart and resolves empty. Any explanation goes in a separate "answer" object.',
  "query-diagram": '"query-diagram": like "query" (non-empty SELECT in sql, content_blocks []), plus chart.chart_type "line", "pie" or "vertical-bar" with title, categories and series empty.',
  "client-diagram": '"client-diagram": chart fully filled from returned data; content ""; content_blocks []; sql ""; procedures [].',
  intent: '"intent": procedures non-empty; content ""; content_blocks []; sql ""; chart and resolves empty.',
  "resolve-query": '"resolve-query": sql = one SELECT; resolves.intent/procedure/parameter filled; content ""; content_blocks []; procedures [].',
  error: '"error": content non-empty; content_blocks []; sql ""; procedures []; chart and resolves empty; the only object of its array.',
};

type Result<T> ={ ok: true; value: T } | { ok: false; reason: string };
const fail = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const hasExactKeys = (v: Record<string, unknown>, keys: readonly string[]) => {
  const own = Object.keys(v);
  return own.length === keys.length && keys.every((k) => own.includes(k));
};
const isText = (v: unknown, max = MAX_TEXT): v is string => typeof v === "string" && v.length <= max;
const nonEmpty = (v: string) => v.trim().length > 0;

/** Only absolute http(s) links are rendered as clickable. */
export function isSafeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (parsed.protocol === "https:" || parsed.protocol === "http:") && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

function readBlock(v: unknown, at: string): Result<ContentBlock> {
  if (!isRecord(v)) return fail(`${at} is not an object`);
  const { type } = v;
  if (type === "h1" || type === "h2" || type === "h3" || type === "paragraph") {
    if (!hasExactKeys(v, ["type", "text"]) || !isText(v.text) || !nonEmpty(v.text)) return fail(`${at} (${type}) needs exactly a non-empty "text"`);
    return { ok: true, value: { type, text: v.text } };
  }
  if (type === "list") {
    const items = v.items;
    if (!hasExactKeys(v, ["type", "items"]) || !Array.isArray(items) || items.length === 0 || items.length > MAX_ITEMS) {
      return fail(`${at} (list) needs exactly a non-empty "items" array`);
    }
    if (!items.every((item) => isText(item) && nonEmpty(item))) return fail(`${at} (list) items must be non-empty strings`);
    return { ok: true, value: { type, items: items as string[] } };
  }
  if (type === "link") {
    if (!hasExactKeys(v, ["type", "text", "url"]) || !isText(v.text) || !nonEmpty(v.text) || !isText(v.url, 2_000)) {
      return fail(`${at} (link) needs exactly "text" and "url"`);
    }
    if (!isSafeUrl(v.url)) return fail(`${at} (link) url must be an absolute http(s) URL`);
    return { ok: true, value: { type, text: v.text, url: v.url } };
  }
  return fail(`${at} has an unsupported block type ${JSON.stringify(type)}`);
}

function readProcedure(v: unknown, at: string): Result<ProcedureRequest> {
  if (!isRecord(v) || !hasExactKeys(v, ["procedure", "parameters"])) return fail(`${at} needs exactly "procedure" and "parameters"`);
  if (!isText(v.procedure, 300) || !nonEmpty(v.procedure)) return fail(`${at}.procedure must be a non-empty string`);
  if (!isRecord(v.parameters)) return fail(`${at}.parameters must be an object`);
  const parameters: ProcedureRequest["parameters"] = {};
  for (const [name, p] of Object.entries(v.parameters)) {
    if (!isRecord(p) || !hasExactKeys(p, ["value", "type"])) return fail(`${at}.parameters.${name} needs exactly "value" and "type"`);
    const value = p.value;
    const okValue = value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)) || isText(value, 4_000);
    if (!okValue) return fail(`${at}.parameters.${name}.value must be a string, number, boolean or null`);
    if (!isText(p.type, 64) || !nonEmpty(p.type)) return fail(`${at}.parameters.${name}.type must be a non-empty string`);
    parameters[name] = { value: value as string | number | boolean | null, type: p.type };
  }
  return { ok: true, value: { procedure: v.procedure, parameters } };
}

function readChart(v: unknown, at: string): Result<ErpChart> {
  if (!isRecord(v) || !hasExactKeys(v, ["chart_type", "title", "categories", "series"])) {
    return fail(`${at} needs exactly chart_type, title, categories and series`);
  }
  const { chart_type, title, categories, series } = v;
  if (chart_type !== "" && !CHART_TYPES.includes(chart_type as (typeof CHART_TYPES)[number])) return fail(`${at}.chart_type must be "", line, pie or vertical-bar`);
  if (!isText(title, 300)) return fail(`${at}.title must be a string`);
  if (!Array.isArray(categories) || categories.length > MAX_ITEMS || !categories.every((c) => isText(c, 300))) return fail(`${at}.categories must be strings`);
  if (!Array.isArray(series) || series.length > 50) return fail(`${at}.series must be an array`);
  for (const [i, s] of series.entries()) {
    if (!isRecord(s) || !hasExactKeys(s, ["name", "data"]) || !isText(s.name, 300)) return fail(`${at}.series[${i}] needs exactly "name" and "data"`);
    if (!Array.isArray(s.data) || !s.data.every((d) => typeof d === "number" && Number.isFinite(d))) return fail(`${at}.series[${i}].data must be numbers`);
  }
  return { ok: true, value: { chart_type: chart_type as ErpChart["chart_type"], title, categories: categories as string[], series: series as ErpChart["series"] } };
}

function readResolves(v: unknown, at: string): Result<ErpResolves> {
  if (!isRecord(v) || !hasExactKeys(v, ["intent", "procedure", "parameter"])) return fail(`${at} needs exactly intent, procedure and parameter`);
  if (!isText(v.intent, 300) || !isText(v.procedure, 300) || !isText(v.parameter, 300)) return fail(`${at} values must be strings`);
  return { ok: true, value: { intent: v.intent, procedure: v.procedure, parameter: v.parameter } };
}

const KEYS = ["action", "content", "content_blocks", "intent", "procedures", "sql", "chart", "resolves"] as const;
const usesSqlAction = (action: ErpAction) => action === "query" || action === "query-diagram" || action === "resolve-query";
const REQUEST_ACTIONS: readonly ErpAction[] = ["intent", "query", "query-diagram", "resolve-query"];

/** Field structure plus the per-action rules of RESPONSE FORMAT. */
function readObject(v: unknown, at: string): Result<ErpResponseObject> {
  if (!isRecord(v)) return fail(`${at} is not an object`);
  if (!hasExactKeys(v, KEYS)) return fail(`${at} must have exactly the keys ${KEYS.join(", ")}`);
  const action = v.action as ErpAction;
  if (!ERP_ACTIONS.includes(action)) return fail(`${at}.action ${JSON.stringify(v.action)} is not a supported action`);
  // From here on, messages name the object's action: "[0] answer: …".
  at = `${at} ${action}`;
  if (!isText(v.content) || !isText(v.intent, 300) || !isText(v.sql, MAX_SQL)) return fail(`${at}: content, intent and sql must be strings`);
  if (!Array.isArray(v.content_blocks) || v.content_blocks.length > 100) return fail(`${at}.content_blocks must be an array`);
  if (!Array.isArray(v.procedures) || v.procedures.length > 20) return fail(`${at}.procedures must be an array`);

  const blocks: ContentBlock[] = [];
  for (const [i, b] of v.content_blocks.entries()) {
    const block = readBlock(b, `${at}.content_blocks[${i}]`);
    if (!block.ok) return block;
    blocks.push(block.value);
  }
  const procedures: ProcedureRequest[] = [];
  for (const [i, p] of v.procedures.entries()) {
    const procedure = readProcedure(p, `${at}.procedures[${i}]`);
    if (!procedure.ok) return procedure;
    procedures.push(procedure.value);
  }
  const chart = readChart(v.chart, `${at}.chart`);
  if (!chart.ok) return chart;
  const resolves = readResolves(v.resolves, `${at}.resolves`);
  if (!resolves.ok) return resolves;
  const object: ErpResponseObject = {
    action,
    content: v.content,
    content_blocks: blocks,
    intent: v.intent,
    procedures,
    sql: v.sql,
    chart: chart.value,
    resolves: resolves.value,
  };

  // "content" is only ever populated for action "error".
  if (action === "error" && !nonEmpty(object.content)) return fail(`${at}: "content" is empty; an "error" carries its message in "content"`);
  if (action !== "error" && nonEmpty(object.content)) {
    return fail(`${at}: "content" must be "" (it has ${object.content.length} characters); "content" is used only by "error"${action === "answer" || action === "ask" ? `, the text of "${action}" goes in content_blocks` : ""}`);
  }
  // content_blocks only for answer/ask (and then required).
  const usesBlocks = action === "answer" || action === "ask";
  if (usesBlocks && blocks.length === 0) return fail(`${at}: content_blocks is empty; the text of "${action}" goes in content_blocks`);
  if (!usesBlocks && blocks.length > 0) {
    return fail(`${at}: content_blocks must be [] (it has ${blocks.length} blocks); explanations go in a separate "answer" object${usesSqlAction(action) ? ", and the SQL itself only in sql" : ""}`);
  }
  if (action === "intent" && procedures.length === 0) return fail(`${at}: procedures is empty; "intent" lists the procedures it requests`);
  if (action !== "intent" && procedures.length > 0) return fail(`${at}: procedures must be [] (it has ${procedures.length}); only "intent" requests procedures`);
  const usesSql = action === "query" || action === "query-diagram" || action === "resolve-query";
  if (usesSql && !nonEmpty(object.sql)) return fail(`${at}: sql is empty; "${action}" must carry one SQL Server SELECT statement in sql`);
  if (!usesSql && nonEmpty(object.sql)) {
    return fail(
      `${at}: sql must be "" (it has ${object.sql.trim().length} characters of SQL); only "query", "query-diagram" and "resolve-query" carry SQL` +
        (action === "answer" ? `. When an "answer" accompanies a query, it only describes it: put the SQL once, in the "query" object` : ""),
    );
  }
  if (REQUEST_ACTIONS.includes(action) && !nonEmpty(object.intent)) return fail(`${at}: "${action}" needs the intent name`);

  const c = chart.value;
  const chartEmpty = c.chart_type === "" && c.title === "" && c.categories.length === 0 && c.series.length === 0;
  if (action === "client-diagram") {
    if (c.chart_type === "" || !nonEmpty(c.title) || c.categories.length === 0 || c.series.length === 0) {
      return fail(`${at}: "client-diagram" needs chart_type, title, categories and series`);
    }
    if (c.chart_type === "pie" && c.series.length !== 1) return fail(`${at}: a pie chart has exactly one series`);
    if (c.series.some((s) => s.data.length !== c.categories.length)) return fail(`${at}: every series needs one value per category`);
  } else if (action === "query-diagram") {
    if (c.chart_type === "" || c.title !== "" || c.categories.length || c.series.length) {
      return fail(`${at}: "query-diagram" sets only chart_type; title, categories and series stay empty`);
    }
  } else if (!chartEmpty) {
    return fail(`${at}: chart must be empty for "${action}"`);
  }

  const r = resolves.value;
  if (action === "resolve-query") {
    if (!nonEmpty(r.intent) || !nonEmpty(r.procedure) || !nonEmpty(r.parameter)) return fail(`${at}: "resolve-query" needs resolves.intent, procedure and parameter`);
  } else if (r.intent || r.procedure || r.parameter) {
    return fail(`${at}: resolves must be empty for "${action}"`);
  }
  return { ok: true, value: object };
}

/** A whole model turn: a non-empty JSON array of valid objects. An "error" is the only object of its array. */
export function readErpResponse(value: unknown): Result<ErpResponse> {
  if (!Array.isArray(value)) return fail("the response is not a JSON array");
  if (value.length === 0 || value.length > MAX_OBJECTS) return fail(`the array must have 1-${MAX_OBJECTS} objects`);
  const response: ErpResponse = [];
  for (const [i, item] of value.entries()) {
    const object = readObject(item, `[${i}]`);
    if (!object.ok) return object;
    response.push(object.value);
  }
  if (response.length > 1 && response.some((o) => o.action === "error")) return fail('an "error" response must be the only object');
  return { ok: true, value: response };
}

export const isErpResponse = (value: unknown): value is ErpResponse => readErpResponse(value).ok;

/** Actions that ask the backend to run something. */
export const isRequestAction = (action: ErpAction) => REQUEST_ACTIONS.includes(action);

/**
 * The "EXEC schema.procedure ..." companion "query" sent alongside a final non-Query answer or
 * chart (FLOW step 8): shown to the user, never executed.
 */
export function isExecCompanion(object: ErpResponseObject, response: ErpResponse): boolean {
  return (
    object.action === "query" &&
    /^\s*EXEC(UTE)?\s/i.test(object.sql) &&
    response.some((o) => (o.action === "answer" || o.action === "client-diagram") && o.intent === object.intent)
  );
}

/** Objects in a response that the backend must execute (requests minus display-only companions). */
export const pendingRequests = (response: ErpResponse) => response.filter((o) => isRequestAction(o.action) && !isExecCompanion(o, response));

/** The companion "answer" sent with a Query SQL request (FLOW step 7): a progress notice, not a final answer. */
export const isProgressNotice = (object: ErpResponseObject, response: ErpResponse) =>
  object.action === "answer" && response.some((o) => (o.action === "query" || o.action === "query-diagram") && !isExecCompanion(o, response) && o.intent === object.intent);
