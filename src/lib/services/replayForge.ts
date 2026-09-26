import { ClueUnavailableError, computeClues } from '../domain/clues';
import { computeReturn, determineWinningSlots, type Slot } from '../domain/returns';
import { NansenBudgetError, NansenCallBudget, type NansenAttemptRecorder, type NansenBudgetSummary } from '../nansen/budget';
import {
  fetchHistoricalOhlcv,
  fetchHistoricalScreener,
  NansenApiError,
  NansenInsufficientCreditsError,
  type HistoricalOhlcvRequest,
  type HistoricalScreenerRequest,
  type HistoricalScreenerRow,
  type NansenCallMeta,
  type OhlcvCandle,
} from '../nansen/client';
import type { VerifiedRound } from '../repo/verifiedRoundImport';
import {
  ALLOWED_SECTORS,
  ELIGIBILITY_POLICY_VERSION,
  EXCLUDED_SECTORS,
  EXCLUDED_SYMBOLS,
  isComparableAsset,
  MIN_DAILY_VOLUME_USD,
  NEAR_DUPLICATE_SHARED_TOKENS,
  sharedTokenCount,
} from '../domain/assetPolicy';
import { utcDateOf, utcDateTimeOf } from '../nansen/contracts';

/**
 * Round Forge v4 — builds historical Replay rounds from real Nansen responses.
 * (v4, after the 2026-09-26 contract audit: the historical screener's `to_date = D`
 * reflects the market around midday of D, so clues are requested with `to_date = cutoff − 1
 * day` and can never overlap the outcome window; positive classification, a volume
 * floor, complete candle coverage and a discontinuity check are enforced.)
 * (v2 generated the first catalog; v3 adds the shared comparable-asset policy and the
 * catalog-wide near-duplicate rule after v2 admitted tokenized stocks, yield/LP tokens
 * and rounds sharing two of three tokens.)
 *
 * Every rule below is fixed before any outcome is fetched, deterministic, and recorded
 * in each round's eligibility_policy. No step looks at a price after the cutoff until
 * the three candidates and their slots are final. Any missing or unverifiable input
 * rejects the round — nothing is estimated, substituted, or retried into shape.
 */
export const REPLAY_FORGE_VERSION = 4;
export const REPLAY_HORIZON_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** Rotated by cutoff date so consecutive rounds compare tokens of a different size. */
export const MARKET_CAP_BANDS: ReadonlyArray<readonly [number, number]> = [
  [20_000_000, 60_000_000],
  [60_000_000, 200_000_000],
  [200_000_000, 1_000_000_000],
];

const MIN_LIQUIDITY_USD = 2_000_000;
/** A single hourly close-to-close move larger than this inside the outcome window rejects the round. */
export const MAX_HOURLY_MOVE = 0.3;
const MIN_TOKEN_AGE_DAYS = 30;
/** A token used by another catalog round whose cutoff is within this many days is not reused. */
const REUSE_WINDOW_DAYS = 14;

/** Calls one round needs: a 7-day and a 1-day screener at the cutoff, then one OHLCV per slot. */
export const REPLAY_ROUND_REQUIRED_CALLS = 5;
/** The five required calls plus two transient retries. */
export const REPLAY_ROUND_MAX_CALLS = 7;
/** Observed cost of each historical screener and OHLCV call (DATA-CONTRACT.md §6). */
export const PLANNED_CREDITS_PER_CALL = 5;
export const MAX_REPLAY_COUNT = 20;

export interface ReplayForgePolicy {
  round_forge_version: number;
  chain: 'solana';
  exclude_sectors: string[];
  liquidity_usd_min: number;
  token_age_days_min: number;
  market_cap_usd_band: [number, number];
  excluded_symbols: string[];
  excluded_sectors: string[];
  allowed_sectors: string[];
  eligibility_policy_version: number;
  min_daily_volume_usd: number;
  max_hourly_move_in_window: number;
  candle_coverage: 'complete';
  screener_to_date: 'cutoff date − 1 day';
  reuse_window_days: number;
  near_duplicate_rule: string;
  sort: 'liquidity_desc_top_3';
  slot_assignment: 'token_address_ascending';
  entry_price: 'close of the 1h candle starting 1h before the cutoff';
  exit_price: 'close of the 1h candle starting 1h before the resolution time';
}

