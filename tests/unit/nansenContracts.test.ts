import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DOCUMENTED_CREDITS_PER_CALL, NansenBudgetError, NansenCallBudget, type NansenAttemptRecord } from '@/lib/nansen/budget';
import {
  CURRENT_SCREENER_PATH,
  fetchCurrentScreener,
  fetchHistoricalOhlcv,
  fetchHistoricalScreener,
  HISTORICAL_OHLCV_PATH,
  HISTORICAL_SCREENER_PATH,
} from '@/lib/nansen/client';
import {
  currentScreenerRequestSchema,
  currentScreenerResponseSchema,
  historicalOhlcvRequestSchema,
  historicalOhlcvResponseSchema,
  historicalScreenerRequestSchema,
  historicalScreenerResponseSchema,
  NansenContractError,
  utcDateOf,
  utcDateTimeOf,
} from '@/lib/nansen/contracts';

// No test here reaches Nansen: fetch is mocked, and tests/setup.ts blocks *.nansen.ai.
const ORIGINAL_FETCH = global.fetch;
beforeEach(() => {
  process.env.NANSEN_API_KEY = 'test-key-not-real';
});
afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
  delete process.env.NANSEN_API_KEY;
  vi.restoreAllMocks();
});

function budget(recorded: NansenAttemptRecord[] = [], maxNetworkCalls = 3, maxCredits?: number) {
  return new NansenCallBudget({ operation: 'test', maxNetworkCalls, maxCredits, recorder: async (r) => void recorded.push(r) });
}
const ok = (body: unknown, credits = '5') =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'x-request-id': 'r1', 'x-nansen-credits-used': credits } });

const SCREENER_OK = { to_date: '2026-09-16', timeframe_days: 1, chains: ['solana'], pagination: { page: 1, per_page: 50 } };
const CURRENT_OK = { chains: ['solana'], timeframe: '24h' as const, filters: { liquidity: { min: 100_000 }, sectors: ['Memecoins'] } };
const OHLCV_OK = {
  chain: 'solana' as const,
  token_address: 'tok',
  date_from: '2026-09-16T00:00:00Z',
  timeframe: '1h' as const,
  as_of_date: '2026-09-25',
};

describe('Saved raw Nansen traffic matches the official contracts', () => {
  const dir = join(process.cwd(), '.nansen-raw');
  // Real, private responses from the 2026-09-26 runs when present; otherwise the documented
  // shapes below, so this test always validates something and is never skipped.
  const saved = existsSync(dir)
    ? readdirSync(dir).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as { endpoint: string; requestBody: unknown; body: string })
    : [];
  const documented = [
    { endpoint: HISTORICAL_SCREENER_PATH, requestBody: SCREENER_OK, body: JSON.stringify({ pagination: { page: 1, per_page: 50, is_last_page: true }, data: [{ token_address: 'a', token_symbol: 'A', chain: 'solana', price_usd: 1, price_change: 0.1, market_cap_usd: 1, fdv: 1, fdv_mc_ratio: 1, volume: 1, buy_volume: 1, sell_volume: 0, netflow: 1, inflow_fdv_ratio: null, outflow_fdv_ratio: null, token_age_days: 40, liquidity: 1, sectors: ['Memecoins'] }] }) },
    { endpoint: CURRENT_SCREENER_PATH, requestBody: CURRENT_OK, body: JSON.stringify({ pagination: { page: 1, per_page: 100, is_last_page: false }, data: [{ token_address: 'a', token_symbol: 'A', chain: 'solana', price_usd: 1, price_change: 0.1, market_cap_usd: 1, volume: 1, buy_volume: 1, sell_volume: 0, netflow: 1, token_age_days: 40, liquidity: 1 }] }) },
    { endpoint: HISTORICAL_OHLCV_PATH, requestBody: OHLCV_OK, body: JSON.stringify({ chain: 'solana', token_address: 'tok', timeframe: '1h', data: [{ interval_start: '2026-09-16T00:00:00Z', open: 1, high: 1, low: 1, close: 1, volume: 1, volume_usd: 1, market_cap: { open: null, high: null, low: null, close: null } }], truncated: false, truncation_note: null }) },
  ];
  const contracts: Record<string, [typeof historicalScreenerRequestSchema | typeof currentScreenerRequestSchema | typeof historicalOhlcvRequestSchema, typeof historicalScreenerResponseSchema | typeof currentScreenerResponseSchema | typeof historicalOhlcvResponseSchema]> = {
    [HISTORICAL_SCREENER_PATH]: [historicalScreenerRequestSchema, historicalScreenerResponseSchema],
    [CURRENT_SCREENER_PATH]: [currentScreenerRequestSchema, currentScreenerResponseSchema],
    [HISTORICAL_OHLCV_PATH]: [historicalOhlcvRequestSchema, historicalOhlcvResponseSchema],
  };

  it(`every request we sent and every response Nansen returned validates (${saved.length} saved + ${documented.length} documented)`, () => {
    const failures: string[] = [];
    for (const entry of [...saved, ...documented]) {
      const [req, res] = contracts[entry.endpoint]!;
      const r1 = req.safeParse(entry.requestBody);
      const r2 = res.safeParse(JSON.parse(entry.body));
      if (!r1.success) failures.push(`${entry.endpoint} request: ${r1.error.issues[0]?.message}`);
      if (!r2.success) failures.push(`${entry.endpoint} response: ${r2.error.issues[0]?.path.join('.')} ${r2.error.issues[0]?.message}`);
    }
    expect(failures).toEqual([]);
  });
});

