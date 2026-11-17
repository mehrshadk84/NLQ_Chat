"use client";

import { memo, useState, type ReactNode } from "react";
import { CircleAlert, CircleCheck, CircleHelp, CircleSlash, Copy, Database, FileText, Info, Loader, LoaderCircle, TriangleAlert, Wrench } from "lucide-react";
import { isExecCompanion, isProgressNotice, isSafeUrl, pendingRequests } from "@/lib/erp/contract";
import { formatFileSize } from "@/lib/text-file";
import type { AssistantStep, Attachment, ChatMessage, ContentBlock, ErpResponse, ErpResponseObject, ExecutedResult, ProgressStage, ToolCallRecord, TurnOutcome } from "@/types/chat";
import { CopyButton } from "./copy-button";
import { ErpChartView } from "./erp-chart";

/** The raw structured responses can be inspected in development builds only. */
const showJsonToggle = process.env.NODE_ENV !== "production";

const MISSING_ATTACHMENT_NOTE: Record<NonNullable<Attachment["missing"]>, string> = {
  not_saved: "Not saved in this browser. Attach the file again to use it.",
  out_of_context: "No longer in the model's context. Attach the file again to use it.",
};

export const UserMessage = memo(function UserMessage({
  content,
  attachment,
}: {
  content: string;
  attachment?: Attachment;
}) {
  return (
    <div className="flex flex-col items-end gap-1.5">
      {attachment && (
        <div className="flex max-w-[85%] flex-col items-end gap-1 sm:max-w-[75%]">
          <div className="flex max-w-full items-center gap-2 rounded-xl border border-line bg-white/5 px-3 py-2 text-sm">
            <FileText className="size-4 shrink-0 text-muted" />
            <span dir="auto" className="min-w-0 truncate">
              {attachment.name}
            </span>
            <span className="shrink-0 text-xs text-muted">{formatFileSize(attachment.size)}</span>
          </div>
          {attachment.missing && <p className="text-xs text-amber-300/90">{MISSING_ATTACHMENT_NOTE[attachment.missing]}</p>}
        </div>
      )}
      {content && (
        <div
          dir="auto"
          className="max-w-[85%] whitespace-pre-wrap break-words rounded-3xl bg-panel px-4 py-2.5 sm:max-w-[75%]"
        >
          {content}
        </div>
      )}
    </div>
  );
});

/** Headings, paragraphs, lists and links of an "answer"/"ask". Only http(s) links are clickable. */
function Blocks({ blocks }: { blocks: ContentBlock[] }) {
  return (
    <div dir="auto" className="flex flex-col gap-2 break-words">
      {blocks.map((block, i) => {
        switch (block.type) {
          case "h1":
            return <h2 key={i} className="text-xl font-semibold">{block.text}</h2>;
          case "h2":
            return <h3 key={i} className="text-lg font-semibold">{block.text}</h3>;
          case "h3":
            return <h4 key={i} className="font-semibold">{block.text}</h4>;
          case "paragraph":
            return <p key={i} className="whitespace-pre-wrap">{block.text}</p>;
          case "list":
            return (
              <ul key={i} className="list-disc space-y-1 ps-6">
                {block.items.map((item, j) => (
                  <li key={j}>{item}</li>
                ))}
              </ul>
            );
          case "link":
            return isSafeUrl(block.url) ? (
              <a key={i} href={block.url} target="_blank" rel="noopener noreferrer nofollow" className="text-sky-300 underline underline-offset-2 hover:text-sky-200">
                {block.text}
              </a>
            ) : (
              <span key={i}>{block.text}</span>
            );
        }
      })}
    </div>
  );
}

const blocksText = (blocks: ContentBlock[]) =>
  blocks.map((b) => (b.type === "list" ? b.items.map((item) => `- ${item}`).join("\n") : b.type === "link" ? `${b.text} (${b.url})` : b.text)).join("\n\n");

/** SQL or a procedure request: collapsed by default, open when the SQL itself is the result. */
function Code({ label, code, open = false }: { label: string; code: string; open?: boolean }) {
  return (
    <details dir="ltr" open={open} className="group rounded-lg border border-line bg-code text-sm">
      <summary className="flex cursor-pointer items-center justify-between gap-2 px-3 py-1.5 text-xs text-muted">
        <span>{label}</span>
        <CopyButton text={code} label={`Copy ${label}`} />
      </summary>
      <pre className="overflow-x-auto whitespace-pre-wrap break-words border-t border-line p-3 font-mono text-[13px] leading-relaxed">{code}</pre>
    </details>
  );
}

const REQUEST_LABEL: Partial<Record<ErpResponseObject["action"], string>> = {
  intent: "Data request",
  query: "SQL query",
  "query-diagram": "SQL query for a chart",
  "resolve-query": "SQL lookup to identify a parameter",
};

