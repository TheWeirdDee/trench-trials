import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NansenBudgetError, type NansenAttemptRecord } from '@/lib/nansen/budget';
import { NansenApiError, NansenInsufficientCreditsError, type HistoricalScreenerRow } from '@/lib/nansen/client';
import {
  boundaryClose,
  buildReplayScreenerRequests,
  forgeReplayRound,
  isFatalForgeError,
  planReplayGeneration,
  policyForCutoff,
  ReplayForgeRejection,
  selectReplayCandidates,
  validateOutcomeWindow,
} from '@/lib/services/replayForge';
import { classifyAsset } from '@/lib/domain/assetPolicy';

// Every response below is a hand-written test double; no request reaches Nansen.
const CUTOFF = new Date('2026-09-01T00:00:00Z');
const POLICY = policyForCutoff(CUTOFF);
const [MC_MIN] = POLICY.market_cap_usd_band;

function row(address: string, over: Partial<HistoricalScreenerRow> = {}): HistoricalScreenerRow {
  return {
    token_address: address,
    token_symbol: `T${address}`,
    chain: 'solana',
    price_usd: 1,
    price_change: 0.05,
    market_cap_usd: MC_MIN * 1.5,
    fdv: null,
    fdv_mc_ratio: null,
    volume: 1_000_000,
    buy_volume: 600_000,
    sell_volume: 400_000,
    netflow: 10_000,
    inflow_fdv_ratio: null,
    outflow_fdv_ratio: null,
    token_age_days: 400,
    liquidity: 5_000_000,
    sectors: ['Memecoins'],
    ...over,
  };
}

function jsonResponse(body: unknown, headers: Record<string, string> = {}, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'x-nansen-credits-used': '5', ...headers },
  });
}

function candles(start: Date, end: Date, closeAt: (t: number) => number) {
  const out = [];
  for (let t = start.getTime(); t <= end.getTime(); t += 3_600_000) {
    out.push({
      interval_start: new Date(t).toISOString().replace('.000Z', 'Z'),
      open: 1,
      high: 1,
      low: 1,
      close: closeAt(t),
      volume: 1,
      volume_usd: 1,
      market_cap: { open: null, high: null, low: null, close: null },
    });
  }
  return { chain: 'solana', token_address: 'x', timeframe: '1h', data: out, truncated: false, truncation_note: null };
}

const ORIGINAL_FETCH = global.fetch;
beforeEach(() => {
  process.env.NANSEN_API_KEY = 'test-key-not-real';
});
afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
  delete process.env.NANSEN_API_KEY;
  vi.restoreAllMocks();
});

describe('planReplayGeneration', () => {
  it('plans distinct past cutoffs, skips existing ones, and caps calls and credits', () => {
    const plan = planReplayGeneration({
      count: 3,
      now: new Date('2026-09-26T12:00:00Z'),
      existingCutoffs: ['2026-09-15T00:00:00.000Z'],
    });
    expect(plan.cutoffs.map((c) => c.cutoff.slice(0, 10))).toEqual(['2026-09-17', '2026-09-13', '2026-09-11']);
    for (const c of plan.cutoffs) {
      expect(Date.parse(c.resolution) - Date.parse(c.cutoff)).toBe(7 * 86_400_000);
      expect(Date.parse(c.resolution)).toBeLessThan(Date.parse('2026-09-26T00:00:00Z'));
    }
    expect(plan.expectedCalls).toBe(15);
    expect(plan.expectedCredits).toBe(75);
    expect(plan.maxCalls).toBe(17);
    expect(plan.maxCredits).toBe(85);
  });

  it('matches the authorised campaign plan for 15 rounds: 75 requests, ~375 credits, caps 83 / 415', () => {
    const plan = planReplayGeneration({ count: 15, now: new Date('2026-09-26T12:00:00Z'), existingCutoffs: [] });
    expect([plan.expectedCalls, plan.expectedCredits, plan.maxCalls, plan.maxCredits]).toEqual([75, 375, 83, 415]);
    expect(new Set(plan.cutoffs.map((c) => c.cutoff)).size).toBe(15);
  });

  it('refuses counts and caps that are out of range', () => {
    const now = new Date('2026-09-26T00:00:00Z');
    expect(() => planReplayGeneration({ count: 0, now, existingCutoffs: [] })).toThrow(/--count/);
    expect(() => planReplayGeneration({ count: 21, now, existingCutoffs: [] })).toThrow(/--count/);
    expect(() => planReplayGeneration({ count: 2, now, existingCutoffs: [], maxCalls: 4 })).toThrow(/--max-calls/);
    expect(() => planReplayGeneration({ count: 2, now, existingCutoffs: [], maxCredits: 10 })).toThrow(/--max-credits/);
  });
});