describe('Invalid requests fail before budget reservation and before any network request', () => {
  const invalid: Array<[string, () => Promise<unknown>]> = [
    ['to_date not zero-padded', () => fetchHistoricalScreener({ ...SCREENER_OK, to_date: '2026-9-1' }, b)],
    ['to_date as a datetime (the field is date-only)', () => fetchHistoricalScreener({ ...SCREENER_OK, to_date: '2026-09-01T00:00:00Z' }, b)],
    ['to_date not a real date', () => fetchHistoricalScreener({ ...SCREENER_OK, to_date: '2026-02-30' }, b)],
    ['timeframe_days 0', () => fetchHistoricalScreener({ ...SCREENER_OK, timeframe_days: 0 }, b)],
    ['per_page above 1000', () => fetchHistoricalScreener({ ...SCREENER_OK, pagination: { page: 1, per_page: 1001 } }, b)],
    ['historical filter named like the current one', () => fetchHistoricalScreener({ ...SCREENER_OK, filters: { liquidity: { min: 1 } } } as never, b)],
    ['current timeframe not in the enum', () => fetchCurrentScreener({ ...CURRENT_OK, timeframe: '2d' } as never, b)],
    ['current filter named like the historical one', () => fetchCurrentScreener({ ...CURRENT_OK, filters: { liquidity_usd: { min: 1 } } } as never, b)],
    ['OHLCV with both as_of_date and as_of_ts', () => fetchHistoricalOhlcv({ ...OHLCV_OK, as_of_ts: '2026-09-25T00:00:00Z' }, b)],
    ['OHLCV with neither as_of bound', () => fetchHistoricalOhlcv({ ...OHLCV_OK, as_of_date: undefined }, b)],
    ['OHLCV as_of_date as a datetime', () => fetchHistoricalOhlcv({ ...OHLCV_OK, as_of_date: '2026-09-25T00:00:00Z' }, b)],
    ['OHLCV date_from with a local offset (not UTC)', () => fetchHistoricalOhlcv({ ...OHLCV_OK, date_from: '2026-09-16T00:00:00+02:00' }, b)],
    ['OHLCV date_from after the as-of bound', () => fetchHistoricalOhlcv({ ...OHLCV_OK, date_from: '2026-09-27' }, b)],
    ['OHLCV blacklist filter on a low timeframe', () => fetchHistoricalOhlcv({ ...OHLCV_OK, apply_blacklist_filter: true } as never, b)],
  ];
  let b: NansenCallBudget;
  let recorded: NansenAttemptRecord[];

  it.each(invalid)('%s', async (_name, call) => {
    recorded = [];
    b = budget(recorded);
    const fetchMock = vi.fn();
    global.fetch = fetchMock;
    const err = (await call().catch((e: unknown) => e)) as NansenContractError;
    expect(err).toBeInstanceOf(NansenContractError);
    expect(err.code).toBe('request_schema_invalid');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(b.networkCallsUsed).toBe(0);
    expect(recorded).toHaveLength(0);
  });

  it('accepts both documented date_from forms: a bare date and a UTC datetime', () => {
    expect(historicalOhlcvRequestSchema.safeParse({ ...OHLCV_OK, date_from: '2026-09-16' }).success).toBe(true);
    expect(historicalOhlcvRequestSchema.safeParse({ ...OHLCV_OK, date_from: '2026-09-16T00:00:00Z' }).success).toBe(true);
  });
});

