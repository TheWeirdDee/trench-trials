import { describe, expect, it } from 'vitest';
import {
  classifySwitchOutcome,
  determineFinalActionType,
  pointsForFinalChoice,
  switchImpactPp,
  tickerTaxPp,
} from '@/lib/domain/scoring';
import type { Slot } from '@/lib/domain/returns';

const ROUND_001_RETURNS: Record<Slot, number> = {
  A: 0.3817681251464389, // POPCAT — winner
  B: 0.02068354937005612, // YZY
  C: 0.20892699001934378, // BOME
};

describe('switchImpactPp / tickerTaxPp', () => {
  it('matches the illustrative round-001 example (blind B -> final A)', () => {
    const impact = switchImpactPp(ROUND_001_RETURNS.B, ROUND_001_RETURNS.A);
    expect(impact).toBeCloseTo(36.1, 1);
  });

  it('ticker tax is the exact negation of switch impact', () => {
    const rBlind = 0.1;
    const rFinal = 0.25;
    expect(tickerTaxPp(rBlind, rFinal)).toBeCloseTo(-switchImpactPp(rBlind, rFinal), 10);
  });

  it('an explicit stick has exactly 0.0pp impact', () => {
    expect(switchImpactPp(ROUND_001_RETURNS.A, ROUND_001_RETURNS.A)).toBe(0);
  });
});

describe('determineFinalActionType', () => {
  it('classifies stick, switch, and timeout correctly', () => {
    expect(determineFinalActionType({ blindSlot: 'A', finalSlot: 'A', timedOut: false })).toBe('stick');
    expect(determineFinalActionType({ blindSlot: 'A', finalSlot: 'B', timedOut: false })).toBe('switch');
    // A timeout always retains the blind slot, but must be reported as 'timeout', not 'stick'.
    expect(determineFinalActionType({ blindSlot: 'A', finalSlot: 'A', timedOut: true })).toBe('timeout');
  });
});

describe('classifySwitchOutcome', () => {
  it('helped on the real round-001 switch example', () => {
    const impact = switchImpactPp(ROUND_001_RETURNS.B, ROUND_001_RETURNS.A);
    expect(classifySwitchOutcome(impact)).toBe('helped');
  });

  it('hurt when impact is negative beyond tolerance', () => {
    expect(classifySwitchOutcome(-5)).toBe('hurt');
  });

  it('unchanged within the 0.01pp tolerance', () => {
    expect(classifySwitchOutcome(0.009)).toBe('unchanged');
    expect(classifySwitchOutcome(-0.009)).toBe('unchanged');
  });

  it('not unchanged just outside tolerance', () => {
    expect(classifySwitchOutcome(0.02)).toBe('helped');
    expect(classifySwitchOutcome(-0.02)).toBe('hurt');
  });
});

describe('pointsForFinalChoice', () => {
  it('awards 100 for the real round-001 winner and 0 otherwise', () => {
    expect(pointsForFinalChoice('A', ROUND_001_RETURNS)).toBe(100);
    expect(pointsForFinalChoice('B', ROUND_001_RETURNS)).toBe(0);
    expect(pointsForFinalChoice('C', ROUND_001_RETURNS)).toBe(0);
  });

  it('awards 100 to all slots within tie tolerance', () => {
    const returns: Record<Slot, number> = { A: 0.1, B: 0.100099, C: 0.05 };
    expect(pointsForFinalChoice('A', returns)).toBe(100);
    expect(pointsForFinalChoice('B', returns)).toBe(100);
    expect(pointsForFinalChoice('C', returns)).toBe(0);
  });
});