describe('selectReplayCandidates', () => {
  it('takes the three most liquid eligible tokens and assigns slots by address, not by liquidity', () => {
    const day1 = [row('c', { liquidity: 9e6 }), row('a', { liquidity: 8e6 }), row('d', { liquidity: 3e6 }), row('b', { liquidity: 7e6 })];
    const picked = selectReplayCandidates(day1, day1, POLICY, new Set());
    expect(picked.map((c) => [c.slot, c.address])).toEqual([
      ['A', 'a'],
      ['B', 'b'],
      ['C', 'c'],
    ]);
    expect(picked[0]!.clues.buy_sell_balance).toEqual({ value: 0.2, bucket: 'buy-heavy' });
  });

  it('re-applies every filter and never falls back to FDV for a missing market cap', () => {
    const ok = [row('a'), row('b'), row('c')];
    const bad = [
      row('stable', { sectors: ['Stablecoin'], liquidity: 9e9 }),
      row('usdc', { token_symbol: 'USDC', liquidity: 9e9 }),
      row('thin', { liquidity: 1_000_000 }),
      row('young', { token_age_days: 3 }),
      row('nomc', { market_cap_usd: null, fdv: MC_MIN * 2, liquidity: 9e9 }),
      row('huge', { market_cap_usd: 1e12, liquidity: 9e9 }),
      row('used', { liquidity: 9e9 }),
      row('noclue', { buy_volume: 0, sell_volume: 0, liquidity: 9e9 }),
    ];
    const all = [...bad, ...ok];
    const picked = selectReplayCandidates(all, all, POLICY, new Set(['used']));
    expect(picked.map((c) => c.address)).toEqual(['a', 'b', 'c']);
  });

  it('rejects the cutoff when fewer than three tokens qualify', () => {
    expect(() => selectReplayCandidates([row('a'), row('b')], [row('a'), row('b')], POLICY, new Set())).toThrow(
      ReplayForgeRejection,
    );
  });
});

describe('boundaryClose', () => {
  it('uses the exact boundary candle and rejects a gap instead of taking a neighbour', () => {
    const start = new Date('2026-08-31T23:00:00Z');
    const series = candles(new Date('2026-08-31T20:00:00Z'), new Date('2026-09-01T02:00:00Z'), (t) => t / 1e12).data;
    expect(boundaryClose(series, start, 'X')).toBe(start.getTime() / 1e12);
    const withGap = series.filter((c) => Date.parse(c.interval_start) !== start.getTime());
    expect(() => boundaryClose(withGap, start, 'X')).toThrow(/No valid 1h candle/);
  });
});

