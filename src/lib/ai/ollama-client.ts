import fs from 'fs/promises';
import path from 'path';

const URL = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434';
const MODEL = process.env.OLLAMA_PRIMARY_MODEL || 'qwen3:30b-fast';
const EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL || '';
const NUM_CTX = Number(process.env.OLLAMA_NUM_CTX) || 4096;

interface QueueItem {
  resolve: () => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  onAbort?: () => void;
  signal?: AbortSignal;
}

let activeLock = false;
const waitQueue: QueueItem[] = [];

async function acquireGpu(signal?: AbortSignal, maxWaitMs = 90000): Promise<void> {
  if (signal?.aborted) throw new Error('Request aborted before GPU queue');
  if (!activeLock && waitQueue.length === 0) {
    activeLock = true;
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const item: QueueItem = {
      resolve,
      reject,
      signal,
      timer: setTimeout(() => {
        const idx = waitQueue.indexOf(item);
        if (idx !== -1) waitQueue.splice(idx, 1);
        if (item.onAbort && signal) signal.removeEventListener('abort', item.onAbort);
        reject(new Error('GPU FIFO queue wait timeout (90s)'));
      }, maxWaitMs),
    };
    if (signal) {
      item.onAbort = () => {
        clearTimeout(item.timer);
        const idx = waitQueue.indexOf(item);
        if (idx !== -1) waitQueue.splice(idx, 1);
        reject(new Error('Request aborted while in GPU queue'));
      };
      signal.addEventListener('abort', item.onAbort, { once: true });
    }
    waitQueue.push(item);
  });
}

function releaseGpu(): void {
  while (waitQueue.length > 0) {
    const next = waitQueue.shift()!;
    clearTimeout(next.timer);
    if (next.onAbort && next.signal) {
      next.signal.removeEventListener('abort', next.onAbort);
    }
    if (next.signal?.aborted) continue;
    activeLock = true;
    next.resolve();
    return;
  }
  activeLock = false;
}

export const gpuSemaphore = {
  getStats: () => ({
    activeSessions: activeLock ? 1 : 0,
    queuedSessions: waitQueue.length,
    maxAllowed: 1,
  }),
};

export async function loadPromptTemplate(file: string, vars: Record<string, string>) {
  let t = await fs.readFile(path.join(process.cwd(), 'prompts', file), 'utf-8');
  for (const [k, v] of Object.entries(vars)) t = t.replaceAll(`{{${k}}}`, v);
  return t;
}

function extractJson(raw: string): any {
  let s = (raw || '').trim();
  const i = s.indexOf('{');
  if (i === -1) return {};
  s = s.slice(i).replace(/[\r\n\t]+/g, ' ');
  const j = s.lastIndexOf('}');
  if (j !== -1) {
    try { return JSON.parse(s.slice(0, j + 1)); } catch {}
  }
  for (const suf of ['', '"}', '"]}', '"}]}', '}]}', ']}', '}']) {
    try { return JSON.parse(s + suf); } catch {}
  }
  const intent = s.match(/"detected_intent"\s*:\s*"([^"]+)"/)?.[1] || 'query';
  const chart = s.match(/"chart_type"\s*:\s*"([^"]*)"/)?.[1] || '';
  const direct = s.match(/"direct_answer"\s*:\s*"([^"]*)"/)?.[1] || '';
  const sqls = [...s.matchAll(/"sql_query"\s*:\s*"((?:\\.|[^"\\])*)"/g)].map((m) => m[1].replace(/\\[nrt]/g, " ").replace(/\\"/g, '"').replace(/\\\\/g, "\\").trim());
  return {
    detected_intent: intent,
    chart_type: chart,
    direct_answer: direct,
    detected_domain: 'erp',
    verification: { goal: 'بررسی داده', sql_query: sqls[0] || '' },
    hypotheses: sqls.slice(1, 4).map((q, idx) => ({
      id: `H${idx + 1}`,
      domain: 'erp',
      statement: `تحلیل شاخص ${idx + 1}`,
      expected_metric: 'metric',
      sql_query: q,
    })),
  };
}

export async function generateStructured<T>(opts: {
  prompt: string;
  schema: any;
  temperature?: number;
  numPredict?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<{ data: T; durationMs: number }> {
  await acquireGpu(opts.signal);
  const start = Date.now();
  const maxMs = opts.timeoutMs ?? 35000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), maxMs);

  if (opts.signal) {
    if (opts.signal.aborted) ctrl.abort();
    else opts.signal.addEventListener('abort', () => ctrl.abort(), { once: true });
  }

  console.log(`  🤖 [LLM prompt=${opts.prompt.length} chars, q=${waitQueue.length}] started...`);

  try {
    const res = await fetch(`${URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ctrl.signal,
      body: JSON.stringify({
        model: MODEL,
        stream: true,
        think: false,
        keep_alive: -1,
        options: {
          num_ctx: NUM_CTX,
          temperature: opts.temperature ?? 0.1,
          num_predict: opts.numPredict ?? 680,
        },
        messages: [{ role: 'user', content: opts.prompt }],
      }),
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const reader = res.body?.getReader();
    const dec = new TextDecoder();
    let content = '', evalCount = 0, buf = '';
    if (reader) {
      const onAbort = () => { try { reader.cancel(); } catch {} };
      ctrl.signal.addEventListener('abort', onAbort, { once: true });
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done || ctrl.signal.aborted) break;
          buf += dec.decode(value, { stream: true });
          const lines = buf.split('\n');
          buf = lines.pop() || '';
          for (const l of lines) {
            if (!l.trim()) continue;
            try {
              const j = JSON.parse(l);
              if (j?.message?.content) content += j.message.content;
              if (j?.eval_count) evalCount = j.eval_count;
            } catch {}
          }
        }
      } finally {
        ctrl.signal.removeEventListener('abort', onAbort);
        try { reader.releaseLock(); } catch {}
      }
    }
    if (ctrl.signal.aborted && opts.signal?.aborted) throw new Error('Request aborted by user');
    console.log(`ok (${evalCount} tok in ${((Date.now() - start) / 1000).toFixed(1)}s)`);
    return { data: extractJson(content) as T, durationMs: Date.now() - start };
  } catch (e: any) {
    console.log(`timeout/stopped (${((Date.now() - start) / 1000).toFixed(1)}s: ${e?.message})`);
    return { data: {} as T, durationMs: Date.now() - start };
  } finally {
    clearTimeout(timer);
    ctrl.abort();
    releaseGpu();
  }
}

export async function embedText(text: string, signal?: AbortSignal): Promise<number[] | null> {
  if (!EMBED_MODEL) return null;
  await acquireGpu(signal, 15000);
  try {
    const res = await fetch(`${URL}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(4000)]) : AbortSignal.timeout(4000),
      body: JSON.stringify({ model: EMBED_MODEL, input: text, keep_alive: -1 }),
    });
    if (!res.ok) return null;
    const j = await res.json();
    return Array.isArray(j?.embeddings?.[0]) ? j.embeddings[0] : null;
  } catch {
    return null;
  } finally {
    releaseGpu();
  }
}