describe('An HTTP 200 still fails closed when the response is not the documented shape', () => {
  it('a 200 with the wrong shape halts the operation; nothing further is sent', async () => {
    const recorded: NansenAttemptRecord[] = [];
    const b = budget(recorded);
    global.fetch = vi.fn(async () => ok({ data: 'not an array' }));
    const err = await fetchHistoricalScreener(SCREENER_OK, b).catch((e) => e);
    expect(err).toBeInstanceOf(NansenContractError);
    expect(err.code).toBe('response_schema_invalid');
    expect(recorded).toHaveLength(1); // the served, billed call is still logged
    expect(b.haltedReason).toBe('malformed_response');
    await expect(fetchHistoricalScreener({ ...SCREENER_OK, timeframe_days: 7 }, b)).rejects.toMatchObject({
      code: 'nansen_operation_halted',
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('a 200 candle with a string price is rejected, not coerced', async () => {
    const b = budget();
    global.fetch = vi.fn(async () =>
      ok({ chain: 'solana', token_address: 'tok', timeframe: '1h', data: [{ interval_start: '2026-09-16T00:00:00Z', open: '1', high: 1, low: 1, close: 1, volume: 1, volume_usd: 1 }], truncated: false, truncation_note: null }),
    );
    await expect(fetchHistoricalOhlcv(OHLCV_OK, b)).rejects.toMatchObject({ code: 'response_schema_invalid' });
  });

  it('a 200 whose body is not JSON halts the operation', async () => {
    const b = budget();
    global.fetch = vi.fn(async () => new Response('<html>gateway</html>', { status: 200 }));
    await expect(fetchCurrentScreener(CURRENT_OK, b)).rejects.toMatchObject({ code: 'response_not_json' });
    expect(b.haltedReason).toBe('malformed_response');
  });

  it('an empty successful response is valid transport, left for the caller to fail closed', async () => {
    global.fetch = vi.fn(async () => ok({ pagination: { page: 1, per_page: 50, is_last_page: true }, data: [] }));
    const res = await fetchHistoricalScreener(SCREENER_OK, budget());
    expect(res.data.data).toEqual([]);
  });
});

describe('Hard credit caps', () => {
  it('uses the documented price of each endpoint', () => {
    expect(DOCUMENTED_CREDITS_PER_CALL[HISTORICAL_SCREENER_PATH]).toBe(5);
    expect(DOCUMENTED_CREDITS_PER_CALL[HISTORICAL_OHLCV_PATH]).toBe(5);
    expect(DOCUMENTED_CREDITS_PER_CALL[CURRENT_SCREENER_PATH]).toBe(1);
  });

  it('refuses the request that would exceed the cap, before it is sent', async () => {
    const b = budget([], 5, 9);
    global.fetch = vi.fn(async () => ok({ pagination: { page: 1, per_page: 50, is_last_page: true }, data: [] }));
    await fetchHistoricalScreener(SCREENER_OK, b); // 5 of 9
    const err = await fetchHistoricalScreener({ ...SCREENER_OK, timeframe_days: 7 }, b).catch((e) => e);
    expect(err).toBeInstanceOf(NansenBudgetError);
    expect(err.code).toBe('nansen_credit_cap');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('refuses an endpoint with no documented price when a credit cap is set', () => {
    const b = budget([], 5, 50);
    expect(() => b.reserveNetworkCall('/api/v1/unknown')).toThrow(/No documented credit price/);
  });
});

describe('UTC normalization of request dates', () => {
  it('formats the UTC calendar date, never the local one', () => {
    expect(utcDateOf(new Date('2026-09-05T23:30:00-05:00'))).toBe('2026-09-06');
    expect(utcDateOf(new Date('2026-09-06T00:30:00+02:00'))).toBe('2026-09-05');
    expect(utcDateTimeOf(new Date('2026-08-19T02:00:00+02:00'))).toBe('2026-08-19T00:00:00Z');
  });
});

describe('A server without a key cannot spend credits', () => {
  it('an empty NANSEN_API_KEY (as the e2e server runs) refuses before any budget, log or network', async () => {
    process.env.NANSEN_API_KEY = '';
    const recorded: NansenAttemptRecord[] = [];
    const b = budget(recorded);
    const fetchMock = vi.fn();
    global.fetch = fetchMock;
    await expect(fetchHistoricalScreener(SCREENER_OK, b)).rejects.toThrow(/NANSEN_API_KEY is not set/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(b.networkCallsUsed).toBe(0);
    expect(recorded).toHaveLength(0);
  });
});
