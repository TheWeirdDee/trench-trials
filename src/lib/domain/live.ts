import { canonicalize, computeCommitment, generateNonce, sha256Hex } from './commitment';
import { computeReturn, determineWinningSlots, type Slot, TIE_TOLERANCE_PP, TIE_TOLERANCE_RATIO } from './returns';

export type LivePhase =
  | 'ENTRY_OPEN'
  | 'FINAL_LOCK_WINDOW'
  | 'MEASURING'
  | 'RESOLVING'
  | 'RESOLVED'
  | 'INVALID';

export interface LiveTimingConfig {
  entryWindowSeconds?: number;
  measurementDelaySeconds?: number;
  horizonHours?: number;
  retryWindowHours?: number;
}

export interface LiveSchedule {
  snapshotPublishedAt: Date;
  entryCloseAt: Date;
  measurementStartAt: Date;
  measurementEndAt: Date;
  latestAttemptStartAt: Date;
  retryDeadlineAt: Date;
}

export const DEFAULT_LIVE_TIMING = {
  entryWindowSeconds: 5 * 60, // 5 minutes
  measurementDelaySeconds: 60, // at least 60 seconds before next 5m candle boundary
  horizonHours: 24, // exactly 24 hours (86,400 seconds)
  retryWindowHours: 6, // 6 hours
} as const;

/**
 * Real-data resolution does not query Nansen until this long after measurementEndAt:
 * each OHLCV request is billed even when the exit candle is not indexed yet, so an
 * early attempt would spend credits and still come back pending.
 */
export const LIVE_RESOLVE_MIN_DATA_DELAY_SECONDS = 15 * 60;

/**
 * Aligns a timestamp up to the nearest exact 5-minute UTC candle boundary.
 * Boundary has seconds = 0, ms = 0, minute % 5 === 0.
 */
export function ceilToFiveMinuteBoundary(date: Date): Date {
  const fiveMinMs = 5 * 60 * 1000;
  const originalMs = date.getTime();
  const alignedMs = Math.ceil(originalMs / fiveMinMs) * fiveMinMs;
  const aligned = new Date(alignedMs);
  aligned.setUTCSeconds(0, 0);
  return aligned;
}

/**
 * Derives the strict PRD Live timing schedule with exact 5-minute candle boundary alignment:
 * - Entry closes 5 minutes after snapshot publication.
 * - Earliest safe measurement is entry close + 60 seconds.
 * - Measurement start is aligned up to the next 5-minute candle boundary (minute % 5 === 0, 00s, 000ms).
 * - Measurement end is exactly measurementStartAt + 24 hours (86,400s), also on a 5-minute boundary.
 * - Resolution retry window extends up to 6 hours after measurement end before INVALID.
 */
export function computeLiveSchedule(
  snapshotPublishedAt: Date,
  config: LiveTimingConfig = {},
): LiveSchedule {
  const entryWindow = config.entryWindowSeconds ?? DEFAULT_LIVE_TIMING.entryWindowSeconds;
  const measurementDelay =
    config.measurementDelaySeconds ?? DEFAULT_LIVE_TIMING.measurementDelaySeconds;
  const horizonHours = config.horizonHours ?? DEFAULT_LIVE_TIMING.horizonHours;
  const retryWindowHours = config.retryWindowHours ?? DEFAULT_LIVE_TIMING.retryWindowHours;

  const snapshotMs = snapshotPublishedAt.getTime();
  const entryCloseMs = snapshotMs + entryWindow * 1000;
  const earliestMeasurementStartMs = entryCloseMs + measurementDelay * 1000;

  const measurementStartAt = ceilToFiveMinuteBoundary(new Date(earliestMeasurementStartMs));
  const measurementEndMs = measurementStartAt.getTime() + horizonHours * 3600 * 1000;
  const retryDeadlineMs = measurementEndMs + retryWindowHours * 3600 * 1000;

  return {
    snapshotPublishedAt: new Date(snapshotMs),
    entryCloseAt: new Date(entryCloseMs),
    measurementStartAt,
    measurementEndAt: new Date(measurementEndMs),
    latestAttemptStartAt: new Date(entryCloseMs),
    retryDeadlineAt: new Date(retryDeadlineMs),
  };
}

