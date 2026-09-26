import { describe, expect, it } from 'vitest';
import { ClueUnavailableError, computeClues, type ClueInputs } from '@/lib/domain/clues';

// Real values from data/verified-rounds/round-001.json (slot A / POPCAT).
const POPCAT: ClueInputs = {
  day1: {
    buy_volume: 283495.1020966354,
    sell_volume: 259846.46665626526,
    volume: 543341.5687529007,
    netflow: 23648.635440370126,
    liquidity: 4869692.689133946,
  },
  day7: {
    volume: 1128853.6497759006,
    price_change: 0.0712165078343695,
  },
};

// Real values for slot B / YZY — the thin-trading case flagged in DATA-CONTRACT.md §8.
const YZY: ClueInputs = {
  day1: {
    buy_volume: 688.2567843711454,
    sell_volume: 1555.8831112027312,
    volume: 2244.139895573877,
    netflow: -867.6263268315859,
    liquidity: 6317801.234732163,
  },
  day7: {
    volume: 13277.647988978002,
    price_change: -0.01974290799128955,
  },
};

describe('computeClues', () => {
  it('reproduces the real round-001 POPCAT clue values and buckets', () => {
    const clues = computeClues(POPCAT);
    expect(clues.buySellBalance).toBeCloseTo(0.04352443619333124, 10);
    expect(clues.buySellBalanceBucket).toBe('balanced');
    expect(clues.tradingAcceleration).toBeCloseTo(3.3692507279622577, 10);
    expect(clues.tradingAccelerationBucket).toBe('accelerating');
    expect(clues.netflowOverLiquidity).toBeCloseTo(0.0048562890822944176, 10);
    expect(clues.netflowOverLiquidityBucket).toBe('balanced');
    expect(clues.recentMomentum).toBeCloseTo(0.0712165078343695, 10);
    expect(clues.recentMomentumBucket).toBe('rising');
  });

  it('reproduces the real round-001 YZY clue values and buckets (thin-trading case)', () => {
    const clues = computeClues(YZY);
    expect(clues.buySellBalance).toBeCloseTo(-0.3866186455411303, 10);
    expect(clues.buySellBalanceBucket).toBe('sell-heavy');
    expect(clues.tradingAccelerationBucket).toBe('steady');
    expect(clues.netflowOverLiquidityBucket).toBe('balanced');
    expect(clues.recentMomentumBucket).toBe('flat');
  });

  it('rejects a round when buy+sell volume is zero rather than treating it as neutral', () => {
    const bad: ClueInputs = {
      day1: { buy_volume: 0, sell_volume: 0, volume: 0, netflow: 0, liquidity: 1000 },
      day7: { volume: 700, price_change: 0.01 },
    };
    expect(() => computeClues(bad)).toThrow(ClueUnavailableError);
  });

  it('rejects a round when liquidity is zero rather than dividing by zero', () => {
    const bad: ClueInputs = {
      day1: { buy_volume: 100, sell_volume: 50, volume: 150, netflow: 10, liquidity: 0 },
      day7: { volume: 1000, price_change: 0.01 },
    };
    expect(() => computeClues(bad)).toThrow(/liquidity is 0/);
  });

  it('rejects a round when a required field is null (unavailable, not zero)', () => {
    const bad: ClueInputs = {
      day1: {
        buy_volume: 100,
        sell_volume: 50,
        volume: 150,
        netflow: 10,
        liquidity: null as unknown as number,
      },
      day7: { volume: 1000, price_change: 0.01 },
    };
    expect(() => computeClues(bad)).toThrow(ClueUnavailableError);
  });
});