export function policyForCutoff(cutoff: Date): ReplayForgePolicy {
  const epochDay = Math.floor(cutoff.getTime() / DAY_MS);
  const band = MARKET_CAP_BANDS[Math.floor(epochDay / 2) % MARKET_CAP_BANDS.length]!;
  return {
    round_forge_version: REPLAY_FORGE_VERSION,
    chain: 'solana',
    exclude_sectors: ['Stablecoin'],
    liquidity_usd_min: MIN_LIQUIDITY_USD,
    token_age_days_min: MIN_TOKEN_AGE_DAYS,
    market_cap_usd_band: [band[0], band[1]],
    excluded_symbols: [...EXCLUDED_SYMBOLS].sort(),
    excluded_sectors: [...EXCLUDED_SECTORS].sort(),
    allowed_sectors: [...ALLOWED_SECTORS].sort(),
    eligibility_policy_version: ELIGIBILITY_POLICY_VERSION,
    min_daily_volume_usd: MIN_DAILY_VOLUME_USD,
    max_hourly_move_in_window: MAX_HOURLY_MOVE,
    candle_coverage: 'complete',
    screener_to_date: 'cutoff date − 1 day',
    reuse_window_days: REUSE_WINDOW_DAYS,
    near_duplicate_rule: `no two catalog rounds share ${NEAR_DUPLICATE_SHARED_TOKENS} or more tokens`,
    sort: 'liquidity_desc_top_3',
    slot_assignment: 'token_address_ascending',
    entry_price: 'close of the 1h candle starting 1h before the cutoff',
    exit_price: 'close of the 1h candle starting 1h before the resolution time',
  };
}

// --- Planning (no network, no writes) ----------------------------------------

export interface ReplayPlan {
  cutoffs: Array<{ cutoff: string; resolution: string; band: [number, number] }>;
  requiredCallsPerRound: number;
  maxCallsPerRound: number;
  expectedCalls: number;
  expectedCredits: number;
  maxCalls: number;
  maxCredits: number;
}

