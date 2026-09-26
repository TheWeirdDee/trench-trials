import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NansenCallBudget, type NansenAttemptRecorder } from '@/lib/nansen/budget';
import { fetchHistoricalScreener, NansenApiError } from '@/lib/nansen/client';

function testBudget(recorder: NansenAttemptRecorder = async () => {}) {
  return new NansenCallBudget({ operation: 'test', maxNetworkCalls: 3, recorder });
}

function jsonResponse(body: unknown, status: number, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

const ORIGINAL_FETCH = global.fetch;
const ORIGINAL_KEY = process.env.NANSEN_API_KEY;

beforeEach(() => {
  process.env.NANSEN_API_KEY = 'test-key-not-real';
});

afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
  process.env.NANSEN_API_KEY = ORIGINAL_KEY;
  vi.restoreAllMocks();
});

describe('fetchHistoricalScreener', () => {
  it('refuses to call the API when NANSEN_API_KEY is unset — no fallback, fails closed', async () => {
    delete process.env.NANSEN_API_KEY;
    global.fetch = vi.fn();
    await expect(
      fetchHistoricalScreener({ to_date: '2026-08-20', timeframe_days: 1, chains: ['solana'] }, testBudget()),
    ).rejects.toThrow(/NANSEN_API_KEY/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('parses a successful response and its credit/request headers', async () => {
    const body = { pagination: { page: 1, per_page: 1, is_last_page: true }, data: [] };
    global.fetch = vi.fn().mockResolvedValue(
      jsonResponse(body, 200, {
        'x-request-id': 'req-123',
        'x-nansen-credits-cost': '5',
        'x-nansen-credits-used': '5',
        'x-nansen-credits-remaining': '43',
      }),
    );

    const result = await fetchHistoricalScreener(
      {
        to_date: '2026-08-20',
        timeframe_days: 1,
        chains: ['solana'],
      },
      testBudget(),
    );

    expect(result.data).toEqual(body);
    expect(result.meta.status).toBe(200);
    expect(result.meta.requestId).toBe('req-123');
    expect(result.meta.creditsUsed).toBe(5);
    expect(result.meta.creditsRemaining).toBe(43);
    expect(result.meta.responseSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not retry a 422 validation error and throws with the parsed error code', async () => {
    global.fetch = vi.fn().mockResolvedValue(
      jsonResponse(
        { error: 'Unknown field', message: 'bad field', code: 'unknown_field', status: 422 },
        422,
      ),
    );

    await expect(
      fetchHistoricalScreener({ to_date: '2026-08-20', timeframe_days: 1, chains: ['solana'] }, testBudget()),
    ).rejects.toMatchObject({ status: 422, code: 'unknown_field' } satisfies Partial<NansenApiError>);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('retries a 429 with backoff and succeeds on the second attempt', async () => {
    const body = { pagination: { page: 1, per_page: 1, is_last_page: true }, data: [] };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ error: 'rate limited', message: 'slow down', code: 'rate_limit_exceeded', status: 429 }, 429, {
          'retry-after': '0.05',
        }),
      )
      .mockResolvedValueOnce(jsonResponse(body, 200));
    global.fetch = fetchMock;

    const result = await fetchHistoricalScreener(
      {
        to_date: '2026-08-20',
        timeframe_days: 1,
        chains: ['solana'],
      },
      testBudget(),
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.meta.status).toBe(200);
    expect(result.meta.attempts).toBe(2);
  }, 10_000);

  it('gives up after repeated network errors and surfaces the failure', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    await expect(
      fetchHistoricalScreener({ to_date: '2026-08-20', timeframe_days: 1, chains: ['solana'] }, testBudget()),
    ).rejects.toThrow();
  }, 10_000);

  it('records every HTTP attempt, including failed ones', async () => {
    const recorder = vi.fn(async () => {});
    global.fetch = vi.fn().mockResolvedValue(
      jsonResponse({ error: 'bad', message: 'bad', code: 'invalid_field_value', status: 400 }, 400),
    );

    await expect(
      fetchHistoricalScreener(
        { to_date: '2026-08-20', timeframe_days: 1, chains: ['solana'] },
        testBudget(recorder),
      ),
    ).rejects.toThrow();

    expect(recorder).toHaveBeenCalledTimes(1);
    expect(recorder).toHaveBeenCalledWith(
      expect.objectContaining({ isSuccess: false, httpStatus: 400, errorCode: 'invalid_field_value' }),
    );
  });
});
