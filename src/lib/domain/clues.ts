/**
 * Clue formulas and buckets, frozen per DATA-CONTRACT.md §4.
 * clue_schema_version 1. All 4 clues derive from two Historical Token Screener calls
 * per round (timeframe_days=1 and timeframe_days=7, same to_date) — never from
 * Smart-Money-labeled endpoints (see DATA-CONTRACT.md §2 for why).
 *
 * Null/undefined inputs and zero denominators mean "unavailable" and must cause the
 * caller to reject the round — never substituted with 0 or a neutral bucket.
 */

export const CLUE_SCHEMA_VERSION = 1;

export type BuySellBalanceBucket = 'sell-heavy' | 'balanced' | 'buy-heavy';
export type AccelerationBucket = 'slowing' | 'steady' | 'accelerating';
export type NetflowBucket = 'outward' | 'balanced' | 'inward';
export type MomentumBucket = 'falling' | 'flat' | 'rising';

export interface ScreenerWindow {
  buy_volume: number;
  sell_volume: number;
  volume: number;
  netflow: number;
  liquidity: number;
  price_change: number;
}

export interface ClueInputs {
  /** Historical Token Screener call with timeframe_days=1, to_date=cutoff. */
  day1: Pick<ScreenerWindow, 'buy_volume' | 'sell_volume' | 'volume' | 'netflow' | 'liquidity'>;
  /** Historical Token Screener call with timeframe_days=7, to_date=cutoff. */
  day7: Pick<ScreenerWindow, 'volume' | 'price_change'>;
}

export interface ComputedClues {
  buySellBalance: number;
  buySellBalanceBucket: BuySellBalanceBucket;
  tradingAcceleration: number;
  tradingAccelerationBucket: AccelerationBucket;
  netflowOverLiquidity: number;
  netflowOverLiquidityBucket: NetflowBucket;
  recentMomentum: number;
  recentMomentumBucket: MomentumBucket;
}

/** Thrown when a required input is missing or a denominator is zero — the round must be rejected. */
export class ClueUnavailableError extends Error {
  constructor(public readonly clue: string, reason: string) {
    super(`Clue unavailable: ${clue} (${reason})`);
    this.name = 'ClueUnavailableError';
  }
}

function requireFinite(value: number | null | undefined, label: string): number {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    throw new ClueUnavailableError(label, `value is ${value}`);
  }
  return value;
}

export function bucketBuySellBalance(v: number): BuySellBalanceBucket {
  if (v < -0.1) return 'sell-heavy';
  if (v > 0.1) return 'buy-heavy';
  return 'balanced';
}

export function bucketAcceleration(v: number): AccelerationBucket {
  if (v < 0.75) return 'slowing';
  if (v > 1.25) return 'accelerating';
  return 'steady';
}

export function bucketNetflow(v: number): NetflowBucket {
  if (v < -0.05) return 'outward';
  if (v > 0.05) return 'inward';
  return 'balanced';
}

export function bucketMomentum(v: number): MomentumBucket {
  if (v < -0.05) return 'falling';
  if (v > 0.05) return 'rising';
  return 'flat';
}

export function computeClues(inputs: ClueInputs): ComputedClues {
  const buyVolume = requireFinite(inputs.day1.buy_volume, 'buy_volume_1d');
  const sellVolume = requireFinite(inputs.day1.sell_volume, 'sell_volume_1d');
  const volume1d = requireFinite(inputs.day1.volume, 'volume_1d');
  const volume7d = requireFinite(inputs.day7.volume, 'volume_7d');
  const netflow1d = requireFinite(inputs.day1.netflow, 'netflow_1d');
  const liquidity = requireFinite(inputs.day1.liquidity, 'liquidity');
  const priceChange7d = requireFinite(inputs.day7.price_change, 'price_change_7d');

  const buySellDenom = buyVolume + sellVolume;
  if (buySellDenom === 0) {
    throw new ClueUnavailableError('buy_sell_balance', 'buy_volume + sell_volume is 0');
  }
  const buySellBalance = (buyVolume - sellVolume) / buySellDenom;

  const meanDaily7 = volume7d / 7;
  if (meanDaily7 === 0) {
    throw new ClueUnavailableError('trading_acceleration', 'mean 7-day daily volume is 0');
  }
  const tradingAcceleration = volume1d / meanDaily7;

  if (liquidity === 0) {
    throw new ClueUnavailableError('netflow_over_liquidity', 'liquidity is 0');
  }
  const netflowOverLiquidity = netflow1d / liquidity;

  const recentMomentum = priceChange7d;

  return {
    buySellBalance,
    buySellBalanceBucket: bucketBuySellBalance(buySellBalance),
    tradingAcceleration,
    tradingAccelerationBucket: bucketAcceleration(tradingAcceleration),
    netflowOverLiquidity,
    netflowOverLiquidityBucket: bucketNetflow(netflowOverLiquidity),
    recentMomentum,
    recentMomentumBucket: bucketMomentum(recentMomentum),
  };
}
