import { coarsePeriod } from './period';
import { determineWinningSlots, type Slot } from './returns';
import { pointsForFinalChoice, switchImpactPp, tickerTaxPp, type FinalActionType } from './scoring';
import {
  computeSummary,
  countExclusions,
  EARLY_RESULTS_THRESHOLD,
  type AttemptSummaryRow,
  type LiveSummaryGroup,
  type PlayerSummary,
} from './summary';

/**
 * A guest's History, computed from their attempts. Definitions (also stated on /docs):
 *
 * - An attempt is DECIDED once its final choice is locked: an explicit keep or switch,
 *   or a timeout once the Unmask window has expired (the blind choice is retained).
 *   Undecided attempts — abandoned at Blind Pick, or still inside an open Unmask
 *   window — are not counted anywhere and not listed.
 * - A decided Replay/Daily attempt is COMPLETED when its round has a verified outcome.
 *   The first completed attempt per canonical round (repeat_of ?? round id) is
 *   first-time; later ones are repeats, listed but excluded from every metric.
 * - Metrics (accuracy, switches, Ticker Tax) use first-time completed Replay/Daily
 *   trials only. Ticker Tax evidence excludes timeouts and reads "insufficient
 *   evidence" until EARLY_RESULTS_THRESHOLD explicit decisions exist.
 * - Live is kept separate: a decided Live attempt is a locked prediction — pending until
 *   the round resolves, completed once resolved, void if the round is invalidated.
 * - An attempt is a DAILY play when it was started on the UTC date its round was the
 *   Daily. The round itself is canonical; the same round played on another day is Replay.
 * - The DAILY STREAK counts assigned Daily dates, newest first up to today, that the
 *   guest completed on the day. Today's Daily still unplayed does not break it; any
 *   earlier assigned Daily missed does.
 * - An attempt on a round that is not player-facing (withdrawn, under review, or approved
 *   only under an older eligibility policy) is listed as WITHDRAWN and excluded from every
 *   metric, Live counts and the streak — never silently kept.
 */

export interface HistoryAttemptInput {
  roundId: string;
  repeatOf: string | null;
  mode: 'replay' | 'daily' | 'live';
  roundStatus: string;
  /** The round is not player-facing under the current eligibility policy. */
  roundWithdrawn?: boolean;
  cutoff: Date;
  stage: string;
  blindSlot: Slot | null;
  finalSlot: Slot | null;
  finalActionType: FinalActionType | null;
  finalDeadlineAt: Date | null;
  finalLockedAt: Date | null;
  createdAt: Date;
  /** The UTC date this attempt played the round as that day's Daily, else null. */
  dailyDate: string | null;
  assets: Array<{ slot: Slot; tokenSymbol: string; returnRatio: number | null }>;
}

export type HistoryEntryStatus = 'completed' | 'repeat' | 'pending' | 'void' | 'withdrawn';

export interface HistoryEntry {
  roundId: string;
  mode: 'replay' | 'daily' | 'live';
  dailyDate: string | null;
  period: string;
  decidedAt: string;
  status: HistoryEntryStatus;
  blindSlot: Slot;
  finalSlot: Slot;
  finalActionType: FinalActionType;
  blindSymbol: string | null;
  finalSymbol: string | null;
  /** Only when the round has a verified outcome. */
  outcome: {
    winningSlots: Slot[];
    winnerSymbols: string[];
    blindReturnPct: number;
    finalReturnPct: number;
    switchImpactPp: number;
    finalWasWinner: boolean;
    pointsAwarded: number;
  } | null;
}

export interface GuestHistory {
  summary: PlayerSummary & {
    averageSwitchImpactPp: number | null;
    dailyStreak: number;
    tickerTax: {
      status: 'insufficient_evidence' | 'measured';
      evidenceCount: number;
      threshold: number;
      averagePp: number | null;
    };
  };
  entries: HistoryEntry[];
}

const HISTORICAL_OUTCOME_STATUSES = new Set(['ready', 'resolved']);

/** The attempt's final decision as of `now` (an expired Unmask window is a timeout), or null if undecided. */
function decision(a: HistoryAttemptInput, now: Date): { finalSlot: Slot; finalActionType: FinalActionType; decidedAt: Date } | null {
  if (a.stage === 'final_locked' && a.blindSlot && a.finalSlot && a.finalActionType) {
    return { finalSlot: a.finalSlot, finalActionType: a.finalActionType, decidedAt: a.finalLockedAt ?? a.createdAt };
  }
  if (a.stage === 'unmasked' && a.blindSlot && a.finalDeadlineAt && a.finalDeadlineAt.getTime() <= now.getTime()) {
    return { finalSlot: a.blindSlot, finalActionType: 'timeout', decidedAt: a.finalDeadlineAt };
  }
  return null;
}

function returnsOf(a: HistoryAttemptInput): Record<Slot, number> | null {
  const returns = {} as Record<Slot, number>;
  for (const asset of a.assets) {
    if (asset.returnRatio === null || !Number.isFinite(asset.returnRatio)) return null;
    returns[asset.slot] = asset.returnRatio;
  }
  return a.assets.length === 3 ? returns : null;
}

