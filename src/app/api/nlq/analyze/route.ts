import { NextRequest, NextResponse } from 'next/server';
import {
  runHypothesisGenesisPipeline,
  StageProgressEvent,
} from '@/lib/ai/hypothesis-engine';
import { gpuSemaphore } from '@/lib/ai/ollama-client';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const question = (body?.question || '').trim();
    const streamMode = body?.stream !== false;

    if (!question || question.length < 4) {
      return NextResponse.json(
        { error: 'Please provide a valid analytical question.' },
        { status: 400 }
      );
    }

    if (!streamMode) {
      const result = await runHypothesisGenesisPipeline(question);
      return NextResponse.json({
        ok: true,
        gpuQueue: gpuSemaphore.getStats(),
        result,
      });
    }

    const encoder = new TextEncoder();
    const readable = new ReadableStream({
      async start(controller) {
        const sendEvent = (type: string, data: unknown) => {
          const line = JSON.stringify({ type, timestamp: Date.now(), data }) + '\n';
          controller.enqueue(encoder.encode(line));
        };

        try {
          sendEvent('QUEUE_STATUS', gpuSemaphore.getStats());

          const finalResult = await runHypothesisGenesisPipeline(
            question,
            (stageEvent: StageProgressEvent) => {
              sendEvent('STAGE_UPDATE', stageEvent);
            }
          );

          sendEvent('FINAL_RESULT', finalResult);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          sendEvent('PIPELINE_ERROR', { error: message });
        } finally {
          controller.close();
        }
      },
    });

    return new Response(readable, {
      headers: {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'close',
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { ok: false, error: message },
      { status: 500 }
    );
  }
}
