import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * Mock-only proof that Live resolution queries only the candle data it needs, within
 * its budget. The transaction client is faked and fetch is mocked: nothing here
 * reaches Nansen or Postgres.
 */
const db = vi.hoisted(() => ({
  round: null as Record<string, unknown> | null,
  assets: [] as Array<{ slot: string; token_symbol: string; token_address: string }>,
  statements: [] as Array<{ sql: string; params: unknown[] }>,
}));
vi.mock('@/lib/db', () => ({
  getPool: () => {
    throw new Error('the pool must not be used: attempts go to the injected recorder');
  },
  withTransaction: async <T,>(fn: (client: unknown) => Promise<T>) =>
    fn({
      query: async (sql: string, params: unknown[] = []) => {
        db.statements.push({ sql, params });
        if (sql.includes('FROM rounds WHERE id = $1 FOR UPDATE')) return { rows: [db.round] };
        if (sql.includes('FROM round_assets WHERE round_id')) return { rows: db.assets };
        return { rows: [] };
      },
    }),
}));

import type { NansenAttemptRecord } from '@/lib/nansen/budget';
import { HISTORICAL_OHLCV_PATH } from '@/lib/nansen/client';
import { resolveLiveRound } from '@/lib/repo/live';
import { ELIGIBILITY_POLICY_VERSION } from '@/lib/domain/assetPolicy';

const ROUND_ID = '00000000-0000-4000-8000-000000000001';
const START = '2026-09-20T12:05:00.000Z';
const END = '2026-09-21T12:05:00.000Z';
const AFTER_DELAY = new Date(Date.parse(END) + 30 * 60 * 1000);

function candle(intervalStart: string, open: number) {
  return {
    interval_start: intervalStart,
    open,
    high: open,
    low: open,
    close: open,
    volume: 1,
    volume_usd: 1,
    market_cap: { open: null, high: null, low: null, close: null },
  };
}

function ohlcvResponse(tokenAddress: string, candles: unknown[], truncated = false) {
  return new Response(
    JSON.stringify({ chain: 'solana', token_address: tokenAddress, timeframe: '5m', data: candles, truncated, truncation_note: null }),
    { status: 200, headers: { 'x-request-id': `req-${tokenAddress}`, 'x-nansen-credits-used': '5' } },
  );
}

const fullCandles = (address: string) => ohlcvResponse(address, [candle(START, 1), candle(END, 1.1)]);
const unavailable = () => new Response(JSON.stringify({ code: 'service_unavailable' }), { status: 503, headers: { 'retry-after': '0' } });

function ohlcvFetch(handler: (tokenAddress: string) => Response) {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { token_address: string };
    return handler(body.token_address);
  });
}

const ORIGINAL_FETCH = global.fetch;
const ORIGINAL_KEY = process.env.NANSEN_API_KEY;
let attempts: NansenAttemptRecord[];
const recorder = async (a: NansenAttemptRecord) => {
  attempts.push(a);
};

beforeEach(() => {
  process.env.NANSEN_API_KEY = 'test-key-not-real';
  attempts = [];
  db.statements = [];
  db.round = {
    id: ROUND_ID,
    mode: 'live',
    status: 'open',
    chain: 'solana',
    cutoff: new Date(START),
    resolution_time: new Date(END),
    measurement_start_at: new Date(START),
    measurement_end_at: new Date(END),
    initial_commitment_hash: 'initial-hash',
    resolution_manifest: null,
    invalid_reason: null,
    eligibility_status: 'approved',
    eligibility_policy_version: ELIGIBILITY_POLICY_VERSION,
  };
  db.assets = [
    { slot: 'A', token_symbol: 'AAA', token_address: 'aaa-mint' },
    { slot: 'B', token_symbol: 'BBB', token_address: 'bbb-mint' },
    { slot: 'C', token_symbol: 'CCC', token_address: 'ccc-mint' },
  ];
});

afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
  process.env.NANSEN_API_KEY = ORIGINAL_KEY;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const statusUpdates = () =>
  db.statements.filter((s) => s.sql.startsWith('UPDATE rounds SET status')).map((s) => s.sql);

