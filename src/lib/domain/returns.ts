export type Slot = 'A' | 'B' | 'C';

export const SLOTS: readonly Slot[] = ['A', 'B', 'C'];

/** Tie tolerance in percentage points, per PRD §7: within 0.01pp of the max shares the win. */
export const TIE_TOLERANCE_PP = 0.01;

/** Same value expressed as a raw return-ratio delta (0.01pp === 0.0001 ratio). */
export const TIE_TOLERANCE_RATIO = TIE_TOLERANCE_PP / 100;

/**
 * r = exit_price / entry_price - 1
 * Requires finite, positive prices — throws otherwise so an invalid round
 * cannot silently produce a return. Callers must catch and mark the round INVALID.
 */
export function computeReturn(entryPrice: number, exitPrice: number): number {
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
    throw new Error(`Invalid entry price: ${entryPrice}`);
  }
  if (!Number.isFinite(exitPrice) || exitPrice <= 0) {
    throw new Error(`Invalid exit price: ${exitPrice}`);
  }
  return exitPrice / entryPrice - 1;
}

/**
 * Slots whose return is within TIE_TOLERANCE_RATIO of the maximum return share the win.
 * Operates on unrounded values, as required by PRD §7.
 */
export function determineWinningSlots(returns: Record<Slot, number>): Slot[] {
  const entries = SLOTS.map((slot) => [slot, returns[slot]] as const);
  const max = Math.max(...entries.map(([, r]) => r));
  return entries.filter(([, r]) => max - r <= TIE_TOLERANCE_RATIO).map(([slot]) => slot);
}