function procedureText(object: ErpResponseObject): string {
  return object.procedures
    .map((p) => `${p.procedure}\n${Object.entries(p.parameters).map(([name, v]) => `  @${name} = ${JSON.stringify(v.value)} (${v.type})`).join("\n") || "  (no parameters)"}`)
    .join("\n\n");
}

/** One object of a response array, rendered by its action. */
function ResponseObject({ object, response, step }: { object: ErpResponseObject; response: ErpResponse; step: AssistantStep }) {
  switch (object.action) {
    case "answer":
      return isProgressNotice(object, response) ? (
        <div className="flex items-start gap-2 text-sm text-muted">
          <Loader className="mt-1 size-4 shrink-0" />
          <Blocks blocks={object.content_blocks} />
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          <Blocks blocks={object.content_blocks} />
          <div className="flex justify-end text-xs text-muted">
            <CopyButton text={blocksText(object.content_blocks)} label="Copy answer" />
          </div>
        </div>
      );
    case "ask":
      return (
        <div className="flex items-start gap-2 rounded-xl border border-amber-400/30 bg-amber-400/5 px-3 py-2">
          <CircleHelp className="mt-1 size-4 shrink-0 text-amber-300" />
          <Blocks blocks={object.content_blocks} />
        </div>
      );
    case "error":
      return (
        <div role="alert" dir="auto" className="flex items-start gap-2 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-red-200">
          <CircleAlert className="mt-1 size-4 shrink-0" />
          <span>{object.content}</span>
        </div>
      );
    case "client-diagram":
      return <ErpChartView chart={object.chart} />;
    default: {
      if (isExecCompanion(object, response)) return <Code label="Source of this answer" code={object.sql} />;
      const executed = step.execution?.status === "executed";
      const label = `${REQUEST_LABEL[object.action] ?? object.action}${object.intent ? ` · ${object.intent}` : ""}${object.chart.chart_type ? ` · ${object.chart.chart_type} chart` : ""}${executed ? " · executed" : ""}`;
      // A query that wasn't run is itself the result (file-based mode, or execution unavailable): shown expanded.
      const sqlIsResult = (object.action === "query" || object.action === "query-diagram") && step.execution?.status === "unavailable";
      return <Code label={label} code={object.action === "intent" ? procedureText(object) : object.sql} open={sqlIsResult} />;
    }
  }
}

const TOOL_STATUS: Record<ToolCallRecord["status"], { text: string; icon: typeof Wrench; tone: string }> = {
  running: { text: "running", icon: LoaderCircle, tone: "text-muted" },
  ok: { text: "executed", icon: CircleCheck, tone: "text-emerald-300" },
  error: { text: "tool returned an error", icon: CircleAlert, tone: "text-red-300" },
  failed: { text: "failed", icon: CircleAlert, tone: "text-red-300" },
  rejected: { text: "rejected, not executed", icon: CircleSlash, tone: "text-amber-300" },
  duplicate: { text: "repeat, not executed again", icon: Copy, tone: "text-muted" },
};

/**
 * MCP Agent mode: one tool call as the backend handled it (name, arguments, status, error) with the
 * tool's actual result, collapsed. All of it comes from the backend, none from the model's text.
 */
function ToolCallView({ call }: { call: ToolCallRecord }) {
  const status = TOOL_STATUS[call.status];
  const Icon = status.icon;
  const args = call.arguments === "{}" ? "" : call.arguments;
  return (
    <details dir="ltr" className="group rounded-lg border border-line bg-code text-sm">
      <summary className="flex cursor-pointer flex-wrap items-center gap-x-2 gap-y-0.5 px-3 py-1.5 text-xs">
        <Wrench className="size-3.5 shrink-0 text-sky-300" />
        <span className="font-mono text-fg">{call.name}</span>
        <span className={`flex items-center gap-1 ${status.tone}`}>
          <Icon className={`size-3.5 ${call.status === "running" ? "animate-spin" : ""}`} />
          {status.text}
        </span>
        {call.by === "backend" && <span className="text-muted">· run because you named it</span>}
        {call.durationMs !== undefined && <span className="text-muted">· {(call.durationMs / 1000).toFixed(1)} s</span>}
        {call.resultChars !== undefined && <span className="text-muted">· {call.resultChars.toLocaleString()} chars</span>}
      </summary>
      <div className="flex flex-col gap-2 border-t border-line p-3">
        {args && (
          <div>
            <p className="mb-1 text-xs text-muted">Arguments</p>
            <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-[12px]"><bdi>{args}</bdi></pre>
          </div>
        )}
        {call.detail && <p dir="auto" className={`text-xs ${call.status === "duplicate" ? "text-muted" : "text-amber-200"}`}>{call.detail}</p>}
        {call.result !== undefined && (
          <div>
            <div className="mb-1 flex items-center justify-between text-xs text-muted">
              <span>Result returned by the MCP server{call.truncated ? ` (first ${call.result.length.toLocaleString()} characters)` : ""}</span>
              <CopyButton text={call.result} label="Copy result" />
            </div>
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed"><bdi>{call.result || "(empty result)"}</bdi></pre>
          </div>
        )}
      </div>
    </details>
  );
}