function utcMidnight(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/**
 * Cutoffs at 00:00 UTC, every second day, newest first. The newest leaves the 7-day
 * horizon plus two days for the exit candle to be indexed. Dates that already have a
 * catalog round are skipped, so re-running never duplicates a round.
 */
export function planReplayGeneration(options: {
  count: number;
  now: Date;
  existingCutoffs: string[];
  maxCalls?: number;
  maxCredits?: number;
}): ReplayPlan {
  const { count, now } = options;
  if (!Number.isInteger(count) || count < 1 || count > MAX_REPLAY_COUNT) {
    throw new Error(`--count must be an integer from 1 to ${MAX_REPLAY_COUNT} (got ${count})`);
  }
  const taken = new Set(options.existingCutoffs.map((c) => c.slice(0, 10)));
  const cutoffs: ReplayPlan['cutoffs'] = [];
  let cursor = new Date(utcMidnight(now).getTime() - (REPLAY_HORIZON_DAYS + 2) * DAY_MS);
  while (cutoffs.length < count) {
    const day = cursor.toISOString().slice(0, 10);
    if (!taken.has(day)) {
      cutoffs.push({
        cutoff: cursor.toISOString(),
        resolution: new Date(cursor.getTime() + REPLAY_HORIZON_DAYS * DAY_MS).toISOString(),
        band: policyForCutoff(cursor).market_cap_usd_band,
      });
    }
    cursor = new Date(cursor.getTime() - 2 * DAY_MS);
  }

  const expectedCalls = count * REPLAY_ROUND_REQUIRED_CALLS;
  const expectedCredits = expectedCalls * PLANNED_CREDITS_PER_CALL;
  const defaultMaxCalls = expectedCalls + Math.ceil(count / 2);
  const defaultMaxCredits = defaultMaxCalls * PLANNED_CREDITS_PER_CALL;
  const maxCalls = options.maxCalls ?? defaultMaxCalls;
  const maxCredits = options.maxCredits ?? defaultMaxCredits;
  for (const [name, value, floor] of [
    ['--max-calls', maxCalls, REPLAY_ROUND_REQUIRED_CALLS],
    ['--max-credits', maxCredits, REPLAY_ROUND_REQUIRED_CALLS * PLANNED_CREDITS_PER_CALL],
  ] as const) {
    if (!Number.isInteger(value) || value < floor) {
      throw new Error(`${name} must be an integer of at least ${floor}, enough for one round (got ${value})`);
    }
  }
  return {
    cutoffs,
    requiredCallsPerRound: REPLAY_ROUND_REQUIRED_CALLS,
    maxCallsPerRound: REPLAY_ROUND_MAX_CALLS,
    expectedCalls,
    expectedCredits,
    maxCalls,
    maxCredits,
  };
}

// --- Requests ------------------------------------------------------------------

export function buildReplayScreenerRequests(
  cutoff: Date,
  policy: ReplayForgePolicy,
): [HistoricalScreenerRequest, HistoricalScreenerRequest] {
  // Nansen anchors a historical-screener `to_date` near midday of that UTC day, after its
  // 00:00. Requesting the day before the cutoff keeps every clue strictly before the entry
  // price (docs/NANSEN-CONTRACT-AUDIT.md, F1).
  const toDate = utcDateOf(new Date(cutoff.getTime() - DAY_MS));
  const base = (timeframeDays: number): HistoricalScreenerRequest => ({
    to_date: toDate,
    timeframe_days: timeframeDays,
    chains: [policy.chain],
    exclude_sectors: policy.exclude_sectors,
    filters: {
      liquidity_usd: { min: policy.liquidity_usd_min },
      market_cap_usd: { min: policy.market_cap_usd_band[0], max: policy.market_cap_usd_band[1] },
      token_age_days: { min: policy.token_age_days_min },
    },
    pagination: { page: 1, per_page: 50 },
    order_by: [{ field: 'liquidity', direction: 'DESC' }],
  });
  return [base(7), base(1)];
}

export function buildReplayOhlcvRequest(chain: string, tokenAddress: string, cutoff: Date, resolution: Date): HistoricalOhlcvRequest {
  return {
    chain,
    token_address: tokenAddress,
    // [HO] `date_from` accepts a date or a UTC datetime; `as_of_date` is date-only, through end of day.
    date_from: utcDateTimeOf(new Date(cutoff.getTime() - DAY_MS)),
    timeframe: '1h',
    as_of_date: utcDateOf(new Date(resolution.getTime() + DAY_MS)),
  };
}

// --- Selection -------------------------------------------------------------------

export interface ReplayCandidate {
  slot: Slot;
  symbol: string;
  address: string;
  sectors: string[];
  clueInputs: Record<string, number>;
  clues: Record<string, { value: number; bucket: string }>;
}

export class ReplayForgeRejection extends Error {
  constructor(
    public readonly reason:
      | 'insufficient_candidates'
      | 'exact_candle_unavailable'
      | 'ohlcv_truncated'
      | 'incomplete_candles'
      | 'price_discontinuity'
      | 'duplicate_round',
    message: string,
  ) {
    super(message);
    this.name = 'ReplayForgeRejection';
  }
}

function finite(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

/**
 * Applies the frozen policy to the two screener responses. Filters are re-checked here
 * even though the request carries them, so a looser server response cannot widen the
 * pool. Missing values exclude a token — market cap never falls back to FDV.
 */
export function selectReplayCandidates(
  day7Rows: HistoricalScreenerRow[],
  day1Rows: HistoricalScreenerRow[],
  policy: ReplayForgePolicy,
  excludedAddresses: ReadonlySet<string>,
  /** Token-address sets of every existing catalog round (near-duplicate rule). */
  catalogSets: ReadonlyArray<readonly string[]> = [],
  /** From the 7-day response's pagination: false means more rows existed beyond page 1. */
  day7IsLastPage: boolean = true,
): ReplayCandidate[] {
  const day7 = new Map(day7Rows.map((r) => [r.token_address, r]));
  const eligible: Array<Omit<ReplayCandidate, 'slot'> & { liquidity: number }> = [];
  const rejected: Record<string, number> = {};
  const reject = (reason: string) => void (rejected[reason] = (rejected[reason] ?? 0) + 1);
  for (const r1 of day1Rows) {
    const r7 = day7.get(r1.token_address);
    // Never assume a token's 7-day data: absent is absent, even when later pages existed.
    if (!r7) { reject(day7IsLastPage ? 'not_in_7d' : 'not_in_7d_page'); continue; }
    if (excludedAddresses.has(r1.token_address)) { reject('recently_used'); continue; }
    const sectors = r1.sectors ?? [];
    if (!isComparableAsset(r1.token_symbol, sectors)) { reject('not_comparable'); continue; }
    if (!finite(r1.liquidity) || r1.liquidity < policy.liquidity_usd_min) { reject('liquidity'); continue; }
    if (!finite(r1.volume) || r1.volume < policy.min_daily_volume_usd) { reject('low_volume'); continue; }
    if (!finite(r1.token_age_days) || r1.token_age_days < policy.token_age_days_min) { reject('age'); continue; }
    const mc = r1.market_cap_usd;
    if (!finite(mc) || mc < policy.market_cap_usd_band[0] || mc > policy.market_cap_usd_band[1]) { reject('market_cap'); continue; }

    let computed;
    try {
      computed = computeClues({
        day1: {
          buy_volume: r1.buy_volume,
          sell_volume: r1.sell_volume,
          volume: r1.volume,
          netflow: r1.netflow,
          liquidity: r1.liquidity,
        },
        day7: { volume: r7.volume, price_change: r7.price_change },
      });
    } catch (err) {
      if (err instanceof ClueUnavailableError) { reject(`clue_${err.clue}`); continue; }
      throw err;
    }
    eligible.push({
      symbol: r1.token_symbol,
      address: r1.token_address,
      sectors,
      liquidity: r1.liquidity,
      clueInputs: {
        buy_volume_1d: r1.buy_volume,
        sell_volume_1d: r1.sell_volume,
        volume_1d: r1.volume,
        volume_7d: r7.volume,
        netflow_1d: r1.netflow,
        liquidity_usd: r1.liquidity,
        price_change_7d: r7.price_change,
        market_cap_usd: mc,
        token_age_days: r1.token_age_days,
      },
      clues: {
        buy_sell_balance: { value: computed.buySellBalance, bucket: computed.buySellBalanceBucket },
        trading_acceleration: { value: computed.tradingAcceleration, bucket: computed.tradingAccelerationBucket },
        netflow_over_liquidity: { value: computed.netflowOverLiquidity, bucket: computed.netflowOverLiquidityBucket },
        recent_momentum: { value: computed.recentMomentum, bucket: computed.recentMomentumBucket },
      },
    });
  }

  // Most liquid first; a token joins the round only if the round would still share fewer
  // than NEAR_DUPLICATE_SHARED_TOKENS tokens with every existing catalog round.
  const top: typeof eligible = [];
  for (const c of eligible.sort((a, b) => b.liquidity - a.liquidity || (a.address < b.address ? -1 : 1))) {
    if (top.length === 3) break;
    const next = [...top.map((t) => t.address), c.address];
    if (catalogSets.some((set) => sharedTokenCount(set, next) >= NEAR_DUPLICATE_SHARED_TOKENS)) {
      reject('near_duplicate');
      continue;
    }
    top.push(c);
  }
  if (top.length < 3) {
    throw new ReplayForgeRejection(
      'insufficient_candidates',
      `Only ${top.length} token(s) meet the policy for this cutoff; a round needs 3 ` +
        `(1d rows ${day1Rows.length}, 7d rows ${day7Rows.length}, rejected ${JSON.stringify(rejected)})`,
    );
  }
  const slots: Slot[] = ['A', 'B', 'C'];
  return top
    .sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0))
    .map(({ liquidity: _liquidity, ...c }, i) => ({ ...c, slot: slots[i]! }));
}

