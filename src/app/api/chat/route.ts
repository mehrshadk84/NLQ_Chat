import { runHypothesisGenesisPipeline, type StageProgressEvent } from "@/lib/ai/hypothesis-engine";
import { readErpResponse } from "@/lib/erp/contract";
import type {
  AssistantStep,
  ChartType,
  ChatStreamEvent,
  ContentBlock,
  ErpResponseObject,
  ExecutedResult,
  ProgressStage,
} from "@/types/chat";

const emptyChart = { chart_type: "" as const, title: "", categories: [], series: [] };
const emptyResolves = { intent: "", procedure: "", parameter: "" };

async function extractQuestion(request: Request): Promise<string> {
  try {
    const ct = request.headers.get("content-type") || "";
    let messages: any[] = [];
    if (ct.startsWith("multipart/form-data")) {
      const raw = (await request.formData()).get("messages");
      if (typeof raw === "string") messages = JSON.parse(raw);
    } else {
      const body = await request.json();
      if (Array.isArray(body?.messages)) messages = body.messages;
    }
    const last = [...messages].reverse().find((m) => m?.role === "user");
    return typeof last?.content === "string" ? last.content.trim() : "";
  } catch {
    return "";
  }
}

export async function POST(request: Request): Promise<Response> {
  const question = await extractQuestion(request);
  if (!question) return Response.json({ error: "سوال خالی است." }, { status: 400 });

  const encoder = new TextEncoder();
  const abort = new AbortController();
  request.signal.addEventListener("abort", () => abort.abort(), { once: true });

  const run = async (controller: ReadableStreamDefaultController<Uint8Array>) => {
    const send = (ev: ChatStreamEvent) => {
      if (!abort.signal.aborted) {
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(ev)}\n`));
        } catch {}
      }
    };
    const sendChunked = async (ev: ChatStreamEvent) => {
      if (!abort.signal.aborted) {
        try {
          const bytes = encoder.encode(`${JSON.stringify(ev)}\n`);
          for (let i = 0; i < bytes.length; i += 250) {
            if (abort.signal.aborted) break;
            controller.enqueue(bytes.subarray(i, i + 250));
            if (bytes.length > 250) await new Promise((r) => setTimeout(r, 25));
          }
        } catch {}
      }
    };

    try {
      send({ type: "status", state: "generating" });
      send({ type: "progress", stage: "tools" });
      const map: Record<string, ProgressStage> = {
        VERIFY_FACT: "tools",
        GENERATE_HYPOTHESIS: "generating",
        TEST_HYPOTHESIS: "executing",
        FINAL_SYNTHESIS: "checking",
      };
      const res = await runHypothesisGenesisPipeline(
        question,
        (e: StageProgressEvent) => {
          if (e.status === "STARTED" && map[e.stage]) {
            send({ type: "progress", stage: map[e.stage] });
          }
        },
        abort.signal
      );
      if (abort.signal.aborted) return;

      const detectedIntent: string = res.detectedIntent || "query";
      const chartType: ChartType =
        res.chartType === "pie" || res.chartType === "line" || res.chartType === "vertical-bar"
          ? res.chartType
          : "vertical-bar";

      const rawQ = [
        {
          sql: String(res.stage1FactVerification?.meta?.sql_query || "").trim(),
          rows: res.stage1FactVerification?.rows || [],
          error: res.stage1FactVerification?.meta?.error,
        },
        ...(res.stage3TestResults || []).map((t: any) => ({
          sql: String(t.sqlQuery || "").trim(),
          rows: t.rows || [],
          error: t.error,
        })),
      ].filter((q) => q.sql.length > 0);

      const seen = new Set<string>();
      const uniq = rawQ.filter((q) => {
        const k = q.sql.toUpperCase();
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });

      const executedResults: ExecutedResult[] = [];
      const responseObjects: ErpResponseObject[] = [];
      const errs: string[] = [];

      // In "query" or "diagram" mode, show the primary working query; in "analysis" mode, show up to 4 queries
      const maxQueries = detectedIntent === "analysis" ? 4 : 1;
      const pickedQueries =
        detectedIntent === "analysis"
          ? uniq.slice(0, maxQueries)
          : [uniq.find((q) => q.rows.length > 0) || uniq[0]].filter(Boolean);

      if (detectedIntent !== "answer") {
        for (const [idx, q] of pickedQueries.entries()) {
          const isDiagramObj = detectedIntent === "diagram" && idx === 0;
          responseObjects.push({
            action: isDiagramObj ? "query-diagram" : "query",
            content: "",
            content_blocks: [],
            intent: detectedIntent === "analysis" ? "Analysis" : isDiagramObj ? "Diagram" : "Query",
            procedures: [],
            sql: q.sql,
            chart: isDiagramObj
              ? { chart_type: chartType, title: "", categories: [], series: [] }
              : emptyChart,
            resolves: emptyResolves,
          });
          const cols = q.rows.length > 0 ? Object.keys(q.rows[0]) : [];
          const rows = q.rows.slice(0, 200).map((r: any) =>
            cols.map((c) =>
              r[c] === null || r[c] === undefined
                ? null
                : typeof r[c] === "object"
                  ? String(r[c])
                  : r[c]
            )
          );
          executedResults.push({
            sql: q.sql,
            columns: cols,
            rows,
            rowCount: q.rows.length,
            truncated: q.rows.length > 200,
          });
          if (q.error) errs.push(`خطای کوئری: ${String(q.error).slice(0, 200)}`);
        }
      }

      const s4 = res.stage4Synthesis;
      const blocks: ContentBlock[] = [];
      const txt = (v: unknown) => (typeof v === "string" ? v.trim().slice(0, 7000) : "");

      if (txt(s4?.report_title)) blocks.push({ type: "h2", text: txt(s4.report_title) });
      if (txt(s4?.executive_summary)) blocks.push({ type: "paragraph", text: txt(s4.executive_summary) });

      if (Array.isArray(s4?.hypotheses_verdicts)) {
        const items = s4.hypotheses_verdicts
          .map((v: any) => {
            const label = txt(v?.statement) || txt(v?.hypothesis_id) || "بررسی شاخص";
            const ev = txt(v?.evidence);
            return ev ? `${label}: ${ev}` : "";
          })
          .filter((s: string) => s.length > 3);
        if (items.length > 0) blocks.push({ type: "list", items });
      }
      if (txt(s4?.root_cause_analysis)) {
        blocks.push({ type: "paragraph", text: `تحلیل ریشه‌ای: ${txt(s4.root_cause_analysis)}` });
      }
      if (Array.isArray(s4?.managerial_recommendations) && s4.managerial_recommendations.length > 0) {
        const recs = s4.managerial_recommendations.map((r: any) => txt(r)).filter(Boolean);
        if (recs.length > 0) blocks.push({ type: "list", items: recs });
      }
      if (errs.length > 0 && executedResults.every((r) => r.rowCount === 0)) {
        blocks.push({ type: "list", items: errs });
      }
      if (blocks.length === 0) blocks.push({ type: "paragraph", text: "پردازش انجام شد." });

      responseObjects.push({
        action: "answer",
        content: "",
        content_blocks: blocks,
        intent: detectedIntent,
        procedures: [],
        sql: "",
        chart: emptyChart,
        resolves: emptyResolves,
      });

      const check = readErpResponse(responseObjects);
      const tablesChecked = Array.isArray(res.discoveredTables) ? res.discoveredTables : [];

      const step: AssistantStep = {
        response: check.ok
          ? check.value
          : [
              {
                action: "answer",
                content: "",
                content_blocks: [{ type: "paragraph", text: txt(s4?.executive_summary) || "پاسخ آماده شد." }],
                intent: detectedIntent,
                procedures: [],
                sql: "",
                chart: emptyChart,
                resolves: emptyResolves,
              },
            ],
        ...(detectedIntent !== "answer" && {
          execution: { status: "executed", requests: executedResults.length, results: executedResults },
          liveSchema: { status: "verified", tables: tablesChecked },
        }),
      };

      await sendChunked({ type: "step", step });
      send({ type: "done", turnId: `${Date.now().toString(36)}-ok`, outcome: "final" });
    } catch (e: any) {
      if (!abort.signal.aborted) send({ type: "error", error: e?.message || "خطا در اجرای پایپ‌لاین" });
    } finally {
      try {
        controller.close();
      } catch {}
    }
  };

  return new Response(
    new ReadableStream({
      start(c) {
        void run(c);
      },
      cancel() {
        abort.abort();
      },
    }),
    {
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Accel-Buffering": "no",
      },
    }
  );
}
