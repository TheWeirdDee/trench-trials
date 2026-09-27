/**
 * How the four clue buckets are presented. Every bucket has a text label AND an ordinal
 * meter position, so meaning never depends on color alone (PRD §17).
 * Definitions follow DATA-CONTRACT.md §3: all four come from Nansen's historical token
 * screener, read as of the day before the round's cutoff.
 */
export type BucketDirection = 'down' | 'neutral' | 'up';

const DOWN_BUCKETS = new Set(['sell-heavy', 'slowing', 'outward', 'falling']);
const UP_BUCKETS = new Set(['buy-heavy', 'accelerating', 'inward', 'rising']);

export function bucketDirection(bucket: string): BucketDirection {
  if (DOWN_BUCKETS.has(bucket)) return 'down';
  if (UP_BUCKETS.has(bucket)) return 'up';
  return 'neutral';
}

/** 1 = low end of the range, 2 = middle, 3 = high end. */
export function bucketLevel(bucket: string): 1 | 2 | 3 {
  const dir = bucketDirection(bucket);
  if (dir === 'down') return 1;
  if (dir === 'neutral') return 2;
  return 3;
}

export function bucketLabel(bucket: string): string {
  const text = bucket.replace(/-/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export const CLUE_META = {
  buySellBalance: {
    title: 'Buy / sell balance',
    hint: 'Buy volume against sell volume over the day before the cutoff: (buys − sells) ÷ (buys + sells).',
  },
  tradingAcceleration: {
    title: 'Trading pace',
    hint: 'Volume on the day before the cutoff compared with the average daily volume of the prior week.',
  },
  netflowOverLiquidity: {
    title: 'Netflow vs liquidity',
    hint: 'Net inflow over the day before the cutoff, relative to the liquidity available just before it.',
  },
  recentMomentum: {
    title: '7-day momentum',
    hint: 'Price change over the seven days ending just before the cutoff.',
  },
} as const;

export const CLUE_ORDER = ['buySellBalance', 'tradingAcceleration', 'netflowOverLiquidity', 'recentMomentum'] as const;
