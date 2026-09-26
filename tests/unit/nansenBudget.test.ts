import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// api_call_log writes go to a mocked pool: these tests never touch a database.
const { query } = vi.hoisted(() => ({
  query: vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [{ id: 'log-row' }] })),
}));
vi.mock('@/lib/db', () => ({ getPool: () => ({ query }) }));

import {
  NANSEN_CALL_BUDGET_CEILING,
  NansenBudgetError,
  NansenCallBudget,
  readNansenCallBudget,
  type NansenAttemptRecord,
} from '@/lib/nansen/budget';
import {
  computeRetryBackoffMs,
  fetchHistoricalScreener,
  HISTORICAL_SCREENER_PATH,
  NansenApiError,
  NansenInsufficientCreditsError,
} from '@/lib/nansen/client';
import { recordNansenAttempt } from '@/lib/repo/apiCallLog';

function jsonResponse(body: unknown, status: number, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

const OK_BODY = { pagination: { page: 1, per_page: 1, is_last_page: true }, data: [] };
const ok = () => jsonResponse(OK_BODY, 200, { 'x-request-id': 'req-ok', 'x-nansen-credits-used': '5' });
const unavailable = () => jsonResponse({ code: 'service_unavailable' }, 503, { 'retry-after': '0' });
const rateLimited = () => jsonResponse({ code: 'rate_limit_exceeded' }, 429, { 'retry-after': '0' });
const noCredits = () =>
  jsonResponse({ error: 'Forbidden', message: 'Insufficient credits', code: 'insufficient_credits' }, 403);

const request = (toDate = '2026-09-25') => ({ to_date: toDate, timeframe_days: 1, chains: ['solana'] });

function budget(maxNetworkCalls: number, attempts: NansenAttemptRecord[] = []) {
  return new NansenCallBudget({
    operation: 'test_op',
    maxNetworkCalls,
    recorder: async (a) => {
      attempts.push(a);
    },
  });
}

const ORIGINAL_FETCH = global.fetch;
const ORIGINAL_KEY = process.env.NANSEN_API_KEY;

beforeEach(() => {
  process.env.NANSEN_API_KEY = 'test-key-not-real';
  query.mockClear();
});

afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
  process.env.NANSEN_API_KEY = ORIGINAL_KEY;
  vi.restoreAllMocks();
});

describe('test-suite safety net (tests/setup.ts)', () => {
  it('runs without the real Nansen key and blocks any real request to nansen.ai', async () => {
    expect(ORIGINAL_KEY).toBeUndefined();
    await expect(
      ORIGINAL_FETCH('https://api.nansen.ai/api/v1beta1/token-screener/historical', { method: 'POST' }),
    ).rejects.toThrow(/Blocked real Nansen request/);
  });
});

describe('NansenCallBudget configuration', () => {
  it('refuses a budget below the operation’s required requests before anything runs', () => {
    expect(
      () => new NansenCallBudget({ operation: 'live_create', maxNetworkCalls: 1, requiredNetworkCalls: 2, recorder: async () => {} }),
    ).toThrow(expect.objectContaining({ code: 'nansen_budget_below_required' }));
  });

  it.each([0, -1, 1.5, NANSEN_CALL_BUDGET_CEILING + 1])('rejects budget %s', (max) => {
    expect(() => new NansenCallBudget({ operation: 'x', maxNetworkCalls: max, recorder: async () => {} })).toThrow(
      expect.objectContaining({ code: 'nansen_budget_invalid' }),
    );
  });

  it('reads the env budget, defaulting only when unset', () => {
    expect(readNansenCallBudget('MAX_X', 3, {})).toBe(3);
    expect(readNansenCallBudget('MAX_X', 3, { MAX_X: '' })).toBe(3);
    expect(readNansenCallBudget('MAX_X', 3, { MAX_X: '4' })).toBe(4);
    for (const bad of ['abc', '0', '-1', '2.5', String(NANSEN_CALL_BUDGET_CEILING + 1)]) {
      expect(() => readNansenCallBudget('MAX_X', 3, { MAX_X: bad })).toThrow(NansenBudgetError);
    }
  });
});