describe('forgeReplayRound', () => {
  const resolution = new Date(CUTOFF.getTime() + 7 * 86_400_000);
  const screener = { pagination: { page: 1, per_page: 50, is_last_page: true }, data: [row('a'), row('b'), row('c')] };
  // Prices drift smoothly from 1 at the entry boundary to 1 + growth at the exit boundary.
  const entryT = CUTOFF.getTime() - 3_600_000;
  const exitT = resolution.getTime() - 3_600_000;
  const ohlcvFor = (growth: number) =>
    candles(new Date(CUTOFF.getTime() - 86_400_000), new Date(resolution.getTime() + 86_400_000), (t) =>
      t <= entryT ? 1 : t >= exitT ? 1 + growth : 1 + (growth * (t - entryT)) / (exitT - entryT),
    );

  it('makes exactly five requests — screener first, outcome last — and records every attempt', async () => {
    const paths: string[] = [];
    const growth: Record<string, number> = { a: 0.1, b: 0.3, c: -0.2 };
    global.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      paths.push(String(url).replace('https://api.nansen.ai', ''));
      const body = JSON.parse(String(init?.body));
      if (String(url).includes('token-screener')) return jsonResponse(screener, { 'x-request-id': `s${body.timeframe_days}` });
      return jsonResponse(ohlcvFor(growth[body.token_address]!), { 'x-request-id': `o-${body.token_address}` });
    }) as typeof fetch;
    const recorded: NansenAttemptRecord[] = [];

    const out = await forgeReplayRound({ cutoff: CUTOFF, excludedAddresses: new Set(), recorder: async (r) => void recorded.push(r) });

    expect(paths).toEqual([
      '/api/v1beta1/token-screener/historical',
      '/api/v1beta1/token-screener/historical',
      '/api/v1beta1/tgm/historical-token-ohlcv',
      '/api/v1beta1/tgm/historical-token-ohlcv',
      '/api/v1beta1/tgm/historical-token-ohlcv',
    ]);
    expect(recorded).toHaveLength(5);
    expect(recorded.every((r) => r.operation === 'replay_generate:2026-09-01')).toBe(true);
    expect(out.nansen).toMatchObject({ networkCalls: 5, creditsUsed: 25 });
    expect(out.round.winner_slot).toBe('B');
    expect(out.round.assets.map((a) => Number(a.return.toFixed(6)))).toEqual([0.1, 0.3, -0.2]);
    expect(out.round.assets[0]!.price.entry_candle_start).toBe('2026-08-31T23:00:00.000Z');
    expect(out.round.assets[0]!.price.exit_candle_start).toBe('2026-09-07T23:00:00.000Z');
    expect(out.receipts.map((r) => [r.purpose, r.requestId, r.creditsUsed])).toEqual([
      ['replay_discovery_7d', 's7', 5],
      ['replay_discovery_1d', 's1', 5],
      ['replay_outcome_A', 'o-a', 5],
      ['replay_outcome_B', 'o-b', 5],
      ['replay_outcome_C', 'o-c', 5],
    ]);
    expect(out.round.eligibility_policy).toEqual(POLICY);
  });

  it('stops on an insufficient-credits response without another request, and that is fatal', async () => {
    global.fetch = vi.fn(async () => jsonResponse({ code: 'insufficient_credits' }, {}, 402)) as typeof fetch;
    const err = await forgeReplayRound({ cutoff: CUTOFF, excludedAddresses: new Set(), recorder: async () => {} }).catch((e) => e);
    expect(err).toBeInstanceOf(NansenInsufficientCreditsError);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(isFatalForgeError(err)).toBe(true);
  });

  it('stops on an authentication failure without retrying', async () => {
    global.fetch = vi.fn(async () => jsonResponse({ message: 'unauthorized' }, {}, 401)) as typeof fetch;
    const err = await forgeReplayRound({ cutoff: CUTOFF, excludedAddresses: new Set(), recorder: async () => {} }).catch((e) => e);
    expect(err).toBeInstanceOf(NansenApiError);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(isFatalForgeError(err)).toBe(true);
  });

  it('does not retry a malformed successful response', async () => {
    global.fetch = vi.fn(async () => new Response('not json', { status: 200 })) as typeof fetch;
    await expect(
      forgeReplayRound({ cutoff: CUTOFF, excludedAddresses: new Set(), recorder: async () => {} }),
    ).rejects.toThrow();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('halts when an attempt cannot be recorded — no unaudited request follows', async () => {
    global.fetch = vi.fn(async () => jsonResponse(screener)) as typeof fetch;
    const err = await forgeReplayRound({
      cutoff: CUTOFF,
      excludedAddresses: new Set(),
      recorder: async () => {
        throw new Error('db down');
      },
    }).catch((e) => e);
    expect(err).toBeInstanceOf(NansenBudgetError);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(isFatalForgeError(err)).toBe(true);
  });

  it('rejects the round — not the run — when an exact outcome candle is missing', async () => {
    global.fetch = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('token-screener')) return jsonResponse(screener);
      const series = ohlcvFor(0.1);
      series.data = series.data.filter((c) => Date.parse(c.interval_start) !== Date.parse('2026-09-07T23:00:00Z'));
      return jsonResponse(series);
    }) as typeof fetch;
    const err = await forgeReplayRound({ cutoff: CUTOFF, excludedAddresses: new Set(), recorder: async () => {} }).catch((e) => e);
    expect(err).toBeInstanceOf(ReplayForgeRejection);
    expect(err.reason).toBe('exact_candle_unavailable');
    expect(isFatalForgeError(err)).toBe(false);
  });
});