/**
 * The whole outcome window must be present: every hourly candle from `entryStart` to
 * `exitStart` inclusive, each with a positive finite close, and no hourly move above
 * MAX_HOURLY_MOVE (an outcome dominated by one discontinuity is not a fair comparison).
 */
export function validateOutcomeWindow(candles: OhlcvCandle[], entryStart: Date, exitStart: Date, symbol: string): void {
  const byStart = new Map(candles.map((c) => [Date.parse(c.interval_start), c]));
  let previous: number | null = null;
  for (let t = entryStart.getTime(); t <= exitStart.getTime(); t += HOUR_MS) {
    const c = byStart.get(t);
    if (!c || !finite(c.close) || c.close <= 0) {
      throw new ReplayForgeRejection(
        'incomplete_candles',
        `Missing or invalid 1h candle ${new Date(t).toISOString()} for ${symbol} inside the outcome window`,
      );
    }
    if (previous !== null && Math.abs(c.close / previous - 1) > MAX_HOURLY_MOVE) {
      throw new ReplayForgeRejection(
        'price_discontinuity',
        `${symbol} moved ${((c.close / previous - 1) * 100).toFixed(1)}% in the hour starting ${new Date(t).toISOString()}`,
      );
    }
    previous = c.close;
  }
}

/** Close of the candle that starts exactly at `start`, or a rejection — never a neighbour. */
export function boundaryClose(candles: OhlcvCandle[], start: Date, symbol: string): number {
  const candle = candles.find((c) => Date.parse(c.interval_start) === start.getTime());
  if (!candle || !finite(candle.close) || candle.close <= 0) {
    throw new ReplayForgeRejection(
      'exact_candle_unavailable',
      `No valid 1h candle starting ${start.toISOString()} for ${symbol}`,
    );
  }
  return candle.close;
}