/**
 * Authoritative server-derived Live public phase:
 * - Persisted 'resolved' -> RESOLVED
 * - Persisted 'invalid' -> INVALID
 * - Otherwise derived from committed timestamps against server `now`:
 *   - now < entryCloseAt -> ENTRY_OPEN
 *   - entryCloseAt <= now < measurementStartAt -> FINAL_LOCK_WINDOW
 *   - measurementStartAt <= now < measurementEndAt -> MEASURING
 *   - now >= measurementEndAt -> RESOLVING
 */
export function deriveLivePhase(params: {
  status: string;
  entryCloseAt: Date;
  measurementStartAt: Date;
  measurementEndAt: Date;
  now?: Date;
}): LivePhase {
  if (params.status === 'resolved') return 'RESOLVED';
  if (params.status === 'invalid') return 'INVALID';

  const currentTime = (params.now ?? new Date()).getTime();
  const entryClose = params.entryCloseAt.getTime();
  const measurementStart = params.measurementStartAt.getTime();
  const measurementEnd = params.measurementEndAt.getTime();

  if (currentTime < entryClose) {
    return 'ENTRY_OPEN';
  }
  if (currentTime < measurementStart) {
    return 'FINAL_LOCK_WINDOW';
  }
  if (currentTime < measurementEnd) {
    return 'MEASURING';
  }
  return 'RESOLVING';
}

export function isLiveEntryAllowed(schedule: LiveSchedule, now: Date): boolean {
  return now.getTime() < schedule.entryCloseAt.getTime();
}

export function isLiveFinalLockAllowed(schedule: LiveSchedule, now: Date): boolean {
  return now.getTime() < schedule.measurementStartAt.getTime();
}

export function isLiveResolutionAllowed(schedule: LiveSchedule, now: Date): boolean {
  return now.getTime() >= schedule.measurementEndAt.getTime();
}

export function isLiveResolutionTimedOut(schedule: LiveSchedule, now: Date): boolean {
  return now.getTime() >= schedule.retryDeadlineAt.getTime();
}

export interface LiveCandidateAsset {
  slot: Slot;
  tokenSymbol: string;
  tokenAddress: string;
  chain: string;
  sectors: string[];
  clueInputs: Record<string, number>;
  clues: Record<string, { value: number; bucket: string }>;
}

export interface LiveInitialManifest {
  round_type: 'live';
  chain: string;
  snapshot_published_at: string;
  entry_close_at: string;
  measurement_start_at: string;
  measurement_end_at: string;
  price_policy: {
    provider: 'Nansen';
    endpoint: string;
    timeframe: '5m';
    price_field: 'open';
    entry_interval_start: string;
    exit_interval_start: string;
    quote_basis: 'USD';
    missing_data_policy: 'fail_closed';
    tie_tolerance_pp: number;
    tie_tolerance_ratio: number;
    outcome_formula: string;
    winner_rule: string;
  };
  round_forge_version: number;
  clue_schema_version: number;
  price_policy_version: number;
  assets: Array<{
    slot: Slot;
    token_symbol: string;
    token_address: string;
    chain: string;
    sectors: string[];
    clue_inputs: Record<string, number>;
    clues: Record<string, { value: number; bucket: string }>;
  }>;
}

