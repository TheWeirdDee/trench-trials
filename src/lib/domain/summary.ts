import { classifySwitchOutcome, switchImpactPp, tickerTaxPp } from './scoring';
import type { Slot } from './returns';

export interface AttemptSummaryRow {
  blindSlot: Slot;
  finalSlot: Slot;
  finalActionType: 'stick' | 'switch' | 'timeout';
  blindReturn: number;
  finalReturn: number;
  winningSlots: Slot[];
}

export interface PlayerSummaryGroup {
  eligibleCount: number;
  blindAccuracy: number | null;
  finalAccuracy: number | null;
  explicitSticks: number;
  switches: number;
  switchesHelped: number;
  switchesHurt: number;
  switchesUnchanged: number;
  timeouts: number;
  averageTickerTaxPp: number | null;
  tickerTaxDenominator: number;
  isEarlyResults: boolean;
  repeatedCount: number;
  invalidCount: number;
  pendingCount: number;
}

export interface LiveSummaryGroup {
  totalAttempts: number;
  pendingCount: number;
  resolvedCount: number;
  invalidCount: number;
}

export interface CombinedSummaryCounts {
  totalCompletedAttempts: number;
  historicalEligibleCount: number;
  liveAttemptsCount: number;
}

export interface PlayerSummary extends PlayerSummaryGroup {
  historical: PlayerSummaryGroup;
  live: LiveSummaryGroup;
  combined: CombinedSummaryCounts;
}

/** PRD §7: "With fewer than five eligible explicit decisions, display Early results." */
export const EARLY_RESULTS_THRESHOLD = 5;

/**
 * Pure aggregation over already-filtered rows (first-time, non-invalid, non-pending,
 * final-locked attempts — that filtering happens in the repo query, not here, so this
 * function stays unit-testable without a database).
 */
export function computeSummaryGroup(
  rows: AttemptSummaryRow[],
  exclusions: ExclusionCounts = { repeatedCount: 0, invalidCount: 0, pendingCount: 0 },
): PlayerSummaryGroup {
  const eligibleForTax = rows.filter((r) => r.finalActionType !== 'timeout');
  const timeouts = rows.filter((r) => r.finalActionType === 'timeout').length;
  const sticks = rows.filter((r) => r.finalActionType === 'stick').length;
  const switches = rows.filter((r) => r.finalActionType === 'switch');

  let helped = 0;
  let hurt = 0;
  let unchanged = 0;
  for (const r of switches) {
    const impact = switchImpactPp(r.blindReturn, r.finalReturn);
    const outcome = classifySwitchOutcome(impact);
    if (outcome === 'helped') helped++;
    else if (outcome === 'hurt') hurt++;
    else unchanged++;
  }

  const taxValues = eligibleForTax.map((r) => tickerTaxPp(r.blindReturn, r.finalReturn));
  const averageTickerTaxPp =
    taxValues.length > 0 ? taxValues.reduce((a, b) => a + b, 0) / taxValues.length : null;

  const blindCorrect = rows.filter((r) => r.winningSlots.includes(r.blindSlot)).length;
  const finalCorrect = rows.filter((r) => r.winningSlots.includes(r.finalSlot)).length;

  return {
    eligibleCount: rows.length,
    blindAccuracy: rows.length > 0 ? blindCorrect / rows.length : null,
    finalAccuracy: rows.length > 0 ? finalCorrect / rows.length : null,
    explicitSticks: sticks,
    switches: switches.length,
    switchesHelped: helped,
    switchesHurt: hurt,
    switchesUnchanged: unchanged,
    timeouts,
    averageTickerTaxPp,
    tickerTaxDenominator: taxValues.length,
    isEarlyResults: eligibleForTax.length < EARLY_RESULTS_THRESHOLD,
    repeatedCount: exclusions.repeatedCount,
    invalidCount: exclusions.invalidCount,
    pendingCount: exclusions.pendingCount,
  };
}

export function computeSummary(
  rows: AttemptSummaryRow[],
  exclusions: ExclusionCounts = { repeatedCount: 0, invalidCount: 0, pendingCount: 0 },
  liveSummary: LiveSummaryGroup = { totalAttempts: 0, pendingCount: 0, resolvedCount: 0, invalidCount: 0 },
): PlayerSummary {
  const historical = computeSummaryGroup(rows, exclusions);
  return {
    ...historical,
    historical,
    live: liveSummary,
    combined: {
      totalCompletedAttempts: historical.eligibleCount + historical.repeatedCount + liveSummary.totalAttempts,
      historicalEligibleCount: historical.eligibleCount,
      liveAttemptsCount: liveSummary.totalAttempts,
    },
  };
}

export interface RoundExclusionInput {
  isRepeat: boolean;
  roundStatus: string;
}

export interface ExclusionCounts {
  repeatedCount: number;
  invalidCount: number;
  pendingCount: number;
}

const RESOLVED_STATUSES = new Set(['ready', 'resolved']);

/**
 * Counts why a completed (final_locked), non-Live attempt was excluded from the
 * eligible/Ticker-Tax set — repeats and invalid/pending rounds are never silently
 * dropped from the summary; their counts are shown separately (PRD §7).
 * A round can be excluded for more than one reason at once (e.g. a repeat of an
 * invalid round); each reason is counted independently, not mutually exclusively.
 */
export function countExclusions(rows: RoundExclusionInput[]): ExclusionCounts {
  let repeatedCount = 0;
  let invalidCount = 0;
  let pendingCount = 0;
  for (const r of rows) {
    if (r.isRepeat) repeatedCount++;
    if (r.roundStatus === 'invalid') invalidCount++;
    else if (!RESOLVED_STATUSES.has(r.roundStatus)) pendingCount++;
  }
  return { repeatedCount, invalidCount, pendingCount };
}
