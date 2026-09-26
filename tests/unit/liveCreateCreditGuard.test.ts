import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computeLiveSchedule } from '@/lib/domain/live';
import type { NansenAttemptRecord } from '@/lib/nansen/budget';
import { CURRENT_SCREENER_PATH, type CurrentScreenerRow } from '@/lib/nansen/client';
import type { CreateLiveRoundParams } from '@/lib/repo/live';
import {
  buildLiveScreenerRequests,
  createRealLiveSnapshot,
  detectPriceChangeScale,
  LiveCreateError,
  type LiveSnapshotDeps,
} from '@/lib/services/liveSnapshot';

/*
 * Mock-only proof that one Live creation cannot burn uncontrolled Nansen credits.
 * fetch is mocked, and the DB is replaced by injected deps: nothing here reaches
 * Nansen or Postgres, and no round or receipt is persisted anywhere.
 */

const NOW = new Date('2026-09-26T12:00:00.000Z');

/** Shaped like a real current-screener row: that endpoint returns no `sectors` field. */
function row(symbol: string, address: string, overrides: Partial<CurrentScreenerRow> = {}): CurrentScreenerRow {
  return {
    token_address: address,
    token_symbol: symbol,
    chain: 'solana',
    price_usd: 1,
    price_change: 0.1,
    market_cap_usd: 50_000_000,
    fdv: 60_000_000,
    fdv_mc_ratio: 1.2,
    volume: 1_000_000,
    buy_volume: 600_000,
    sell_volume: 400_000,
    netflow: 20_000,
    inflow_fdv_ratio: null,
    outflow_fdv_ratio: null,
    token_age_days: 100,
    liquidity: 2_000_000,
    ...overrides,
  };
}

const DAY1_ROWS = [
  row('USDC', 'usdc-mint'), // excluded symbol
  row('CBBTC', 'cbbtc-mint'), // wrapped major, excluded
  row('AAA', 'aaa-mint'),
  row('BBB', 'bbb-mint', { buy_volume: 300_000, sell_volume: 700_000 }),
  row('CCC', 'ccc-mint', { netflow: -300_000 }),
  row('DDD', 'ddd-mint'),
];
const DAY7_ROWS = [
  row('USDC', 'usdc-mint', { volume: 7_000_000, price_change: 0 }),
  row('CBBTC', 'cbbtc-mint', { volume: 7_000_000, price_change: 0.03 }),
  row('AAA', 'aaa-mint', { volume: 7_000_000, price_change: 0.2 }),
  row('BBB', 'bbb-mint', { volume: 3_500_000, price_change: -0.1 }),
  row('CCC', 'ccc-mint', { volume: 14_000_000, price_change: 0.01 }),
  row('DDD', 'ddd-mint', { volume: 7_000_000, price_change: 0.05 }),
];

function screenerText(rows: CurrentScreenerRow[]): string {
  return JSON.stringify({ pagination: { page: 1, per_page: 50, is_last_page: true }, data: rows });
}

function screenerResponse(rows: CurrentScreenerRow[], requestId: string): Response {
  return new Response(screenerText(rows), {
    status: 200,
    // The current token screener costs 1 credit per request (Nansen pricing docs).
    headers: { 'x-request-id': requestId, 'x-nansen-credits-used': '1', 'x-nansen-credits-remaining': '100' },
  });
}

const noCredits = () =>
  new Response(JSON.stringify({ message: 'Insufficient credits', code: 'insufficient_credits' }), { status: 403 });
const unavailable = () => new Response(JSON.stringify({ code: 'service_unavailable' }), { status: 503, headers: { 'retry-after': '0' } });

/** fetch mock that routes on the request body's timeframe ('24h' → 1, '7d' → 7). */
function routeFetch(handler: (timeframeDays: number, callNumber: number) => Response | Promise<Response>) {
  let n = 0;
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { timeframe: string };
    return handler(body.timeframe === '24h' ? 1 : 7, ++n);
  });
}

