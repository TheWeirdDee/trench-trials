import { computeClues } from '../domain/clues';
import {
  computeLiveSchedule,
  type LiveCandidateAsset,
  type LiveSchedule,
  type LiveTimingConfig,
} from '../domain/live';
import type { Slot } from '../domain/returns';
import {
  DEFAULT_MAX_NANSEN_CREDITS_PER_LIVE_CREATE,
  MAX_NANSEN_CREDITS_PER_LIVE_CREATE_ENV,
  readNansenCreditBudget,
  DEFAULT_MAX_NANSEN_CALLS_PER_LIVE_CREATE,
  LIVE_CREATE_REQUIRED_NANSEN_CALLS,
  MAX_NANSEN_CALLS_PER_LIVE_CREATE_ENV,
  NansenBudgetError,
  NansenCallBudget,
  readNansenCallBudget,
  type NansenAttemptRecorder,
  type NansenBudgetErrorCode,
  type NansenBudgetSummary,
} from '../nansen/budget';
import {
  fetchCurrentScreener,
  NansenApiError,
  NansenInsufficientCreditsError,
  type CurrentScreenerRequest,
  type CurrentScreenerRow,
  type NansenCallMeta,
} from '../nansen/client';
import { ELIGIBILITY_POLICY_VERSION, EXCLUDED_SECTORS, isComparableAsset, MIN_DAILY_VOLUME_USD } from '../domain/assetPolicy';
import { recordNansenAttempt } from '../repo/apiCallLog';
import {
  ActiveLiveRoundExistsError,
  createLiveRound,
  findActiveLiveRound,
  type CreateLiveRoundParams,
  type CreateLiveRoundResult,
} from '../repo/live';

export const LIVE_CANDIDATE_COUNT = 3;

export type LiveCreateErrorCode =
  | NansenBudgetErrorCode
  | 'active_live_round_exists'
  | 'nansen_insufficient_credits'
  | 'nansen_auth_rejected'
  | 'nansen_request_failed'
  | 'invalid_timing_config'
  | 'insufficient_candidates'
  | 'ambiguous_price_change_scale'
  | 'round_persist_failed';

/**
 * Every way a real Live creation can fail. `nansen` is the budget summary at the
 * point of failure, so callers can report exactly how many requests were spent.
 * No failure path creates a round or a source receipt.
 */
export class LiveCreateError extends Error {
  constructor(
    message: string,
    public readonly code: LiveCreateErrorCode,
    public readonly nansen: NansenBudgetSummary | null,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'LiveCreateError';
  }
}

export interface LiveSnapshotDeps {
  findActiveLiveRound: () => Promise<{ id: string; status: string } | null>;
  createLiveRound: (params: CreateLiveRoundParams) => Promise<CreateLiveRoundResult>;
  recordNansenAttempt: NansenAttemptRecorder;
  now: () => Date;
}

const defaultDeps: LiveSnapshotDeps = {
  findActiveLiveRound,
  createLiveRound,
  recordNansenAttempt,
  now: () => new Date(),
};

export interface CreateRealLiveSnapshotOptions {
  chain?: string;
  toDateStr?: string;
  timingConfig?: LiveTimingConfig;
  /** Defaults to MAX_NANSEN_CALLS_PER_LIVE_CREATE, else DEFAULT_MAX_NANSEN_CALLS_PER_LIVE_CREATE. */
  maxNansenCalls?: number;
  /** Defaults to MAX_NANSEN_CREDITS_PER_LIVE_CREATE, else DEFAULT_MAX_NANSEN_CREDITS_PER_LIVE_CREATE. */
  maxNansenCredits?: number;
}

/**
 * The exact two requests a Live creation sends — also printed by the dry run. Live uses
 * Nansen's current (point-in-time) Token Screener, so the clues describe the market at
 * the moment the round opens: a trailing-24h window and a trailing-7-day window.
 */
/**
 * The current screener returns no sector tags, so Live classifies positively through the
 * documented `filters.sectors` include-filter: every returned row carries one of these tags.
 */
export const LIVE_ALLOWED_SECTORS = ['Memecoins'] as const;

export function buildLiveScreenerRequests(chain: string): [CurrentScreenerRequest, CurrentScreenerRequest] {
  const base = (timeframe: '24h' | '7d'): CurrentScreenerRequest => ({
    chains: [chain],
    timeframe,
    filters: {
      liquidity: { min: 100_000 },
      token_age_days: { min: 30 },
      include_stablecoins: false,
      include_native_tokens: false,
      sectors: [...LIVE_ALLOWED_SECTORS],
      exclude_sectors: [...EXCLUDED_SECTORS],
    },
    pagination: { page: 1, per_page: 100 },
    order_by: [{ field: 'liquidity', direction: 'DESC' }],
  });
  return [base('24h'), base('7d')];
}

