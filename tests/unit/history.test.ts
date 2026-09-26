import { describe, expect, it } from 'vitest';
import { buildGuestHistory, dailyStreak, type HistoryAttemptInput } from '@/lib/domain/history';

const NOW = new Date('2026-09-26T12:00:00Z');
// Real round-001 shape: A +38.18% (winner), B +2.07%, C +20.89%.
const ASSETS = [
  { slot: 'A' as const, tokenSymbol: 'POPCAT', returnRatio: 0.381768 },
  { slot: 'B' as const, tokenSymbol: 'YZY', returnRatio: 0.020684 },
  { slot: 'C' as const, tokenSymbol: 'BOME', returnRatio: 0.208927 },
];

let seq = 0;
function attempt(over: Partial<HistoryAttemptInput> = {}): HistoryAttemptInput {
  seq += 1;
  return {
    roundId: `round-${seq}`,
    repeatOf: null,
    mode: 'replay',
    roundStatus: 'ready',
    cutoff: new Date('2026-08-20T00:00:00Z'),
    stage: 'final_locked',
    blindSlot: 'B',
    finalSlot: 'A',
    finalActionType: 'switch',
    finalDeadlineAt: new Date('2026-09-26T11:00:15Z'),
    finalLockedAt: new Date('2026-09-26T11:00:05Z'),
    createdAt: new Date(Date.UTC(2026, 8, 26, 10, 0, seq)),
    dailyDate: null,
    assets: ASSETS,
    ...over,
  };
}