describe('Nansen client under a call budget (mocked fetch only)', () => {
  it('refuses the request past the budget before any network I/O', async () => {
    const fetchMock = vi.fn(async () => ok());
    global.fetch = fetchMock;
    const attempts: NansenAttemptRecord[] = [];
    const b = budget(2, attempts);

    await fetchHistoricalScreener(request('2026-09-23'), b);
    await fetchHistoricalScreener(request('2026-09-24'), b);
    await expect(fetchHistoricalScreener(request('2026-09-25'), b)).rejects.toMatchObject({
      code: 'nansen_budget_exhausted',
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(attempts).toHaveLength(2);
  });

  it('counts retries against the budget, so a retry cannot exceed it', async () => {
    const fetchMock = vi.fn(async () => unavailable());
    global.fetch = fetchMock;
    const attempts: NansenAttemptRecord[] = [];

    await expect(fetchHistoricalScreener(request(), budget(2, attempts))).rejects.toMatchObject({
      code: 'nansen_budget_exhausted',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(attempts.map((a) => a.httpStatus)).toEqual([503, 503]);
  });

  it('bounds retries at 3 attempts per request even with budget to spare', async () => {
    const fetchMock = vi.fn(async () => unavailable());
    global.fetch = fetchMock;

    await expect(fetchHistoricalScreener(request(), budget(10))).rejects.toBeInstanceOf(NansenApiError);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('a 429 storm never exceeds the budget across requests', async () => {
    const fetchMock = vi.fn(async () => rateLimited());
    global.fetch = fetchMock;
    const b = budget(3);

    await expect(fetchHistoricalScreener(request('2026-09-24'), b)).rejects.toMatchObject({ status: 429 });
    await expect(fetchHistoricalScreener(request('2026-09-25'), b)).rejects.toMatchObject({
      code: 'nansen_budget_exhausted',
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('403 insufficient_credits stops immediately: no retry, operation halted', async () => {
    const fetchMock = vi.fn(async () => noCredits());
    global.fetch = fetchMock;
    const attempts: NansenAttemptRecord[] = [];
    const b = budget(5, attempts);

    await expect(fetchHistoricalScreener(request('2026-09-24'), b)).rejects.toBeInstanceOf(
      NansenInsufficientCreditsError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(b.haltedReason).toBe('insufficient_credits');
    expect(attempts).toEqual([
      expect.objectContaining({ httpStatus: 403, isSuccess: false, errorCode: 'insufficient_credits' }),
    ]);

    // Budget left, but the operation is halted: nothing else goes out.
    await expect(fetchHistoricalScreener(request('2026-09-25'), b)).rejects.toMatchObject({
      code: 'nansen_operation_halted',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('treats 402 as insufficient credits', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ message: 'Payment Required' }, 402));
    global.fetch = fetchMock;

    await expect(fetchHistoricalScreener(request(), budget(5))).rejects.toMatchObject({
      code: 'insufficient_credits',
      retryable: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a 403 without credit wording (auth) is not retried and halts the operation', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ message: 'Forbidden', code: 'forbidden' }, 403));
    global.fetch = fetchMock;
    const b = budget(5);

    const err = await fetchHistoricalScreener(request(), b).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NansenApiError);
    expect(err).not.toBeInstanceOf(NansenInsufficientCreditsError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(b.haltedReason).toBe('auth_rejected');
  });

  it('records exactly one attempt per outbound request, including failures', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(unavailable())
      .mockResolvedValueOnce(ok());
    global.fetch = fetchMock;
    const attempts: NansenAttemptRecord[] = [];

    await fetchHistoricalScreener(request(), budget(3, attempts));

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(attempts).toHaveLength(3);
    expect(attempts.map((a) => [a.httpStatus, a.errorCode, a.isCacheHit])).toEqual([
      [null, 'network_error', false],
      [503, 'service_unavailable', false],
      [200, null, false],
    ]);
  }, 10_000);

  it('serves an identical request from cache without a network call or budget', async () => {
    const fetchMock = vi.fn(async () => ok());
    global.fetch = fetchMock;
    const attempts: NansenAttemptRecord[] = [];
    const b = budget(1, attempts);

    const first = await fetchHistoricalScreener(request(), b);
    const second = await fetchHistoricalScreener(request(), b);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second.meta.responseSha256).toBe(first.meta.responseSha256);
    expect(b.networkCallsUsed).toBe(1);
    expect(b.summary()).toMatchObject({ networkCalls: 1, cacheHits: 1, creditsUsed: 5 });
    expect(attempts.map((a) => a.isCacheHit)).toEqual([false, true]);
  });

  it('halts the operation when an attempt cannot be recorded', async () => {
    const fetchMock = vi.fn(async () => ok());
    global.fetch = fetchMock;
    const b = new NansenCallBudget({
      operation: 'test_op',
      maxNetworkCalls: 5,
      recorder: async () => {
        throw new Error('db down');
      },
    });

    await expect(fetchHistoricalScreener(request('2026-09-24'), b)).rejects.toMatchObject({
      code: 'nansen_audit_log_failed',
    });
    await expect(fetchHistoricalScreener(request('2026-09-25'), b)).rejects.toMatchObject({
      code: 'nansen_operation_halted',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry a malformed 2xx body', async () => {
    const fetchMock = vi.fn(async () => new Response('not json', { status: 200 }));
    global.fetch = fetchMock;

    await expect(fetchHistoricalScreener(request(), budget(5))).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('caps Retry-After and falls back to exponential backoff when it is not a number', () => {
    expect(computeRetryBackoffMs(1, '3600')).toBe(10_000);
    expect(computeRetryBackoffMs(1, '0.05')).toBe(50);
    expect(computeRetryBackoffMs(1, 'Wed, 21 Oct 2026 07:28:00 GMT')).toBe(250);
    expect(computeRetryBackoffMs(2, null)).toBe(500);
  });
});

describe('recordNansenAttempt → api_call_log', () => {
  it('writes one api_call_log row per mocked outbound request, tagged with the operation', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(unavailable()).mockResolvedValueOnce(ok());
    global.fetch = fetchMock;
    const b = new NansenCallBudget({ operation: 'live_create', maxNetworkCalls: 3, recorder: recordNansenAttempt });

    await fetchHistoricalScreener(request(), b);

    const inserts = query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO api_call_log'));
    expect(inserts).toHaveLength(fetchMock.mock.calls.length);
    const params = inserts.map(([, p]) => p as unknown[]);
    // endpoint, http_status, is_success, is_cache_hit, purpose
    expect(params.map((p) => [p[0], p[4], p[5], p[11], p[14]])).toEqual([
      [HISTORICAL_SCREENER_PATH, 503, false, false, 'live_create'],
      [HISTORICAL_SCREENER_PATH, 200, true, false, 'live_create'],
    ]);
  });

  it('stores a response-less network error as http_status 0', async () => {
    await recordNansenAttempt({
      operation: 'live_create',
      endpoint: HISTORICAL_SCREENER_PATH,
      requestTimestamp: new Date(),
      responseTimestamp: new Date(),
      durationMs: 1,
      httpStatus: null,
      isSuccess: false,
      nansenRequestId: null,
      quotedCredits: null,
      creditsUsed: null,
      creditsRemaining: null,
      errorCode: 'network_error',
      isCacheHit: false,
    });
    const params = query.mock.calls[0]?.[1] as unknown[];
    expect(params[4]).toBe(0);
    expect(params[10]).toBe('network_error');
  });
});