/**
 * The current screener documents `price_change` only as a "percentage". The clue needs a
 * ratio (0.05 = 5%), as the historical screener returns. The scale is read from the data:
 * across liquid tokens a trailing-7-day change is a few percent, so a median absolute value
 * below 0.75 can only be a ratio and one above 1.5 can only be percentage points. Anything
 * in between is ambiguous and the creation stops — the value is never guessed.
 */
export function detectPriceChangeScale(rows: CurrentScreenerRow[]): 'ratio' | 'percent' | 'ambiguous' {
  const values = rows.map((r) => Math.abs(r.price_change)).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (values.length < 5) return 'ambiguous';
  const median = values[Math.floor(values.length / 2)]!;
  if (median < 0.75) return 'ratio';
  if (median > 1.5) return 'percent';
  return 'ambiguous';
}

export function resolveLiveCreateBudget(options: { maxNansenCalls?: number } = {}): number {
  return (
    options.maxNansenCalls ??
    readNansenCallBudget(MAX_NANSEN_CALLS_PER_LIVE_CREATE_ENV, DEFAULT_MAX_NANSEN_CALLS_PER_LIVE_CREATE)
  );
}

function toLiveCreateError(
  err: unknown,
  budget: NansenCallBudget | null,
  fallback: LiveCreateErrorCode,
): LiveCreateError {
  if (err instanceof LiveCreateError) return err;
  const summary = budget?.summary() ?? null;
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof ActiveLiveRoundExistsError) {
    return new LiveCreateError(message, 'active_live_round_exists', summary, { cause: err });
  }
  if (err instanceof NansenInsufficientCreditsError) {
    return new LiveCreateError(message, 'nansen_insufficient_credits', summary, { cause: err });
  }
  if (err instanceof NansenBudgetError) {
    return new LiveCreateError(message, err.code, summary, { cause: err });
  }
  if (err instanceof NansenApiError && (err.status === 401 || err.status === 403)) {
    return new LiveCreateError(message, 'nansen_auth_rejected', summary, { cause: err });
  }
  return new LiveCreateError(message, fallback, summary, { cause: err });
}

/** Timing invariants per Section 25. */
function assertLiveScheduleInvariants(schedule: LiveSchedule): void {
  const entryCloseDiff = schedule.entryCloseAt.getTime() - schedule.snapshotPublishedAt.getTime();
  if (entryCloseDiff !== 5 * 60 * 1000) {
    throw new Error(`entryCloseAt must be exactly 5m after snapshot (got ${entryCloseDiff}ms)`);
  }
  if (schedule.measurementStartAt.getTime() < schedule.entryCloseAt.getTime() + 60 * 1000) {
    throw new Error(`measurementStartAt must be at least 60s after entryCloseAt`);
  }
  if (
    schedule.measurementStartAt.getUTCMinutes() % 5 !== 0 ||
    schedule.measurementStartAt.getUTCSeconds() !== 0 ||
    schedule.measurementStartAt.getUTCMilliseconds() !== 0
  ) {
    throw new Error(`measurementStartAt must be an exact 5m candle boundary`);
  }
  const horizonDiff = schedule.measurementEndAt.getTime() - schedule.measurementStartAt.getTime();
  if (horizonDiff !== 24 * 3600 * 1000) {
    throw new Error(`measurementEndAt must be exactly 24 hours after measurementStartAt`);
  }
  if (
    schedule.measurementEndAt.getUTCMinutes() % 5 !== 0 ||
    schedule.measurementEndAt.getUTCSeconds() !== 0 ||
    schedule.measurementEndAt.getUTCMilliseconds() !== 0
  ) {
    throw new Error(`measurementEndAt must be an exact 5m candle boundary`);
  }
}

function toSourceReceipt(request: CurrentScreenerRequest, meta: NansenCallMeta) {
  return {
    endpoint: meta.endpoint,
    requestParams: { ...request },
    responseSha256: meta.responseSha256,
    retrievedAt: new Date(meta.retrievedAt),
    purpose: 'live_snapshot',
    requestId: meta.requestId,
    creditsUsed: meta.creditsUsed,
  };
}