describe('Live resolution — credit guard (mocks only)', () => {
  it.each([
    ['pending review', { eligibility_status: 'pending_review', eligibility_policy_version: null }],
    ['withdrawn', { eligibility_status: 'withdrawn', eligibility_policy_version: ELIGIBILITY_POLICY_VERSION }],
    ['approved under an older policy', { eligibility_status: 'approved', eligibility_policy_version: ELIGIBILITY_POLICY_VERSION - 1 }],
  ])('refuses to resolve a round that is %s: no request, no verdict, no status change', async (_label, eligibility) => {
    const fetchMock = ohlcvFetch(fullCandles);
    global.fetch = fetchMock;
    db.round = { ...db.round!, ...eligibility };

    const result = await resolveLiveRound(ROUND_ID, { now: AFTER_DELAY, recordNansenAttempt: recorder });

    expect(result).toMatchObject({ ok: false, error: 'round_not_approved' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(attempts).toHaveLength(0);
    expect(statusUpdates()).toEqual([]);
  });

  it('makes zero Nansen requests until the exit candle can be indexed', async () => {
    const fetchMock = ohlcvFetch(fullCandles);
    global.fetch = fetchMock;

    const result = await resolveLiveRound(ROUND_ID, {
      now: new Date(Date.parse(END) + 5 * 60 * 1000),
      recordNansenAttempt: recorder,
    });

    expect(result).toMatchObject({ ok: false, error: 'market_data_not_yet_expected' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(statusUpdates()).toEqual([]);
  });

  it('sends exactly one 5m OHLCV request per slot, bounded by as_of_date, each logged with a receipt', async () => {
    const fetchMock = ohlcvFetch(fullCandles);
    global.fetch = fetchMock;

    const result = await resolveLiveRound(ROUND_ID, { now: AFTER_DELAY, recordNansenAttempt: recorder });

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    expect(bodies).toEqual(
      ['aaa-mint', 'bbb-mint', 'ccc-mint'].map((token_address) => ({
        chain: 'solana',
        token_address,
        date_from: '2026-09-20T00:00:00Z',
        as_of_date: '2026-09-21',
        timeframe: '5m',
      })),
    );
    expect(attempts).toHaveLength(3);
    expect(attempts.every((a) => a.operation === `live_resolve:${ROUND_ID}` && a.endpoint === HISTORICAL_OHLCV_PATH)).toBe(true);
    const receipts = db.statements.filter((s) => s.sql.includes('INSERT INTO source_receipts'));
    expect(receipts.map((r) => r.params[5])).toEqual(['req-aaa-mint', 'req-bbb-mint', 'req-ccc-mint']);
    if (result.ok) expect(result.nansen).toMatchObject({ networkCalls: 3, creditsUsed: 15 });
  });

  it('403 insufficient_credits stops after one request and does not invalidate the round', async () => {
    const fetchMock = ohlcvFetch(
      () => new Response(JSON.stringify({ message: 'Insufficient credits', code: 'insufficient_credits' }), { status: 403 }),
    );
    global.fetch = fetchMock;

    const result = await resolveLiveRound(ROUND_ID, { now: AFTER_DELAY, recordNansenAttempt: recorder });

    expect(result).toMatchObject({ ok: false, error: 'nansen_insufficient_credits' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(attempts).toHaveLength(1);
    expect(statusUpdates()).toEqual([`UPDATE rounds SET status = 'resolving' WHERE id = $1`]);
  });

  it.each([
    [401, 'nansen_auth_rejected'],
    [422, 'nansen_request_rejected'],
  ])('a %i is not reported as pending: one request, abort code %s', async (status, code) => {
    const fetchMock = ohlcvFetch(() => new Response(JSON.stringify({ code: 'rejected' }), { status }));
    global.fetch = fetchMock;

    const result = await resolveLiveRound(ROUND_ID, { now: AFTER_DELAY, recordNansenAttempt: recorder });

    expect(result).toMatchObject({ ok: false, error: code });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refuses a budget below the slot count with zero requests', async () => {
    vi.stubEnv('MAX_NANSEN_CALLS_PER_LIVE_RESOLVE', '2');
    const fetchMock = ohlcvFetch(fullCandles);
    global.fetch = fetchMock;

    const result = await resolveLiveRound(ROUND_ID, { now: AFTER_DELAY, recordNansenAttempt: recorder });

    expect(result).toMatchObject({ ok: false, error: 'nansen_budget_below_required' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('caps a retry storm at the resolve budget', async () => {
    const fetchMock = ohlcvFetch((address) => (address === 'aaa-mint' ? fullCandles(address) : unavailable()));
    global.fetch = fetchMock;

    const result = await resolveLiveRound(ROUND_ID, {
      now: AFTER_DELAY,
      maxNansenCalls: 3,
      recordNansenAttempt: recorder,
    });

    expect(result).toMatchObject({ ok: false, error: 'nansen_budget_exhausted' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(attempts).toHaveLength(3);
  });

  it('flags a truncated response instead of reporting it as merely pending', async () => {
    const fetchMock = ohlcvFetch((address) => ohlcvResponse(address, [candle(START, 1)], true));
    global.fetch = fetchMock;

    const result = await resolveLiveRound(ROUND_ID, { now: AFTER_DELAY, recordNansenAttempt: recorder });

    expect(result).toMatchObject({ ok: false, error: 'ohlcv_response_truncated' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