describe('Round Forge v3 — comparable assets and the catalog-wide near-duplicate rule', () => {
  it('excludes tokenized stocks, yield-bearing tokens, LP tokens and bridged majors by symbol or Nansen sector', () => {
    const rows = [
      row('spyx', { token_symbol: 'SPYX', sectors: ['Tokenized Stocks'], liquidity: 9e9 }),
      row('syrup', { token_symbol: 'SYRUPUSDC', liquidity: 9e9 }),
      row('ray', { token_symbol: 'RAY', sectors: ['Decentralised Exchanges', 'Yield Bearing'], liquidity: 9e9 }),
      row('jlp', { token_symbol: 'JLP', liquidity: 9e9 }),
      row('trx', { token_symbol: 'TRX', liquidity: 9e9 }),
      row('a'),
      row('b'),
      row('c'),
    ];
    expect(selectReplayCandidates(rows, rows, POLICY, new Set()).map((c) => c.address)).toEqual(['a', 'b', 'c']);
  });

  it('never builds a round sharing two tokens with an existing catalog round — it moves to the next most liquid', () => {
    const rows = [row('a', { liquidity: 9e6 }), row('b', { liquidity: 8e6 }), row('c', { liquidity: 7e6 }), row('d', { liquidity: 6e6 })];
    // An existing round already holds a and b: the new round keeps a, skips b, and takes c and d.
    const picked = selectReplayCandidates(rows, rows, POLICY, new Set(), [['a', 'b', 'x']]);
    expect(picked.map((c) => c.address)).toEqual(['a', 'c', 'd']);
    expect(() => selectReplayCandidates(rows.slice(0, 3), rows.slice(0, 3), POLICY, new Set(), [['a', 'b', 'x']])).toThrow(
      /near_duplicate/,
    );
  });
});