export function buildLiveInitialManifest(params: {
  chain: string;
  schedule: LiveSchedule;
  assets: LiveCandidateAsset[];
  roundForgeVersion?: number;
  clueSchemaVersion?: number;
  pricePolicyVersion?: number;
}): LiveInitialManifest {
  return {
    round_type: 'live',
    chain: params.chain,
    snapshot_published_at: params.schedule.snapshotPublishedAt.toISOString(),
    entry_close_at: params.schedule.entryCloseAt.toISOString(),
    measurement_start_at: params.schedule.measurementStartAt.toISOString(),
    measurement_end_at: params.schedule.measurementEndAt.toISOString(),
    price_policy: {
      provider: 'Nansen',
      endpoint: '/api/v1beta1/tgm/historical-token-ohlcv',
      timeframe: '5m',
      price_field: 'open',
      entry_interval_start: params.schedule.measurementStartAt.toISOString(),
      exit_interval_start: params.schedule.measurementEndAt.toISOString(),
      quote_basis: 'USD',
      missing_data_policy: 'fail_closed',
      tie_tolerance_pp: TIE_TOLERANCE_PP,
      tie_tolerance_ratio: TIE_TOLERANCE_RATIO,
      outcome_formula: 'exit_price / entry_price - 1',
      winner_rule: 'max_return_with_0.01pp_tie_tolerance',
    },
    round_forge_version: params.roundForgeVersion ?? 1,
    clue_schema_version: params.clueSchemaVersion ?? 1,
    price_policy_version: params.pricePolicyVersion ?? 1,
    assets: params.assets.map((a) => ({
      slot: a.slot,
      token_symbol: a.tokenSymbol,
      token_address: a.tokenAddress,
      chain: a.chain,
      sectors: a.sectors,
      clue_inputs: a.clueInputs,
      clues: a.clues,
    })),
  };
}

export interface LiveResolvedAsset {
  slot: Slot;
  tokenSymbol: string;
  tokenAddress: string;
  entryCandleStart: string;
  entryPrice: number;
  exitCandleStart: string;
  exitPrice: number;
  returnRatio: number;
  sourceResponseSha256: Record<string, string>;
}

export interface LiveResolutionManifest {
  round_id: string;
  initial_commitment_hash: string;
  measurement_start_at: string;
  measurement_end_at: string;
  resolution_time: string;
  status: 'resolved' | 'invalid';
  invalid_reason?: string | null;
  assets: Array<{
    slot: Slot;
    token_symbol: string;
    token_address: string;
    entry_candle_start: string;
    entry_price: number;
    exit_candle_start: string;
    exit_price: number;
    return_ratio: number;
    source_response_sha256: Record<string, string>;
  }>;
  winning_slots: Slot[];
  tie_tolerance_ratio: number;
}

export function buildLiveResolutionManifest(params: {
  roundId: string;
  initialCommitmentHash: string;
  measurementStartAt: string;
  measurementEndAt: string;
  resolutionTime: string;
  assets: LiveResolvedAsset[];
}): LiveResolutionManifest {
  const returnsBySlot: Record<Slot, number> = {
    A: 0,
    B: 0,
    C: 0,
  };
  for (const a of params.assets) {
    returnsBySlot[a.slot] = a.returnRatio;
  }
  const winningSlots = determineWinningSlots(returnsBySlot);

  return {
    round_id: params.roundId,
    initial_commitment_hash: params.initialCommitmentHash,
    measurement_start_at: params.measurementStartAt,
    measurement_end_at: params.measurementEndAt,
    resolution_time: params.resolutionTime,
    status: 'resolved',
    invalid_reason: null,
    assets: params.assets.map((a) => ({
      slot: a.slot,
      token_symbol: a.tokenSymbol,
      token_address: a.tokenAddress,
      entry_candle_start: a.entryCandleStart,
      entry_price: a.entryPrice,
      exit_candle_start: a.exitCandleStart,
      exit_price: a.exitPrice,
      return_ratio: a.returnRatio,
      source_response_sha256: a.sourceResponseSha256,
    })),
    winning_slots: winningSlots,
    tie_tolerance_ratio: TIE_TOLERANCE_RATIO,
  };
}

export function createLiveCommitment(manifest: LiveInitialManifest): {
  manifest: LiveInitialManifest;
  nonce: string;
  commitmentHash: string;
} {
  const nonce = generateNonce();
  const commitmentHash = computeCommitment(manifest, nonce);
  return { manifest, nonce, commitmentHash };
}
