import { determineWinningSlots, TIE_TOLERANCE_RATIO, type Slot } from './returns';

export type FinalActionType = 'stick' | 'switch' | 'timeout';

/** switch_impact_pp = 100 * (r_final - r_blind). Positive means switching helped. */
export function switchImpactPp(rBlind: number, rFinal: number): number {
  return 100 * (rFinal - rBlind);
}

/** ticker_tax_pp = 100 * (r_blind - r_final). Positive means the final choice underperformed. */
export function tickerTaxPp(rBlind: number, rFinal: number): number {
  return 100 * (rBlind - rFinal);
}

export function determineFinalActionType(params: {
  blindSlot: Slot;
  finalSlot: Slot;
  timedOut: boolean;
}): FinalActionType {
  if (params.timedOut) return 'timeout';
  return params.blindSlot === params.finalSlot ? 'stick' : 'switch';
}

/**
 * Classifies a switch's effect. Only meaningful for explicit switches — an explicit
 * stick is defined as exactly 0.0 pp impact per PRD §5.3 and should not be passed here.
 * "Unchanged" uses the same tie tolerance as winner determination (PRD §7).
 */
export function classifySwitchOutcome(impactPp: number): 'helped' | 'hurt' | 'unchanged' {
  const toleranceInPp = TIE_TOLERANCE_RATIO * 100;
  if (Math.abs(impactPp) <= toleranceInPp) return 'unchanged';
  return impactPp > 0 ? 'helped' : 'hurt';
}

/**
 * +100 points if the final-choice slot is a winning slot (within tie tolerance of the
 * max unrounded return), otherwise 0. Scoring must use unrounded returns per PRD §7.
 */
export function pointsForFinalChoice(finalSlot: Slot, returns: Record<Slot, number>): number {
  const winners = determineWinningSlots(returns);
  return winners.includes(finalSlot) ? 100 : 0;
}
