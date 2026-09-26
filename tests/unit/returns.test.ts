import { describe, expect, it } from 'vitest';
import { computeReturn, determineWinningSlots, type Slot } from '@/lib/domain/returns';

describe('computeReturn', () => {
  it('matches the real round-001 POPCAT return', () => {
    const r = computeReturn(0.04301576711450214, 0.05943781587754146);
    expect(r).toBeCloseTo(0.3817681251464389, 12);
  });

  it('matches the real round-001 YZY return', () => {
    const r = computeReturn(0.28814116434640574, 0.29410094634471007);
    expect(r).toBeCloseTo(0.02068354937005612, 12);
  });

  it('matches the real round-001 BOME return', () => {
    const r = computeReturn(0.0008755176038674171, 0.0010584368615523848);
    expect(r).toBeCloseTo(0.20892699001934378, 12);
  });

  it('rejects zero or negative entry price', () => {
    expect(() => computeReturn(0, 1)).toThrow(/entry price/i);
    expect(() => computeReturn(-1, 1)).toThrow(/entry price/i);
  });

  it('rejects zero, negative, non-finite exit price', () => {
    expect(() => computeReturn(1, 0)).toThrow(/exit price/i);
    expect(() => computeReturn(1, -1)).toThrow(/exit price/i);
    expect(() => computeReturn(1, NaN)).toThrow(/exit price/i);
    expect(() => computeReturn(1, Infinity)).toThrow(/exit price/i);
  });
});

describe('determineWinningSlots', () => {
  it('picks the sole winner from real round-001 returns', () => {
    const returns: Record<Slot, number> = {
      A: 0.3817681251464389, // POPCAT
      B: 0.02068354937005612, // YZY
      C: 0.20892699001934378, // BOME
    };
    expect(determineWinningSlots(returns)).toEqual(['A']);
  });

  it('includes both slots within the 0.01pp tie tolerance', () => {
    const returns: Record<Slot, number> = { A: 0.1, B: 0.100099, C: 0.05 };
    // delta = 0.000099 ratio = 0.0099pp < 0.01pp tolerance -> tie
    expect(determineWinningSlots(returns).sort()).toEqual(['A', 'B']);
  });

  it('excludes a slot just outside the tie tolerance', () => {
    const returns: Record<Slot, number> = { A: 0.1, B: 0.0998, C: 0.05 };
    // delta = 0.0002 ratio = 0.02pp > 0.01pp tolerance -> not a tie
    expect(determineWinningSlots(returns)).toEqual(['A']);
  });

  it('handles a three-way tie', () => {
    const returns: Record<Slot, number> = { A: 0.1, B: 0.1, C: 0.1 };
    expect(determineWinningSlots(returns).sort()).toEqual(['A', 'B', 'C']);
  });
});