describe('Guest History definitions', () => {
  it('attempts on rounds that are not player-facing are listed as withdrawn and excluded from every metric', () => {
    const counted = attempt({ dailyDate: '2026-09-26' });
    const h = buildGuestHistory(
      [
        counted,
        attempt({ roundWithdrawn: true }),
        attempt({ roundWithdrawn: true, dailyDate: '2026-09-25' }),
        attempt({ mode: 'live', roundStatus: 'resolved', roundWithdrawn: true }),
      ],
      NOW,
      ['2026-09-25', '2026-09-26'],
    );
    const statuses = h.entries.map((e) => e.status).sort();
    expect(statuses).toEqual(['completed', 'withdrawn', 'withdrawn', 'withdrawn']);
    expect(h.entries.filter((e) => e.status === 'withdrawn').every((e) => e.outcome === null)).toBe(true);
    expect(h.summary.eligibleCount).toBe(1);
    expect(h.summary.combined.historicalEligibleCount).toBe(1);
    // A withdrawn Live prediction is counted like a void one: listed, never resolved or scored.
    expect(h.summary.live.resolvedCount).toBe(0);
    expect(h.summary.live.invalidCount).toBe(1);
    // A withdrawn Daily never counts toward the streak: 09-25 is missed, so the streak is 1.
    expect(h.summary.dailyStreak).toBe(1);
  });

  it('an empty History has no metrics and insufficient Ticker Tax evidence', () => {
    const h = buildGuestHistory([], NOW);
    expect(h.entries).toEqual([]);
    expect(h.summary.eligibleCount).toBe(0);
    expect(h.summary.tickerTax).toEqual({ status: 'insufficient_evidence', evidenceCount: 0, threshold: 5, averagePp: null });
    expect(h.summary.averageSwitchImpactPp).toBeNull();
  });

  it('abandoned Blind Pick attempts and open Unmask windows are neither listed nor counted', () => {
    const h = buildGuestHistory(
      [
        attempt({ stage: 'blind', blindSlot: null, finalSlot: null, finalActionType: null, finalDeadlineAt: null }),
        attempt({ stage: 'unmasked', finalSlot: null, finalActionType: null, finalDeadlineAt: new Date('2026-09-26T12:00:10Z') }),
        attempt({ mode: 'live', roundStatus: 'open', stage: 'blind', blindSlot: null, finalSlot: null, finalActionType: null }),
      ],
      NOW,
    );
    expect(h.entries).toHaveLength(0);
    expect(h.summary.eligibleCount).toBe(0);
    expect(h.summary.live.totalAttempts).toBe(0);
    expect(h.summary.combined.totalCompletedAttempts).toBe(0);
  });

  it('an expired Unmask window counts as a timeout that keeps the blind choice', () => {
    const h = buildGuestHistory(
      [attempt({ stage: 'unmasked', finalSlot: null, finalActionType: null, finalDeadlineAt: new Date('2026-09-26T11:59:00Z') })],
      NOW,
    );
    expect(h.entries[0]).toMatchObject({ status: 'completed', finalActionType: 'timeout', finalSlot: 'B', blindSlot: 'B' });
    expect(h.summary.timeouts).toBe(1);
    expect(h.summary.tickerTax.evidenceCount).toBe(0); // timeouts are never Ticker Tax evidence
  });

  it('a repeat of the same canonical round is listed but excluded from every metric', () => {
    const first = attempt({ roundId: 'canonical' });
    const repeat = attempt({ roundId: 'copy', repeatOf: 'canonical', finalSlot: 'C' });
    const h = buildGuestHistory([first, repeat], NOW);
    expect(h.summary.eligibleCount).toBe(1);
    expect(h.summary.repeatedCount).toBe(1);
    expect(h.entries.map((e) => e.status)).toEqual(['repeat', 'completed']); // newest first
  });

  it('computes accuracy, switch outcomes and average switch impact from real returns', () => {
    const h = buildGuestHistory(
      [
        attempt({ blindSlot: 'B', finalSlot: 'A', finalActionType: 'switch' }), // helped +36.11pp
        attempt({ blindSlot: 'A', finalSlot: 'C', finalActionType: 'switch' }), // hurt -17.28pp
        attempt({ blindSlot: 'A', finalSlot: 'A', finalActionType: 'stick' }),
      ],
      NOW,
    );
    expect(h.summary.blindAccuracy).toBeCloseTo(2 / 3, 10);
    expect(h.summary.finalAccuracy).toBeCloseTo(2 / 3, 10);
    expect(h.summary.switchesHelped).toBe(1);
    expect(h.summary.switchesHurt).toBe(1);
    expect(h.summary.averageSwitchImpactPp).toBeCloseTo((36.1084 + -17.2841) / 2, 3);
    const helped = h.entries.find((e) => e.blindSlot === 'B')!;
    expect(helped.outcome).toMatchObject({ winnerSymbols: ['POPCAT'], finalWasWinner: true, pointsAwarded: 100 });
  });

  it('Ticker Tax is measured only once the explicit-decision threshold is met', () => {
    const four = Array.from({ length: 4 }, () => attempt({ blindSlot: 'A', finalSlot: 'A', finalActionType: 'stick' }));
    expect(buildGuestHistory(four, NOW).summary.tickerTax.status).toBe('insufficient_evidence');
    const five = [...four, attempt({ blindSlot: 'B', finalSlot: 'A', finalActionType: 'switch' })];
    const tax = buildGuestHistory(five, NOW).summary.tickerTax;
    expect(tax.status).toBe('measured');
    expect(tax.evidenceCount).toBe(5);
    expect(tax.averagePp).toBeCloseTo(-36.1084 / 5, 3);
  });

  it('Live predictions are counted separately: pending, void when invalid, completed once resolved', () => {
    const h = buildGuestHistory(
      [
        attempt({ mode: 'live', roundStatus: 'open', assets: ASSETS.map((a) => ({ ...a, returnRatio: null })) }),
        attempt({ mode: 'live', roundStatus: 'invalid', assets: ASSETS.map((a) => ({ ...a, returnRatio: null })) }),
        attempt({ mode: 'live', roundStatus: 'resolved' }),
      ],
      NOW,
    );
    expect(h.summary.live).toEqual({ totalAttempts: 3, pendingCount: 1, resolvedCount: 1, invalidCount: 1 });
    expect(h.summary.eligibleCount).toBe(0); // Live never mixes into Replay/Daily metrics
    expect(h.entries.map((e) => e.status).sort()).toEqual(['completed', 'pending', 'void']);
    expect(h.entries.find((e) => e.status === 'pending')!.outcome).toBeNull(); // no outcome before resolution
  });

  it('a Daily play is labelled Daily; a later copy of the same canonical round is a Replay repeat', () => {
    const daily = attempt({ roundId: 'canon-1', dailyDate: '2026-09-26' });
    const later = attempt({ roundId: 'copy-1', repeatOf: 'canon-1', createdAt: new Date('2026-09-26T11:30:00Z') });
    const h = buildGuestHistory([daily, later], NOW, ['2026-09-26']);
    expect(h.entries.map((e) => [e.mode, e.status])).toEqual([
      ['replay', 'repeat'],
      ['daily', 'completed'],
    ]);
    expect(h.summary.eligibleCount).toBe(1); // one first-time score for one canonical round
    expect(h.summary.dailyStreak).toBe(1);
  });
});

describe('Daily streak', () => {
  const assigned = ['2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-26'];
  it('counts consecutive completed assigned Dailies back from today', () => {
    expect(dailyStreak(new Set(['2026-09-24', '2026-09-25', '2026-09-26']), assigned, '2026-09-26')).toBe(3);
  });
  it("today's unplayed Daily does not break the streak; an earlier missed one does", () => {
    expect(dailyStreak(new Set(['2026-09-24', '2026-09-25']), assigned, '2026-09-26')).toBe(2);
    expect(dailyStreak(new Set(['2026-09-22', '2026-09-23', '2026-09-26']), assigned, '2026-09-26')).toBe(1);
  });
  it('days without an assigned Daily neither count nor break it, and future dates are ignored', () => {
    expect(dailyStreak(new Set(['2026-09-20', '2026-09-26']), ['2026-09-20', '2026-09-26', '2026-09-27'], '2026-09-26')).toBe(2);
    expect(dailyStreak(new Set(), [], '2026-09-26')).toBe(0);
  });
});
