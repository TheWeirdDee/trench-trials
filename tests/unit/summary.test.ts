import { describe, expect, it } from 'vitest';
import {
  computeSummary,
  countExclusions,
  EARLY_RESULTS_THRESHOLD,
  type AttemptSummaryRow,
} from '@/lib/domain/summary';

function row(overrides: Partial<AttemptSummaryRow>): AttemptSummaryRow {
  return {
    blindSlot: 'A',
    finalSlot: 'A',
    finalActionType: 'stick',
    blindReturn: 0.1,
    finalReturn: 0.1,
    winningSlots: ['A'],
    ...overrides,
  };
}

describe('computeSummary', () => {
  it('returns nulls and zero counts for no rows', () => {
    const s = computeSummary([]);
    expect(s.eligibleCount).toBe(0);
    expect(s.blindAccuracy).toBeNull();
    expect(s.averageTickerTaxPp).toBeNull();
    expect(s.isEarlyResults).toBe(true);
  });

  it('counts an explicit stick as exactly 0 ticker tax, included in the denominator', () => {
    const s = computeSummary([row({ finalActionType: 'stick', blindReturn: 0.2, finalReturn: 0.2 })]);
    expect(s.explicitSticks).toBe(1);
    expect(s.tickerTaxDenominator).toBe(1);
    expect(s.averageTickerTaxPp).toBe(0);
  });

  it('excludes timeouts from the ticker tax denominator but counts them separately', () => {
    const s = computeSummary([
      row({ finalActionType: 'timeout', blindReturn: 0.5, finalReturn: 0.5 }),
      row({ finalActionType: 'stick', blindReturn: 0.1, finalReturn: 0.1 }),
    ]);
    expect(s.timeouts).toBe(1);
    expect(s.tickerTaxDenominator).toBe(1); // only the stick counts
    expect(s.eligibleCount).toBe(2); // but both count as completed rounds
  });

  it('classifies a helpful switch correctly and computes tax as the negation of impact', () => {
    const s = computeSummary([
      row({
        blindSlot: 'B',
        finalSlot: 'A',
        finalActionType: 'switch',
        blindReturn: 0.02068354937005612,
        finalReturn: 0.3817681251464389,
        winningSlots: ['A'],
      }),
    ]);
    expect(s.switches).toBe(1);
    expect(s.switchesHelped).toBe(1);
    expect(s.switchesHurt).toBe(0);
    expect(s.averageTickerTaxPp).toBeCloseTo(-36.1, 1); // tax negative = benefit
  });

  it('classifies a harmful switch correctly', () => {
    const s = computeSummary([
      row({ blindSlot: 'A', finalSlot: 'B', finalActionType: 'switch', blindReturn: 0.3, finalReturn: 0.1 }),
    ]);
    expect(s.switchesHurt).toBe(1);
    expect(s.averageTickerTaxPp).toBeCloseTo(20, 10); // 100*(0.3-0.1)
  });

  it('computes blind and final accuracy against the real winning slot', () => {
    const s = computeSummary([
      row({ blindSlot: 'A', finalSlot: 'A', winningSlots: ['A'] }), // both correct
      row({ blindSlot: 'B', finalSlot: 'A', finalActionType: 'switch', winningSlots: ['A'] }), // blind wrong, final correct
      row({ blindSlot: 'C', finalSlot: 'C', winningSlots: ['A'] }), // both wrong
    ]);
    expect(s.blindAccuracy).toBeCloseTo(1 / 3, 10);
    expect(s.finalAccuracy).toBeCloseTo(2 / 3, 10);
  });

  it('flags Early results below the threshold and not at/above it', () => {
    const below = computeSummary(
      Array.from({ length: EARLY_RESULTS_THRESHOLD - 1 }, () => row({ finalActionType: 'stick' })),
    );
    const atThreshold = computeSummary(
      Array.from({ length: EARLY_RESULTS_THRESHOLD }, () => row({ finalActionType: 'stick' })),
    );
    expect(below.isEarlyResults).toBe(true);
    expect(atThreshold.isEarlyResults).toBe(false);
  });

  it('timeouts do not count toward the Early-results explicit-decision threshold', () => {
    const s = computeSummary([
      ...Array.from({ length: 4 }, () => row({ finalActionType: 'stick' })),
      ...Array.from({ length: 10 }, () => row({ finalActionType: 'timeout' })),
    ]);
    // 4 explicit decisions + many timeouts should still be "early" — timeouts aren't a substitute.
    expect(s.isEarlyResults).toBe(true);
  });

  it('computeSummary defaults exclusion counts to zero when none are passed', () => {
    const s = computeSummary([row({ finalActionType: 'stick' })]);
    expect(s.repeatedCount).toBe(0);
    expect(s.invalidCount).toBe(0);
    expect(s.pendingCount).toBe(0);
  });

  it('computeSummary carries through explicitly-passed exclusion counts unchanged', () => {
    const s = computeSummary([row({ finalActionType: 'stick' })], {
      repeatedCount: 2,
      invalidCount: 1,
      pendingCount: 3,
    });
    expect(s.repeatedCount).toBe(2);
    expect(s.invalidCount).toBe(1);
    expect(s.pendingCount).toBe(3);
    // Exclusions never affect the eligible-round math.
    expect(s.eligibleCount).toBe(1);
  });
});