// --- One round -----------------------------------------------------------------

export interface GeneratedReceipt {
  endpoint: string;
  purpose: string;
  requestParams: Record<string, unknown>;
  responseSha256: string;
  retrievedAt: string;
  requestId: string | null;
  creditsUsed: number | null;
}

export interface GeneratedReplayRound {
  round: VerifiedRound;
  receipts: GeneratedReceipt[];
  nansen: NansenBudgetSummary;
}

function receipt(purpose: string, request: object, meta: NansenCallMeta): GeneratedReceipt {
  return {
    endpoint: meta.endpoint,
    purpose,
    requestParams: { ...request },
    responseSha256: meta.responseSha256,
    retrievedAt: meta.retrievedAt,
    requestId: meta.requestId,
    creditsUsed: meta.creditsUsed,
  };
}

/**
 * Builds one round for `cutoff` with at most REPLAY_ROUND_MAX_CALLS Nansen requests:
 * both screener windows, candidate selection and slot assignment, and only then the
 * three OHLCV requests for the outcome. Throws ReplayForgeRejection when the data
 * does not support a round, and Nansen/budget errors unchanged.
 */
export async function forgeReplayRound(options: {
  cutoff: Date;
  excludedAddresses: ReadonlySet<string>;
  catalogSets?: ReadonlyArray<readonly string[]>;
  recorder: NansenAttemptRecorder;
}): Promise<GeneratedReplayRound> {
  const { cutoff } = options;
  const policy = policyForCutoff(cutoff);
  const resolution = new Date(cutoff.getTime() + REPLAY_HORIZON_DAYS * DAY_MS);
  const day = cutoff.toISOString().slice(0, 10);
  const budget = new NansenCallBudget({
    operation: `replay_generate:${day}`,
    maxNetworkCalls: REPLAY_ROUND_MAX_CALLS,
    requiredNetworkCalls: REPLAY_ROUND_REQUIRED_CALLS,
    maxCredits: REPLAY_ROUND_MAX_CALLS * PLANNED_CREDITS_PER_CALL,
    recorder: options.recorder,
  });

  try {
    const [req7, req1] = buildReplayScreenerRequests(cutoff, policy);
    const res7 = await fetchHistoricalScreener(req7, budget);
    const res1 = await fetchHistoricalScreener(req1, budget);
    const candidates = selectReplayCandidates(
      res7.data.data ?? [],
      res1.data.data ?? [],
      policy,
      options.excludedAddresses,
      options.catalogSets ?? [],
      res7.data.pagination?.is_last_page !== false,
    );

    const receipts = [receipt('replay_discovery_7d', req7, res7.meta), receipt('replay_discovery_1d', req1, res1.meta)];
    const entryStart = new Date(cutoff.getTime() - HOUR_MS);
    const exitStart = new Date(resolution.getTime() - HOUR_MS);
    const assets: VerifiedRound['assets'] = [];
    for (const c of candidates) {
      const req = buildReplayOhlcvRequest(policy.chain, c.address, cutoff, resolution);
      const res = await fetchHistoricalOhlcv(req, budget);
      if (res.data.truncated) {
        throw new ReplayForgeRejection('ohlcv_truncated', `OHLCV response for ${c.symbol} was truncated`);
      }
      const candles = res.data.data ?? [];
      const entry = boundaryClose(candles, entryStart, c.symbol);
      const exit = boundaryClose(candles, exitStart, c.symbol);
      validateOutcomeWindow(candles, entryStart, exitStart, c.symbol);
      receipts.push(receipt(`replay_outcome_${c.slot}`, req, res.meta));
      assets.push({
        slot: c.slot,
        token_symbol: c.symbol,
        token_address: c.address,
        sectors: c.sectors,
        clue_inputs: c.clueInputs,
        clues: c.clues,
        price: {
          entry_candle_start: entryStart.toISOString(),
          entry_close: entry,
          exit_candle_start: exitStart.toISOString(),
          exit_close: exit,
        },
        return: computeReturn(entry, exit),
        source_response_sha256: {
          discovery_7d: res7.meta.responseSha256,
          discovery_1d: res1.meta.responseSha256,
          ohlcv: res.meta.responseSha256,
        },
      });
    }

    const returns = Object.fromEntries(assets.map((a) => [a.slot, a.return])) as Record<Slot, number>;
    const winners = determineWinningSlots(returns);
    const round: VerifiedRound = {
      round_id: `forge-v${REPLAY_FORGE_VERSION}-${day}`,
      mode: 'replay',
      chain: policy.chain,
      cutoff: cutoff.toISOString(),
      horizon_days: REPLAY_HORIZON_DAYS,
      candle_interval: '1h',
      resolution_time: resolution.toISOString(),
      round_forge_version: REPLAY_FORGE_VERSION,
      clue_schema_version: 1,
      price_policy_version: 1,
      eligibility_policy: policy,
      assets,
      winner_slot: winners.join(','),
      provenance: {
        generated_by: 'npm run generate:replay',
        data_source: 'Nansen API',
        requests: receipts.map((r) => ({
          purpose: r.purpose,
          endpoint: r.endpoint,
          request_id: r.requestId,
          response_sha256: r.responseSha256,
          credits_used: r.creditsUsed,
          retrieved_at: r.retrievedAt,
        })),
      },
    };
    return { round, receipts, nansen: budget.summary() };
  } catch (err) {
    if (err instanceof ReplayForgeRejection || err instanceof NansenApiError || err instanceof NansenBudgetError) {
      Object.assign(err, { nansen: budget.summary() });
    }
    throw err;
  }
}

/** Errors that must stop the whole generation run, not just skip one date. */
export function isFatalForgeError(err: unknown): boolean {
  if (err instanceof NansenInsufficientCreditsError) return true;
  if (err instanceof NansenApiError) return true; // auth, rate limit after retries, server errors
  if (err instanceof NansenBudgetError) return true; // budget exhausted, halted, or audit log failed
  return !(err instanceof ReplayForgeRejection);
}