describe('Round Forge v4 — contract audit safeguards (no network)', () => {
  const H = 3_600_000;
  const series = (from: string, hours: number, closeAt: (i: number) => number | null) =>
    Array.from({ length: hours }, (_, i) => ({
      interval_start: new Date(Date.parse(from) + i * H).toISOString().replace('.000Z', 'Z'),
      open: 1, high: 1, low: 1, close: closeAt(i), volume: 1, volume_usd: 1,
      market_cap: { open: null, high: null, low: null, close: null },
    }));

  it('requests clues for the day BEFORE the cutoff, so the screener snapshot cannot overlap the outcome', () => {
    const [d7, d1] = buildReplayScreenerRequests(new Date('2026-09-01T00:00:00Z'), policyForCutoff(new Date('2026-09-01T00:00:00Z')));
    expect([d7.to_date, d1.to_date]).toEqual(['2026-08-31', '2026-08-31']);
  });

  it('candle boundaries: the entry is the candle STARTING an hour before the cutoff (it closes at the cutoff) — never the one starting at it', () => {
    const cutoff = new Date('2026-09-01T00:00:00Z');
    const withBoth = series('2026-08-31T22:00:00Z', 4, (i) => 1 + i);
    expect(boundaryClose(withBoth, new Date(cutoff.getTime() - H), 'X')).toBe(2);
    const onlyTheNextCandle = withBoth.filter((c) => c.interval_start !== '2026-08-31T23:00:00Z');
    expect(() => boundaryClose(onlyTheNextCandle, new Date(cutoff.getTime() - H), 'X')).toThrow(ReplayForgeRejection);
  });

  it('a null boundary price is rejected, never replaced', () => {
    const s1 = series('2026-08-31T23:00:00Z', 2, (i) => (i === 0 ? null : 1));
    expect(() => boundaryClose(s1, new Date('2026-08-31T23:00:00Z'), 'X')).toThrow(/No valid 1h candle/);
  });

  it('a missing hour or a null close inside the outcome window rejects the round (incomplete_candles)', () => {
    const entry = new Date('2026-08-31T23:00:00Z');
    const exit = new Date(entry.getTime() + 168 * H);
    const full = series('2026-08-31T23:00:00Z', 169, () => 1);
    expect(() => validateOutcomeWindow(full, entry, exit, 'X')).not.toThrow();
    const gap = full.filter((_, i) => i !== 80);
    expect(() => validateOutcomeWindow(gap, entry, exit, 'X')).toThrow(expect.objectContaining({ reason: 'incomplete_candles' }));
    const nulled = full.map((c, i) => (i === 40 ? { ...c, close: null } : c));
    expect(() => validateOutcomeWindow(nulled, entry, exit, 'X')).toThrow(expect.objectContaining({ reason: 'incomplete_candles' }));
  });

  it('a single-hour move above 30% inside the window rejects the round (price_discontinuity)', () => {
    const entry = new Date('2026-08-31T23:00:00Z');
    const exit = new Date(entry.getTime() + 168 * H);
    const crash = series('2026-08-31T23:00:00Z', 169, (i) => (i >= 100 ? 0.53 : 1)); // FO-like −47% hour
    expect(() => validateOutcomeWindow(crash, entry, exit, 'FO')).toThrow(expect.objectContaining({ reason: 'price_discontinuity' }));
  });

  it('a token missing from the 7-day page is never guessed — also when more pages existed', () => {
    const day1 = [row('a'), row('b'), row('c')];
    const day7 = [row('a'), row('b')];
    expect(() => selectReplayCandidates(day7, day1, POLICY, new Set(), [], false)).toThrow(/not_in_7d_page/);
    expect(() => selectReplayCandidates(day7, day1, POLICY, new Set(), [], true)).toThrow(/not_in_7d/);
  });

  it('an empty successful screener response yields no round', () => {
    expect(() => selectReplayCandidates([], [], POLICY, new Set())).toThrow(ReplayForgeRejection);
  });

  it('unknown or missing sector tags fail closed; so does thin volume', () => {
    const rows = [
      row('notag', { sectors: [], liquidity: 9e9 }),
      row('newtag', { sectors: ['Some Future Sector'], liquidity: 9e9 }),
      row('nft', { sectors: ['NFTs'], liquidity: 9e9 }),
      row('thin', { volume: 1_289, liquidity: 9e9 }),
      row('a'),
      row('b'),
      row('c'),
    ];
    expect(selectReplayCandidates(rows, rows, POLICY, new Set()).map((c) => c.address)).toEqual(['a', 'b', 'c']);
  });

  it('a truncated OHLCV response rejects the round even with HTTP 200', async () => {
    const resolution = new Date(CUTOFF.getTime() + 7 * 86_400_000);
    global.fetch = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('token-screener')) {
        return jsonResponse({ pagination: { page: 1, per_page: 50, is_last_page: true }, data: [row('a'), row('b'), row('c')] });
      }
      const c = candles(new Date(CUTOFF.getTime() - 86_400_000), new Date(resolution.getTime() + 86_400_000), () => 1);
      return jsonResponse({ ...c, truncated: true, truncation_note: 'capped' });
    }) as typeof fetch;
    const err = await forgeReplayRound({ cutoff: CUTOFF, excludedAddresses: new Set(), recorder: async () => {} }).catch((e) => e);
    expect(err).toBeInstanceOf(ReplayForgeRejection);
    expect(err.reason).toBe('ohlcv_truncated');
  });
});

describe('Asset classification (eligibility policy v2)', () => {
  it.each([
    ['POPCAT', ['Memecoins'], 'eligible'],
    ['DBR', ['Scaling & Connectivity'], 'eligible'],
    ['FO', [], 'unclassified'],
    ['ONYC', [], 'unclassified'],
    ['MELANIA', ['NFTs'], 'unclassified'],
    ['RAY', ['Decentralised Exchanges', 'NFTs', 'Yield Farming Protocols', 'Yield Bearing'], 'excluded'],
    ['SPYX', ['Tokenized Stocks'], 'excluded'],
    ['CARDS', ['NFTs', 'RWAs', 'NFTFi'], 'excluded'],
    ['TRX', [], 'excluded'],
    ['HYPE', ['Decentralised Exchanges'], 'excluded'],
    ['SPX', ['Memecoins'], 'excluded'],
  ])('%s %j → %s', (symbol, sectors, status) => {
    expect(classifyAsset({ symbol, sectors }).status).toBe(status);
  });

  it('a request-level sector filter classifies rows that carry no tags (current screener)', () => {
    expect(classifyAsset({ symbol: 'PUMP', sectors: undefined, requestedSectors: ['Memecoins'] }).status).toBe('eligible');
    expect(classifyAsset({ symbol: 'XXXX', sectors: undefined }).status).toBe('unclassified');
  });
});