describe('countExclusions', () => {
  it('counts nothing for an empty input', () => {
    expect(countExclusions([])).toEqual({ repeatedCount: 0, invalidCount: 0, pendingCount: 0 });
  });

  it('counts a repeat separately from an invalid or pending round', () => {
    const result = countExclusions([
      { isRepeat: true, roundStatus: 'ready' },
      { isRepeat: false, roundStatus: 'invalid' },
      { isRepeat: false, roundStatus: 'resolving' },
      { isRepeat: false, roundStatus: 'ready' }, // eligible, not excluded for either reason
    ]);
    expect(result).toEqual({ repeatedCount: 1, invalidCount: 1, pendingCount: 1 });
  });

  it('a round can be counted as both repeated AND invalid at once (not mutually exclusive)', () => {
    const result = countExclusions([{ isRepeat: true, roundStatus: 'invalid' }]);
    expect(result).toEqual({ repeatedCount: 1, invalidCount: 1, pendingCount: 0 });
  });

  it('treats any non-resolved, non-invalid status as pending (draft, open, resolving)', () => {
    const result = countExclusions([
      { isRepeat: false, roundStatus: 'draft' },
      { isRepeat: false, roundStatus: 'open' },
      { isRepeat: false, roundStatus: 'resolving' },
    ]);
    expect(result.pendingCount).toBe(3);
    expect(result.invalidCount).toBe(0);
  });

  it('treats "ready" and "resolved" as resolved, not pending', () => {
    const result = countExclusions([
      { isRepeat: false, roundStatus: 'ready' },
      { isRepeat: false, roundStatus: 'resolved' },
    ]);
    expect(result).toEqual({ repeatedCount: 0, invalidCount: 0, pendingCount: 0 });
  });
});

describe('Historical vs Live metrics separation', () => {
  it('keeps historical Ticker Tax completely independent of prospective Live attempts', () => {
    const historicalRows = [
      row({ finalActionType: 'switch', blindReturn: 0.1, finalReturn: 0.3 }),
      row({ finalActionType: 'stick', blindReturn: 0.2, finalReturn: 0.2 }),
    ];
    const liveGroup = {
      totalAttempts: 3,
      pendingCount: 2,
      resolvedCount: 0,
      invalidCount: 1, // 1 failed-closed Live round
    };
    const s = computeSummary(historicalRows, { repeatedCount: 0, invalidCount: 0, pendingCount: 0 }, liveGroup);

    // Historical metrics
    expect(s.historical.eligibleCount).toBe(2);
    expect(s.historical.averageTickerTaxPp).toBeCloseTo(-10, 1);
    expect(s.averageTickerTaxPp).toBeCloseTo(-10, 1);

    // Live metrics are isolated
    expect(s.live.totalAttempts).toBe(3);
    expect(s.live.pendingCount).toBe(2);
    expect(s.live.invalidCount).toBe(1);

    // Combined totals are counts only — no blended Ticker Tax
    expect(s.combined.totalCompletedAttempts).toBe(5);
    expect(s.combined.historicalEligibleCount).toBe(2);
    expect(s.combined.liveAttemptsCount).toBe(3);
  });
});
