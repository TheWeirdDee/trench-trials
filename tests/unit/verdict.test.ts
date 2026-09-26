import { describe, expect, it } from 'vitest';
import { buildVerdict } from '@/lib/domain/verdict';
import type { RoundAssetFull } from '@/lib/allowlist';

// Real round-001 data, all 3 slots.
const ASSETS: RoundAssetFull[] = [
  {
    slot: 'A',
    tokenSymbol: 'POPCAT',
    tokenAddress: '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr',
    sectors: ['Memecoins'],
    clueBuySellBalanceBucket: 'balanced',
    clueTradingAccelerationBucket: 'accelerating',
    clueNetflowOverLiquidityBucket: 'balanced',
    clueRecentMomentumBucket: 'rising',
    entryCandleStart: '2026-08-19T23:00:00Z',
    entryPrice: 0.04301576711450214,
    exitCandleStart: '2026-08-26T23:00:00Z',
    exitPrice: 0.05943781587754146,
    returnRatio: 0.3817681251464389,
  },
  {
    slot: 'B',
    tokenSymbol: 'YZY',
    tokenAddress: 'DrZ26cKJDksVRWib3DVVsjo9eeXccc7hKhDJviiYEEZY',
    sectors: ['Memecoins'],
    clueBuySellBalanceBucket: 'sell-heavy',
    clueTradingAccelerationBucket: 'steady',
    clueNetflowOverLiquidityBucket: 'balanced',
    clueRecentMomentumBucket: 'flat',
    entryCandleStart: '2026-08-19T23:00:00Z',
    entryPrice: 0.28814116434640574,
    exitCandleStart: '2026-08-26T23:00:00Z',
    exitPrice: 0.29410094634471007,
    returnRatio: 0.02068354937005612,
  },
  {
    slot: 'C',
    tokenSymbol: 'BOME',
    tokenAddress: 'ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82',
    sectors: ['Memecoins'],
    clueBuySellBalanceBucket: 'balanced',
    clueTradingAccelerationBucket: 'accelerating',
    clueNetflowOverLiquidityBucket: 'inward',
    clueRecentMomentumBucket: 'rising',
    entryCandleStart: '2026-08-19T23:00:00Z',
    entryPrice: 0.0008755176038674171,
    exitCandleStart: '2026-08-26T23:00:00Z',
    exitPrice: 0.0010584368615523848,
    returnRatio: 0.20892699001934378,
  },
];

describe('buildVerdict — real round-001, blind B -> switch to A (the PRD illustrative example)', () => {
  const verdict = buildVerdict({ assets: ASSETS, blindSlot: 'B', finalSlot: 'A', finalActionType: 'switch' });

  it('reports the winning slot as A (POPCAT, the real winner)', () => {
    expect(verdict.winningSlots).toEqual(['A']);
    expect(verdict.finalWasWinner).toBe(true);
    expect(verdict.blindWasWinner).toBe(false);
  });

  it('computes switch impact matching the PRD illustrative example (~+36.1pp)', () => {
    expect(verdict.switchImpactPp).toBeCloseTo(36.1, 1);
    expect(verdict.switchOutcome).toBe('helped');
  });

  it('ticker tax is the negation of switch impact for a switch', () => {
    expect(verdict.tickerTaxPp).toBeCloseTo(-verdict.switchImpactPp, 10);
  });

  it('awards 100 points since the final choice was the real winner', () => {
    expect(verdict.pointsAwarded).toBe(100);
  });
});

describe('buildVerdict — explicit stick is always exactly 0.0pp regardless of outcome', () => {
  it('blind B, stick with B (not the winner) — impact and tax are exactly 0', () => {
    const verdict = buildVerdict({ assets: ASSETS, blindSlot: 'B', finalSlot: 'B', finalActionType: 'stick' });
    expect(verdict.switchImpactPp).toBe(0);
    expect(verdict.tickerTaxPp).toBe(0);
    expect(verdict.switchOutcome).toBeNull();
    expect(verdict.pointsAwarded).toBe(0);
  });

  it('blind A, stick with A (the winner) — still exactly 0pp impact, 100 points', () => {
    const verdict = buildVerdict({ assets: ASSETS, blindSlot: 'A', finalSlot: 'A', finalActionType: 'stick' });
    expect(verdict.switchImpactPp).toBe(0);
    expect(verdict.pointsAwarded).toBe(100);
    expect(verdict.blindWasWinner).toBe(true);
  });
});

describe('buildVerdict — timeout retains the blind choice and is not classified helped/hurt', () => {
  it('treats a timeout the same as a stick for impact purposes, with switchOutcome null', () => {
    const verdict = buildVerdict({ assets: ASSETS, blindSlot: 'C', finalSlot: 'C', finalActionType: 'timeout' });
    expect(verdict.switchImpactPp).toBe(0);
    expect(verdict.switchOutcome).toBeNull();
    expect(verdict.finalActionType).toBe('timeout');
  });
});

describe('buildVerdict — a switch that hurt', () => {
  it('blind A (the winner) switched to B — negative impact, classified hurt', () => {
    const verdict = buildVerdict({ assets: ASSETS, blindSlot: 'A', finalSlot: 'B', finalActionType: 'switch' });
    expect(verdict.switchImpactPp).toBeLessThan(0);
    expect(verdict.switchOutcome).toBe('hurt');
    expect(verdict.tickerTaxPp).toBeGreaterThan(0);
    expect(verdict.pointsAwarded).toBe(0);
  });
});

describe('buildVerdict — verdict asset views reveal identity and returns', () => {
  it('includes token symbols and return percentages for all 3 slots', () => {
    const verdict = buildVerdict({ assets: ASSETS, blindSlot: 'A', finalSlot: 'A', finalActionType: 'stick' });
    const symbols = verdict.assets.map((a) => a.tokenSymbol).sort();
    expect(symbols).toEqual(['BOME', 'POPCAT', 'YZY']);
    const popcat = verdict.assets.find((a) => a.slot === 'A');
    expect(popcat?.returnPct).toBeCloseTo(38.17681251464389, 10);
  });
});
