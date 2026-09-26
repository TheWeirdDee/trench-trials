import type { Slot } from './domain/returns';

/**
 * The full server-side view of a round asset — everything that ever lives in the
 * database row. This type must NEVER be sent to the client directly (PRD §15: "Do
 * not serialize database rows directly"). Every response is built by explicitly
 * picking allowed fields for the current stage via the functions below.
 */
export interface RoundAssetFull {
  slot: Slot;
  tokenSymbol: string;
  tokenAddress: string;
  sectors: string[];
  clueBuySellBalanceBucket: string;
  clueTradingAccelerationBucket: string;
  clueNetflowOverLiquidityBucket: string;
  clueRecentMomentumBucket: string;
  entryCandleStart?: string | null;
  entryPrice?: number | null;
  exitCandleStart?: string | null;
  exitPrice?: number | null;
  returnRatio?: number | null;
}

export interface BlindAssetView {
  slot: Slot;
  clues: {
    buySellBalance: string;
    tradingAcceleration: string;
    netflowOverLiquidity: string;
    recentMomentum: string;
  };
}

export interface UnmaskedAssetView extends BlindAssetView {
  tokenSymbol: string;
  tokenAddress: string;
}

export interface VerdictAssetView extends UnmaskedAssetView {
  returnPct: number;
  entryCandleStart: string;
  exitCandleStart: string;
}

/** Blind stage: bucketed clues and slot only. No identity, no prices, no outcome. */
export function toBlindAssetView(asset: RoundAssetFull): BlindAssetView {
  return {
    slot: asset.slot,
    clues: {
      buySellBalance: asset.clueBuySellBalanceBucket,
      tradingAcceleration: asset.clueTradingAccelerationBucket,
      netflowOverLiquidity: asset.clueNetflowOverLiquidityBucket,
      recentMomentum: asset.clueRecentMomentumBucket,
    },
  };
}

/** Unmask stage: identity is added. Prices, returns and candle timestamps stay hidden. */
export function toUnmaskedAssetView(asset: RoundAssetFull): UnmaskedAssetView {
  return {
    ...toBlindAssetView(asset),
    tokenSymbol: asset.tokenSymbol,
    tokenAddress: asset.tokenAddress,
  };
}

/** Verdict stage: full reveal, only after the attempt's own final lock. */
export function toVerdictAssetView(asset: RoundAssetFull): VerdictAssetView {
  return {
    ...toUnmaskedAssetView(asset),
    returnPct: (asset.returnRatio ?? 0) * 100,
    entryCandleStart: asset.entryCandleStart ?? '',
    exitCandleStart: asset.exitCandleStart ?? '',
  };
}

const FORBIDDEN_BEFORE_UNMASK = ['tokenSymbol', 'tokenAddress', 'token_symbol', 'token_address'];
const FORBIDDEN_BEFORE_VERDICT = [
  'entryPrice',
  'exitPrice',
  'returnRatio',
  'returnPct',
  'entry_price',
  'exit_price',
  'return_ratio',
  'entryCandleStart',
  'exitCandleStart',
];

/**
 * Defense-in-depth check: scans a serialized response for forbidden field NAMES.
 * Route handlers call this in tests (and optionally at runtime in development) on
 * the exact JSON string about to be sent, so a future field added to a view type
 * without updating the allowlist functions above is still caught before/while it
 * reaches a client — catching leakage through the actual wire payload, not just the
 * TypeScript type.
 */
export function assertNoForbiddenKeys(json: string, forbidden: readonly string[]): void {
  for (const key of forbidden) {
    if (json.includes(`"${key}"`)) {
      throw new Error(`Leakage check failed: forbidden key "${key}" present in response payload`);
    }
  }
}

export function assertNoIdentityLeak(json: string): void {
  assertNoForbiddenKeys(json, FORBIDDEN_BEFORE_UNMASK);
}

export function assertNoOutcomeLeak(json: string): void {
  assertNoForbiddenKeys(json, FORBIDDEN_BEFORE_VERDICT);
}