function ToolCallsView({ calls }: { calls: ToolCallRecord[] }) {
  return (
    <div className="flex flex-col gap-1.5">
      {calls.map((call) => (
        <ToolCallView key={call.id} call={call} />
      ))}
    </div>
  );
}

function StepView({ step }: { step: AssistantStep }) {
  const { response, execution } = step;
  return (
    <div className="flex flex-col gap-3">
      {step.toolCalls?.length ? <ToolCallsView calls={step.toolCalls} /> : null}
      {response.map((object, i) => (
        <ResponseObject key={i} object={object} response={response} step={step} />
      ))}
      {execution?.status === "unavailable" && execution.reason.startsWith("file-based mode") && (
        <Notice tone="info">
          SQL only, not executed: this app runs in file-based mode and never connects to the database. Run the query yourself to get the data.
        </Notice>
      )}
      {execution?.status === "unavailable" && !execution.reason.startsWith("file-based mode") && (
        <Notice tone="warn">
          Not executed: {execution.reason}. The {pendingRequests(response).length === 1 ? "request above was" : "requests above were"} generated
          but not run, so no data was retrieved and no final answer was produced.
        </Notice>
      )}
      {execution?.status === "failed" && <Notice tone="error">Execution failed: {execution.reason}. No data was retrieved.</Notice>}
      {step.liveSchema?.status === "verified" && (
        <Notice tone="info">
          Checked against the live database schema before running: {step.liveSchema.tables.length} {step.liveSchema.tables.length === 1 ? "table" : "tables"} and every column read exist.
        </Notice>
      )}
      {step.liveSchema?.status === "unavailable" && <Notice tone="warn">The live database schema could not be checked: {step.liveSchema.reason}.</Notice>}
      {execution?.status === "executed" && execution.results?.map((result, i) => <ResultView key={i} result={result} />)}
      {step.notices?.map((notice, i) => (
        <Notice key={i} tone="info">
          {notice}
        </Notice>
      ))}
    </div>
  );
}