/**
 * Creates exactly one real Live round: two budgeted Historical Token Screener
 * requests, candidate selection, then one transactional insert of the round, its
 * assets and one source receipt per served response. Refuses to start (zero Nansen
 * requests) while another Live round is unresolved or the budget is misconfigured.
 */
export async function createRealLiveSnapshot(
  options: CreateRealLiveSnapshotOptions = {},
  deps: LiveSnapshotDeps = defaultDeps,
): Promise<
  CreateLiveRoundResult & {
    candidateSymbols: string[];
    toDateStr: string;
    nansenCalls: number;
    nansen: NansenBudgetSummary;
    nansenMeta: NansenCallMeta[];
  }
> {
  const chain = options.chain ?? 'solana';
  const toDateStr = options.toDateStr ?? deps.now().toISOString().slice(0, 10);

  let budget: NansenCallBudget;
  try {
    budget = new NansenCallBudget({
      operation: 'live_create',
      maxNetworkCalls: resolveLiveCreateBudget(options),
      requiredNetworkCalls: LIVE_CREATE_REQUIRED_NANSEN_CALLS,
      maxCredits:
        options.maxNansenCredits ??
        readNansenCreditBudget(MAX_NANSEN_CREDITS_PER_LIVE_CREATE_ENV, DEFAULT_MAX_NANSEN_CREDITS_PER_LIVE_CREATE),
      recorder: deps.recordNansenAttempt,
    });
  } catch (err) {
    throw toLiveCreateError(err, null, 'nansen_budget_invalid');
  }

  // Pre-flight, before any Nansen request: the timing config must yield a valid
  // schedule (the invariants hold for any publish instant, so checking now is enough)...
  try {
    assertLiveScheduleInvariants(computeLiveSchedule(deps.now(), options.timingConfig));
  } catch (err) {
    throw toLiveCreateError(err, budget, 'invalid_timing_config');
  }

  // ...and a duplicate creation must not trigger another ingestion.
  const active = await deps.findActiveLiveRound();
  if (active) {
    throw toLiveCreateError(new ActiveLiveRoundExistsError(active.id, active.status), budget, 'active_live_round_exists');
  }

  const [day1Req, day7Req] = buildLiveScreenerRequests(chain);
  let day1Res: Awaited<ReturnType<typeof fetchCurrentScreener>>;
  let day7Res: Awaited<ReturnType<typeof fetchCurrentScreener>>;
  try {
    // Call 1: trailing 24h
    day1Res = await fetchCurrentScreener(day1Req, budget);
    // Call 2: trailing 7 days
    day7Res = await fetchCurrentScreener(day7Req, budget);
  } catch (err) {
    throw toLiveCreateError(err, budget, 'nansen_request_failed');
  }

  const day1Rows = day1Res.data.data ?? [];
  const day7Rows = day7Res.data.data ?? [];
  const scale = detectPriceChangeScale(day7Rows);
  if (scale === 'ambiguous') {
    throw new LiveCreateError(
      `The 7-day price_change scale cannot be determined from ${day7Rows.length} rows; refusing to guess`,
      'ambiguous_price_change_scale',
      budget.summary(),
    );
  }
  const toRatio = (v: number) => (scale === 'percent' ? v / 100 : v);

  const day7Map = new Map<string, CurrentScreenerRow>();
  for (const row of day7Rows) {
    day7Map.set(row.token_address.toLowerCase(), row);
  }
  const rejected: Record<string, number> = {};
  const reject = (reason: string) => void (rejected[reason] = (rejected[reason] ?? 0) + 1);

  const validCandidates: Array<{
    symbol: string;
    address: string;
    chain: string;
    sectors: string[];
    clueInputs: Record<string, number>;
    clues: Record<string, { value: number; bucket: string }>;
  }> = [];

  for (const r1 of day1Rows) {
    if (!isComparableAsset(r1.token_symbol, r1.sectors, day1Req.filters?.sectors)) { reject('not_comparable'); continue; }
    if (!Number.isFinite(r1.volume) || r1.volume < MIN_DAILY_VOLUME_USD) { reject('low_volume'); continue; }

    const r7 = day7Map.get(r1.token_address.toLowerCase());
    if (!r7) {
      // Never assume a token's 7-day data: absent is absent, even when the page was not the last one.
      reject(day7Res.data.pagination?.is_last_page === false ? 'not_in_7d_page' : 'not_in_7d');
      continue;
    }

    // Validate finite non-zero required inputs
    if (
      !r1.buy_volume ||
      !r1.sell_volume ||
      !r1.volume ||
      !r1.liquidity ||
      !r7.volume ||
      r7.price_change === null ||
      r7.price_change === undefined
    ) {
      reject('missing_input');
      continue;
    }
    const priceChange7d = toRatio(r7.price_change);

    try {
      const computed = computeClues({
        day1: {
          buy_volume: r1.buy_volume,
          sell_volume: r1.sell_volume,
          volume: r1.volume,
          netflow: r1.netflow,
          liquidity: r1.liquidity,
        },
        day7: {
          volume: r7.volume,
          price_change: priceChange7d,
        },
      });

      validCandidates.push({
        symbol: r1.token_symbol,
        address: r1.token_address,
        chain: r1.chain || chain,
        sectors: r1.sectors || [],
        clueInputs: {
          buy_volume_1d: r1.buy_volume,
          sell_volume_1d: r1.sell_volume,
          volume_1d: r1.volume,
          volume_7d: r7.volume,
          netflow_1d: r1.netflow,
          liquidity: r1.liquidity,
          price_change_7d: priceChange7d,
          // As Nansen returned it, with the scale read from the data (see detectPriceChangeScale).
          price_change_7d_reported: r7.price_change,
          price_change_7d_reported_as_percent: scale === 'percent' ? 1 : 0,
        },
        clues: {
          buy_sell_balance: {
            value: computed.buySellBalance,
            bucket: computed.buySellBalanceBucket,
          },
          trading_acceleration: {
            value: computed.tradingAcceleration,
            bucket: computed.tradingAccelerationBucket,
          },
          netflow_over_liquidity: {
            value: computed.netflowOverLiquidity,
            bucket: computed.netflowOverLiquidityBucket,
          },
          recent_momentum: {
            value: computed.recentMomentum,
            bucket: computed.recentMomentumBucket,
          },
        },
      });

      if (validCandidates.length === LIVE_CANDIDATE_COUNT) break;
    } catch {
      reject('clue_unavailable');
      continue;
    }
  }

  if (validCandidates.length < LIVE_CANDIDATE_COUNT) {
    throw new LiveCreateError(
      `Insufficient eligible tokens with valid clues from Nansen (found ${validCandidates.length}, required ${LIVE_CANDIDATE_COUNT}; ` +
        `24h rows ${day1Rows.length}, 7d rows ${day7Rows.length}, rejected ${JSON.stringify(rejected)})`,
      'insufficient_candidates',
      budget.summary(),
    );
  }

  const slots: Slot[] = ['A', 'B', 'C'];
  const assets: LiveCandidateAsset[] = validCandidates.slice(0, LIVE_CANDIDATE_COUNT).map((cand, idx) => ({
    slot: slots[idx] as Slot,
    tokenSymbol: cand.symbol,
    tokenAddress: cand.address,
    chain: cand.chain,
    sectors: cand.sectors,
    clueInputs: cand.clueInputs,
    clues: cand.clues,
  }));

  // One receipt per served response, carrying the exact request body and Nansen request ID.
  const sourceReceipts = [toSourceReceipt(day1Req, day1Res.meta), toSourceReceipt(day7Req, day7Res.meta)];

  // The snapshot is published once its data is in hand, so API latency never eats the entry window.
  const now = deps.now();
  const schedule = computeLiveSchedule(now, options.timingConfig);
  try {
    assertLiveScheduleInvariants(schedule);
  } catch (err) {
    throw toLiveCreateError(err, budget, 'invalid_timing_config');
  }

  let result: CreateLiveRoundResult;
  try {
    result = await deps.createLiveRound({
      chain,
      assets,
      timingConfig: options.timingConfig,
      sourceReceipts,
      snapshotPublishedAt: now,
      requireNoActiveLiveRound: true,
      // Every candidate passed the automated Live policy above (positive Memecoins
      // classification, excluded symbols, volume floor), so the round opens approved under
      // the current policy version. Reviewers can still withdraw it (scripts/review-round.ts).
      eligibility: {
        status: 'approved',
        actor: 'live_create_policy',
        note: `automated Live policy v${ELIGIBILITY_POLICY_VERSION}: sector filter ${LIVE_ALLOWED_SECTORS.join('/')}, excluded symbols, $${MIN_DAILY_VOLUME_USD} 24h volume floor`,
      },
    });
  } catch (err) {
    throw toLiveCreateError(err, budget, 'round_persist_failed');
  }

  return {
    ...result,
    candidateSymbols: assets.map((a) => a.tokenSymbol),
    toDateStr,
    nansenCalls: budget.networkCallsUsed,
    nansen: budget.summary(),
    nansenMeta: [day1Res.meta, day7Res.meta],
  };
}