const happyFetch = () =>
  routeFetch((days) => (days === 1 ? screenerResponse(DAY1_ROWS, 'req-day1') : screenerResponse(DAY7_ROWS, 'req-day7')));

function makeDeps(initialActive: { id: string; status: string } | null = null) {
  const created: CreateLiveRoundParams[] = [];
  const attempts: NansenAttemptRecord[] = [];
  let active = initialActive;
  const deps: LiveSnapshotDeps = {
    findActiveLiveRound: vi.fn(async () => active),
    createLiveRound: vi.fn(async (params: CreateLiveRoundParams) => {
      created.push(params);
      active = { id: `round-${created.length}`, status: 'open' };
      return {
        roundId: active.id,
        commitmentHash: 'commitment',
        schedule: computeLiveSchedule(params.snapshotPublishedAt ?? NOW),
        alreadyExisted: false,
      };
    }),
    recordNansenAttempt: vi.fn(async (a: NansenAttemptRecord) => {
      attempts.push(a);
    }),
    now: () => NOW,
  };
  return { deps, created, attempts };
}

async function expectLiveCreateError(p: Promise<unknown>): Promise<LiveCreateError> {
  const err = await p.then(
    () => {
      throw new Error('expected Live creation to fail');
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(LiveCreateError);
  return err as LiveCreateError;
}

const ORIGINAL_FETCH = global.fetch;
const ORIGINAL_KEY = process.env.NANSEN_API_KEY;

beforeEach(() => {
  process.env.NANSEN_API_KEY = 'test-key-not-real';
});

afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
  process.env.NANSEN_API_KEY = ORIGINAL_KEY;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('Live creation — credit guard (mocks only)', () => {
  it('creates one round with exactly 2 Nansen requests, each logged, and receipts only from served responses', async () => {
    const fetchMock = happyFetch();
    global.fetch = fetchMock;
    const { deps, created, attempts } = makeDeps();

    const result = await createRealLiveSnapshot({}, deps);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.nansenCalls).toBe(2);
    expect(result.toDateStr).toBe('2026-09-26');
    expect(result.candidateSymbols).toEqual(['AAA', 'BBB', 'CCC']);

    // One api_call_log record per outbound request.
    expect(attempts).toHaveLength(fetchMock.mock.calls.length);
    expect(attempts.every((a) => a.operation === 'live_create' && a.endpoint === CURRENT_SCREENER_PATH)).toBe(true);
    expect(attempts.every((a) => a.isSuccess && !a.isCacheHit)).toBe(true);

    // Exactly one round, inserted under the single-active-round guard.
    expect(created).toHaveLength(1);
    const params = created[0]!;
    expect(params.requireNoActiveLiveRound).toBe(true);
    expect(params.assets.map((a) => a.slot)).toEqual(['A', 'B', 'C']);

    // Receipts: one per served response, hash of the exact bytes Nansen returned,
    // full request body, and a request ID that also appears in the call log.
    const [day1Req, day7Req] = buildLiveScreenerRequests('solana');
    const receipts = params.sourceReceipts ?? [];
    expect(receipts).toHaveLength(2);
    expect(receipts.map((r) => r.responseSha256)).toEqual([
      createHash('sha256').update(screenerText(DAY1_ROWS)).digest('hex'),
      createHash('sha256').update(screenerText(DAY7_ROWS)).digest('hex'),
    ]);
    expect(receipts.map((r) => r.requestParams)).toEqual([day1Req, day7Req]);
    expect(receipts.map((r) => r.requestId)).toEqual(['req-day1', 'req-day7']);
    const loggedIds = new Set(attempts.map((a) => a.nansenRequestId));
    expect(receipts.every((r) => loggedIds.has(r.requestId ?? null))).toBe(true);
  });

  it('refuses while a Live round is unresolved, with zero Nansen requests', async () => {
    const fetchMock = happyFetch();
    global.fetch = fetchMock;
    const { deps, created, attempts } = makeDeps({ id: 'existing', status: 'open' });

    const err = await expectLiveCreateError(createRealLiveSnapshot({}, deps));

    expect(err.code).toBe('active_live_round_exists');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(created).toHaveLength(0);
    expect(attempts).toHaveLength(0);
  });

  it('a duplicate creation does not trigger another ingestion', async () => {
    const fetchMock = happyFetch();
    global.fetch = fetchMock;
    const { deps, created } = makeDeps();

    await createRealLiveSnapshot({}, deps);
    const err = await expectLiveCreateError(createRealLiveSnapshot({}, deps));

    expect(err.code).toBe('active_live_round_exists');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(created).toHaveLength(1);
  });

  it('403 insufficient_credits on the first request stops immediately: 1 request, no round', async () => {
    const fetchMock = routeFetch(() => noCredits());
    global.fetch = fetchMock;
    const { deps, created, attempts } = makeDeps();

    const err = await expectLiveCreateError(createRealLiveSnapshot({}, deps));

    expect(err.code).toBe('nansen_insufficient_credits');
    expect(err.nansen).toMatchObject({ networkCalls: 1, haltedReason: 'insufficient_credits' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(attempts).toEqual([expect.objectContaining({ httpStatus: 403, errorCode: 'insufficient_credits' })]);
    expect(created).toHaveLength(0);
  });

  it('403 insufficient_credits on the second request: 2 requests, no round, no receipts', async () => {
    const fetchMock = routeFetch((days) => (days === 1 ? screenerResponse(DAY1_ROWS, 'req-day1') : noCredits()));
    global.fetch = fetchMock;
    const { deps, created, attempts } = makeDeps();

    const err = await expectLiveCreateError(createRealLiveSnapshot({}, deps));

    expect(err.code).toBe('nansen_insufficient_credits');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(attempts).toHaveLength(2);
    expect(created).toHaveLength(0);
  });

  it('an auth rejection stops after 1 request with its own code', async () => {
    const fetchMock = routeFetch(() => new Response(JSON.stringify({ code: 'forbidden' }), { status: 403 }));
    global.fetch = fetchMock;
    const { deps, created } = makeDeps();

    const err = await expectLiveCreateError(createRealLiveSnapshot({}, deps));

    expect(err.code).toBe('nansen_auth_rejected');
    expect(err.nansen?.haltedReason).toBe('auth_rejected');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(created).toHaveLength(0);
  });

  it.each([2, 3, 4, 5])(
    'never exceeds MAX_NANSEN_CALLS_PER_LIVE_CREATE=%i under a retry storm',
    async (max) => {
      vi.stubEnv('MAX_NANSEN_CALLS_PER_LIVE_CREATE', String(max));
      // This test is about the call cap; give the credit cap room for every allowed attempt.
      vi.stubEnv('MAX_NANSEN_CREDITS_PER_LIVE_CREATE', String(max));
      // Day-1 needs one retry; day-7 never recovers.
      const fetchMock = routeFetch((days, n) =>
        days === 1 && n > 1 ? screenerResponse(DAY1_ROWS, 'req-day1') : unavailable(),
      );
      global.fetch = fetchMock;
      const { deps, created, attempts } = makeDeps();

      const err = await expectLiveCreateError(createRealLiveSnapshot({}, deps));

      expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(max);
      expect(attempts).toHaveLength(fetchMock.mock.calls.length);
      expect(err.nansen?.networkCalls).toBe(fetchMock.mock.calls.length);
      expect(err.code).toBe(max < 5 ? 'nansen_budget_exhausted' : 'nansen_request_failed');
      expect(created).toHaveLength(0);
    },
  );

  it('defaults to a budget of 3 requests when MAX_NANSEN_CALLS_PER_LIVE_CREATE is unset', async () => {
    vi.stubEnv('MAX_NANSEN_CALLS_PER_LIVE_CREATE', '');
    const fetchMock = routeFetch(() => unavailable());
    global.fetch = fetchMock;
    const { deps } = makeDeps();

    const err = await expectLiveCreateError(createRealLiveSnapshot({}, deps));

    // Day-1 exhausts its 3 attempts; day-7 is never sent.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(err.nansen?.maxNetworkCalls).toBe(3);
  });

  it('bounds network-error retries and logs each attempt', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('ECONNRESET');
    });
    global.fetch = fetchMock;
    const { deps, created, attempts } = makeDeps();

    const err = await expectLiveCreateError(createRealLiveSnapshot({}, deps));

    expect(err.code).toBe('nansen_request_failed');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(attempts.map((a) => a.httpStatus)).toEqual([null, null, null]);
    expect(created).toHaveLength(0);
  }, 10_000);

  it('refuses a budget below the 2 required requests before any request', async () => {
    vi.stubEnv('MAX_NANSEN_CALLS_PER_LIVE_CREATE', '1');
    const fetchMock = happyFetch();
    global.fetch = fetchMock;
    const { deps } = makeDeps();

    const err = await expectLiveCreateError(createRealLiveSnapshot({}, deps));

    expect(err.code).toBe('nansen_budget_below_required');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(deps.findActiveLiveRound).not.toHaveBeenCalled();
  });

  it.each(['25', 'abc', '0'])('refuses MAX_NANSEN_CALLS_PER_LIVE_CREATE=%s before any request', async (value) => {
    vi.stubEnv('MAX_NANSEN_CALLS_PER_LIVE_CREATE', value);
    const fetchMock = happyFetch();
    global.fetch = fetchMock;

    const err = await expectLiveCreateError(createRealLiveSnapshot({}, makeDeps().deps));

    expect(err.code).toBe('nansen_budget_invalid');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an invalid timing config before any request', async () => {
    const fetchMock = happyFetch();
    global.fetch = fetchMock;

    const err = await expectLiveCreateError(
      createRealLiveSnapshot({ timingConfig: { horizonHours: 1 } }, makeDeps().deps),
    );

    expect(err.code).toBe('invalid_timing_config');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('failed candidate generation creates no round and no receipts — no fake fallback', async () => {
    // Only AAA and BBB are usable: CCC and DDD have zero liquidity.
    const day1 = DAY1_ROWS.map((r) => (['CCC', 'DDD'].includes(r.token_symbol) ? { ...r, liquidity: 0 } : r));
    const fetchMock = routeFetch((days) =>
      days === 1 ? screenerResponse(day1, 'req-day1') : screenerResponse(DAY7_ROWS, 'req-day7'),
    );
    global.fetch = fetchMock;
    const { deps, created, attempts } = makeDeps();

    const err = await expectLiveCreateError(createRealLiveSnapshot({}, deps));

    expect(err.code).toBe('insufficient_candidates');
    expect(err.message).toMatch(/found 2, required 3/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(attempts).toHaveLength(2); // the real calls are still accounted for
    expect(deps.createLiveRound).not.toHaveBeenCalled();
    expect(created).toHaveLength(0);
  });

  it('a malformed 200 response is not retried and creates nothing', async () => {
    const fetchMock = routeFetch(() => new Response('<html>gateway</html>', { status: 200 }));
    global.fetch = fetchMock;
    const { deps, created } = makeDeps();

    const err = await expectLiveCreateError(createRealLiveSnapshot({}, deps));

    expect(err.code).toBe('nansen_request_failed');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(created).toHaveLength(0);
  });

  it('a failed round insert surfaces as round_persist_failed with the spend reported', async () => {
    global.fetch = happyFetch();
    const { deps } = makeDeps();
    deps.createLiveRound = vi.fn(async () => {
      throw new Error('connection terminated');
    });

    const err = await expectLiveCreateError(createRealLiveSnapshot({}, deps));

    expect(err.code).toBe('round_persist_failed');
    expect(err.nansen).toMatchObject({ networkCalls: 2, creditsUsed: 2, lastCreditsRemaining: 100 }); // 1 credit per current-screener request
  });
});

describe('Live creation — current screener request and price_change scale', () => {
  it('asks the current screener for trailing 24h and 7d windows, excluding non-comparable sectors', () => {
    const [day1, day7] = buildLiveScreenerRequests('solana');
    expect([day1.timeframe, day7.timeframe]).toEqual(['24h', '7d']);
    expect(day1.filters?.include_stablecoins).toBe(false);
    expect(day1.filters?.exclude_sectors).toEqual(expect.arrayContaining(['Stablecoin', 'Tokenized Stocks', 'Yield Bearing']));
  });

  it('reads the scale from the data and refuses to guess', () => {
    const rows = (values: number[]) => values.map((v, i) => row(`T${i}`, `t${i}`, { price_change: v }));
    expect(detectPriceChangeScale(rows([0.02, -0.08, 0.12, 0.3, -0.05]))).toBe('ratio');
    expect(detectPriceChangeScale(rows([2, -8, 12, 30, -5]))).toBe('percent');
    expect(detectPriceChangeScale(rows([0.9, -1.1, 1.2, 1.0, -0.8]))).toBe('ambiguous');
    expect(detectPriceChangeScale(rows([0.02, 0.03]))).toBe('ambiguous');
  });

  it('converts percentage points to a ratio and records both values in the clue inputs', async () => {
    const pct = (rows: CurrentScreenerRow[]) => rows.map((r) => ({ ...r, price_change: r.price_change * 100 }));
    global.fetch = routeFetch((days) =>
      days === 1 ? screenerResponse(DAY1_ROWS, 'req-day1') : screenerResponse(pct(DAY7_ROWS), 'req-day7'),
    );
    const { deps, created } = makeDeps();
    await createRealLiveSnapshot({}, deps);
    const aaa = created[0]!.assets.find((a) => a.tokenSymbol === 'AAA')!;
    expect(aaa.clueInputs.price_change_7d).toBeCloseTo(0.2, 10);
    expect(aaa.clueInputs.price_change_7d_reported).toBeCloseTo(20, 10);
    expect(aaa.clueInputs.price_change_7d_reported_as_percent).toBe(1);
  });

  it('stops with no round when the scale is ambiguous', async () => {
    const ambiguous = DAY7_ROWS.map((r) => ({ ...r, price_change: 1.1 }));
    global.fetch = routeFetch((days) =>
      days === 1 ? screenerResponse(DAY1_ROWS, 'req-day1') : screenerResponse(ambiguous, 'req-day7'),
    );
    const { deps, created } = makeDeps();
    const err = await expectLiveCreateError(createRealLiveSnapshot({}, deps));
    expect(err.code).toBe('ambiguous_price_change_scale');
    expect(created).toHaveLength(0);
  });
});

describe('Live creation — hard credit cap and positive classification', () => {
  it('refuses the request that would exceed MAX_NANSEN_CREDITS_PER_LIVE_CREATE, before sending it', async () => {
    vi.stubEnv('MAX_NANSEN_CREDITS_PER_LIVE_CREATE', '1');
    const fetchMock = happyFetch();
    global.fetch = fetchMock;
    const { deps, created } = makeDeps();
    const err = await expectLiveCreateError(createRealLiveSnapshot({}, deps));
    expect(err.code).toBe('nansen_credit_cap');
    expect(fetchMock).toHaveBeenCalledTimes(1); // the first 1-credit request fit; the second was refused unsent
    expect(created).toHaveLength(0);
  });

  it('asks Nansen for Memecoins only, so every returned row is positively classified', () => {
    const [day1] = buildLiveScreenerRequests('solana');
    expect(day1.filters?.sectors).toEqual(['Memecoins']);
  });

  it('rejects candidates below the 24h volume floor', async () => {
    const thin = DAY1_ROWS.map((r) => (r.token_symbol === 'AAA' ? { ...r, volume: 1_289 } : r));
    global.fetch = routeFetch((days) => (days === 1 ? screenerResponse(thin, 'req-day1') : screenerResponse(DAY7_ROWS, 'req-day7')));
    const { deps, created } = makeDeps();
    await createRealLiveSnapshot({}, deps);
    expect(created[0]!.assets.map((a) => a.tokenSymbol)).not.toContain('AAA');
  });
});
