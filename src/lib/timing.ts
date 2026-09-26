import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Development/test request timing. Off unless TT_TIMING=1: then each wrapped request logs
 * its spans to the server log, and outside production also returns them as a
 * Server-Timing header. Production responses never carry timings.
 */

interface Span {
  label: string;
  ms: number;
}

const spansStore = new AsyncLocalStorage<Span[]>();

export function timingEnabled(): boolean {
  return process.env.TT_TIMING === '1';
}

/** Times `fn` as one span of the current request, if the request is being timed. */
export async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const spans = spansStore.getStore();
  if (!spans) return fn();
  const start = performance.now();
  try {
    return await fn();
  } finally {
    spans.push({ label, ms: performance.now() - start });
  }
}

export async function withRequestTiming(name: string, handler: () => Promise<Response>): Promise<Response> {
  if (!timingEnabled()) return handler();
  const spans: Span[] = [];
  const start = performance.now();
  const response = await spansStore.run(spans, handler);
  const total = performance.now() - start;
  console.log(
    `[timing] ${name} ${spans.map((s) => `${s.label}=${Math.round(s.ms)}ms`).join(' ')} total=${Math.round(total)}ms`,
  );
  if (process.env.NODE_ENV !== 'production') {
    response.headers.set(
      'Server-Timing',
      [...spans.map((s) => `${s.label.replace(/[^\w.-]/g, '_')};dur=${s.ms.toFixed(1)}`), `total;dur=${total.toFixed(1)}`].join(
        ', ',
      ),
    );
  }
  return response;
}