/** See DAILY STREAK above. `assignedDailyDates` are YYYY-MM-DD, any order, none after today. */
export function dailyStreak(completedDailyDates: Set<string>, assignedDailyDates: string[], today: string): number {
  let streak = 0;
  for (const date of [...assignedDailyDates].sort().reverse()) {
    if (date > today) continue;
    if (completedDailyDates.has(date)) streak += 1;
    else if (date === today) continue;
    else break;
  }
  return streak;
}

export function buildGuestHistory(
  attempts: HistoryAttemptInput[],
  now: Date,
  assignedDailyDates: string[] = [],
): GuestHistory {
  const ordered = [...attempts].sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime());
  const seenCanonical = new Set<string>();
  const summaryRows: AttemptSummaryRow[] = [];
  const exclusionInputs: { isRepeat: boolean; roundStatus: string }[] = [];
  const live: LiveSummaryGroup = { totalAttempts: 0, pendingCount: 0, resolvedCount: 0, invalidCount: 0 };
  const entries: HistoryEntry[] = [];

  for (const a of ordered) {
    const decided = decision(a, now);
    if (!decided || !a.blindSlot) continue;

    const symbolOf = (slot: Slot) => a.assets.find((x) => x.slot === slot)?.tokenSymbol ?? null;
    const returns = returnsOf(a);
    let status: HistoryEntryStatus;

    if (a.roundWithdrawn) {
      status = 'withdrawn';
      if (a.mode === 'live') {
        live.totalAttempts += 1;
        live.invalidCount += 1;
      } else {
        exclusionInputs.push({ isRepeat: false, roundStatus: 'invalid' });
      }
    } else if (a.mode === 'live') {
      live.totalAttempts += 1;
      if (a.roundStatus === 'resolved' && returns) {
        live.resolvedCount += 1;
        status = 'completed';
      } else if (a.roundStatus === 'invalid') {
        live.invalidCount += 1;
        status = 'void';
      } else {
        live.pendingCount += 1;
        status = 'pending';
      }
    } else {
      const canonical = a.repeatOf ?? a.roundId;
      const isRepeat = seenCanonical.has(canonical);
      seenCanonical.add(canonical);
      exclusionInputs.push({ isRepeat, roundStatus: a.roundStatus });
      const hasOutcome = HISTORICAL_OUTCOME_STATUSES.has(a.roundStatus) && returns !== null;
      if (isRepeat) status = 'repeat';
      else if (!hasOutcome) status = a.roundStatus === 'invalid' ? 'void' : 'pending';
      else {
        status = 'completed';
        const winningSlots = determineWinningSlots(returns!);
        summaryRows.push({
          blindSlot: a.blindSlot,
          finalSlot: decided.finalSlot,
          finalActionType: decided.finalActionType,
          blindReturn: returns![a.blindSlot],
          finalReturn: returns![decided.finalSlot],
          winningSlots,
        });
      }
    }

    let outcome: HistoryEntry['outcome'] = null;
    if (returns && (status === 'completed' || status === 'repeat')) {
      const winningSlots = determineWinningSlots(returns);
      outcome = {
        winningSlots,
        winnerSymbols: winningSlots.map((s) => symbolOf(s) ?? s),
        blindReturnPct: returns[a.blindSlot] * 100,
        finalReturnPct: returns[decided.finalSlot] * 100,
        switchImpactPp: decided.finalActionType === 'switch' ? switchImpactPp(returns[a.blindSlot], returns[decided.finalSlot]) : 0,
        finalWasWinner: winningSlots.includes(decided.finalSlot),
        pointsAwarded: pointsForFinalChoice(decided.finalSlot, returns),
      };
    }

    entries.push({
      roundId: a.roundId,
      mode: a.dailyDate ? 'daily' : a.mode,
      dailyDate: a.dailyDate,
      period: coarsePeriod(a.cutoff),
      decidedAt: decided.decidedAt.toISOString(),
      status,
      blindSlot: a.blindSlot,
      finalSlot: decided.finalSlot,
      finalActionType: decided.finalActionType,
      blindSymbol: symbolOf(a.blindSlot),
      finalSymbol: symbolOf(decided.finalSlot),
      outcome,
    });
  }

  const base = computeSummary(summaryRows, countExclusions(exclusionInputs), live);
  const switches = summaryRows.filter((r) => r.finalActionType === 'switch');
  const averageSwitchImpactPp =
    switches.length > 0
      ? switches.reduce((sum, r) => sum + switchImpactPp(r.blindReturn, r.finalReturn), 0) / switches.length
      : null;
  const completedDailyDates = new Set(
    entries.filter((e) => e.dailyDate && (e.status === 'completed' || e.status === 'repeat')).map((e) => e.dailyDate!),
  );
  const evidence = summaryRows.filter((r) => r.finalActionType !== 'timeout');
  const measured = evidence.length >= EARLY_RESULTS_THRESHOLD;

  return {
    summary: {
      ...base,
      averageSwitchImpactPp,
      dailyStreak: dailyStreak(completedDailyDates, assignedDailyDates, now.toISOString().slice(0, 10)),
      tickerTax: {
        status: measured ? 'measured' : 'insufficient_evidence',
        evidenceCount: evidence.length,
        threshold: EARLY_RESULTS_THRESHOLD,
        averagePp: measured
          ? evidence.reduce((sum, r) => sum + tickerTaxPp(r.blindReturn, r.finalReturn), 0) / evidence.length
          : null,
      },
    },
    entries: entries.reverse(),
  };
}