/** What the database actually returned for one executed SELECT: the rows, and a chart drawn from them. */
function ResultView({ result }: { result: ExecutedResult }) {
  const shown = result.rows.length;
  return (
    <div className="flex flex-col gap-2">
      <p className="flex items-center gap-1.5 text-xs text-muted">
        <Database className="size-3.5" />
        Returned by the database: {result.rowCount} {result.rowCount === 1 ? "row" : "rows"}
        {result.truncated && " (cut off at the row limit)"}
        {shown < result.rowCount && `, first ${shown} shown`}
      </p>
      {result.chart && ("unavailable" in result.chart ? <Notice tone="warn">No chart: {result.chart.unavailable}.</Notice> : <ErpChartView chart={result.chart} />)}
      {/* A drawn chart lists its values itself; otherwise the rows are shown as a table. */}
      {result.columns.length > 0 && result.rowCount > 0 && !(result.chart && !("unavailable" in result.chart)) && (
        <div className="max-h-80 overflow-auto rounded-lg border border-line">
          <table dir="auto" className="w-full border-collapse text-sm">
            <thead className="sticky top-0 bg-app">
              <tr>
                {result.columns.map((column) => (
                  <th key={column} className="border-b border-line px-2 py-1 text-start font-medium">
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.rows.map((row, r) => (
                <tr key={r} className="odd:bg-white/[0.03]">
                  {row.map((value, c) => (
                    <td key={c} className="px-2 py-1 align-top">
                      {value === null ? <span className="text-muted">—</span> : String(value)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {result.rowCount === 0 && <Notice tone="info">The query ran and returned no rows.</Notice>}
    </div>
  );
}

function Notice({ tone, children }: { tone: "info" | "warn" | "error"; children: ReactNode }) {
  const styles = {
    info: "border-line text-muted",
    warn: "border-amber-400/30 bg-amber-400/5 text-amber-200",
    error: "border-red-500/30 bg-red-500/10 text-red-200",
  }[tone];
  const Icon = tone === "info" ? Info : TriangleAlert;
  return (
    <p className={`flex items-start gap-2 rounded-lg border px-3 py-1.5 text-sm ${styles}`}>
      <Icon className="mt-1 size-3.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

const OUTCOME_NOTE: Partial<Record<TurnOutcome, string>> = {
  step_limit: "The workflow stopped after its maximum number of steps without a final answer.",
};

/**
 * One chat turn of the ERP workflow. The last step is shown in full; earlier steps (data
 * requests and the queries the backend ran) are intermediate and collapsed, unless one of them
 * holds rows the database returned: those are the data the answer is about, so they stay visible.
 */
export const AssistantTurn = memo(function AssistantTurn({ steps, outcome }: { steps: AssistantStep[]; outcome?: TurnOutcome }) {
  const [showJson, setShowJson] = useState(false);
  const earlier = steps.slice(0, -1);
  const last = steps.at(-1);
  const json = JSON.stringify(steps.map((s) => s.response), null, 2);
  const earlierHasRows = earlier.some((s) => s.execution?.status === "executed" && s.execution.results?.length);
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {earlierHasRows && earlier.map((step, i) => <StepView key={i} step={step} />)}
      {earlier.length > 0 && !earlierHasRows && (
        <details className="rounded-lg border border-line px-3 py-1.5 text-sm">
          <summary className="flex cursor-pointer items-center gap-2 text-muted">
            <Database className="size-3.5" />
            {earlier.length === 1 ? "1 earlier step" : `${earlier.length} earlier steps`} (data requests)
          </summary>
          <div className="mt-2 flex flex-col gap-3">
            {earlier.map((step, i) => (
              <StepView key={i} step={step} />
            ))}
          </div>
        </details>
      )}
      {last && <StepView step={last} />}
      {outcome && OUTCOME_NOTE[outcome] && <Notice tone="warn">{OUTCOME_NOTE[outcome]}</Notice>}
      {showJsonToggle && (
        <div className="text-xs">
          <button type="button" onClick={() => setShowJson((v) => !v)} className="rounded-md px-1.5 py-1 text-muted transition-colors hover:bg-white/10 hover:text-fg">
            {showJson ? "Hide JSON" : "Show JSON"} <span className="opacity-60">(dev)</span>
          </button>
          {showJson && (
            <div dir="ltr" className="mt-1 overflow-hidden rounded-xl border border-line bg-code">
              <div className="flex items-center justify-between bg-panel/60 px-4 py-1.5 text-muted">
                <span className="font-mono">json · {steps.length === 1 ? "1 step" : `${steps.length} steps`}</span>
                <CopyButton text={json} label="Copy JSON" />
              </div>
              <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-[12px] leading-relaxed">
                <bdi>{json}</bdi>
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
});

/** An application error (connection, timeout, invalid model output). Not a model reply. */
export const ErrorMessage = memo(function ErrorMessage({ content }: { content: string }) {
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200"
    >
      <CircleAlert className="mt-0.5 size-4 shrink-0" />
      <span>{content}</span>
    </div>
  );
});

/** Saved by an older version of the app (free text or a reply in the old {action, content} format). */
export const LegacyMessage = memo(function LegacyMessage({ content }: { content: string }) {
  return (
    <div className="rounded-xl border border-dashed border-line px-3 py-2 text-sm">
      <p className="mb-1 text-xs text-muted">Saved by an older version of the app; not part of the model&apos;s context</p>
      <div dir="auto" className="whitespace-pre-wrap break-words text-fg/70">
        {content}
      </div>
    </div>
  );
});

const STAGE_TEXT: Record<ProgressStage, string> = {
  tools: "Running a tool on the MCP server…",
  generating: "Preparing the response…",
  checking: "Checking the query against the live database schema…",
  executing: "Running the backend request…",
};

/** The turn in progress: steps received so far, then the current activity. */
export function GeneratingIndicator({
  retrying,
  stage,
  steps,
  toolCalls = [],
}: {
  retrying: boolean;
  stage: ProgressStage | null;
  steps: AssistantStep[];
  toolCalls?: ToolCallRecord[];
}) {
  return (
    <div className="flex flex-col gap-3">
      {steps.length > 0 && (
        <div className="opacity-80">
          <AssistantTurn steps={steps} />
        </div>
      )}
      {toolCalls.length > 0 && <ToolCallsView calls={toolCalls} />}
      <div className="flex h-7 items-center gap-2" role="status" aria-label="Generating response">
        <span className="flex items-center gap-1">
          <span className="typing-dot" />
          <span className="typing-dot [animation-delay:150ms]" />
          <span className="typing-dot [animation-delay:300ms]" />
        </span>
        <span className="text-sm text-muted">{retrying ? "Invalid response, retrying once…" : stage ? STAGE_TEXT[stage] : ""}</span>
      </div>
    </div>
  );
}

export function Message({ message }: { message: ChatMessage }) {
  switch (message.role) {
    case "user":
      return <UserMessage content={message.content} attachment={message.attachment} />;
    case "assistant":
      return <AssistantTurn steps={message.steps} outcome={message.outcome} />;
    case "error":
      return <ErrorMessage content={message.content} />;
    case "legacy":
      return <LegacyMessage content={message.content} />;
  }
}
