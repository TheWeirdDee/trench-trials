import type { RoundAssetFull } from '../allowlist';
import { toVerdictAssetView, type VerdictAssetView } from '../allowlist';
import { determineWinningSlots, type Slot } from './returns';
import {
  classifySwitchOutcome,
  pointsForFinalChoice,
  switchImpactPp,
  tickerTaxPp,
  type FinalActionType,
} from './scoring';

export interface VerdictInput {
  assets: RoundAssetFull[];
  blindSlot: Slot;
  finalSlot: Slot;
  finalActionType: FinalActionType;
}

export interface Verdict {
  assets: VerdictAssetView[];
  winningSlots: Slot[];
  blindSlot: Slot;
  finalSlot: Slot;
  finalActionType: FinalActionType;
  blindReturnPct: number;
  finalReturnPct: number;
  /** Present only for an explicit switch — an explicit stick is defined as exactly 0.0pp (PRD §5.3). */
  switchImpactPp: number;
  tickerTaxPp: number;
  switchOutcome: 'helped' | 'hurt' | 'unchanged' | null;
  blindWasWinner: boolean;
  finalWasWinner: boolean;
  pointsAwarded: number;
}

/**
 * Builds the full verdict for one attempt against a resolved round. Pure function —
 * the caller is responsible for only invoking this once the attempt is confirmed
 * final_locked and the round confirmed resolved/ready (that gating lives in the API
 * route, not here, so this function can be unit-tested without touching the DB or
 * request/response plumbing).
 */
export function buildVerdict(input: VerdictInput): Verdict {
  const returnsBySlot: Record<Slot, number> = {} as Record<Slot, number>;
  for (const asset of input.assets) {
    if (asset.returnRatio === null || asset.returnRatio === undefined) {
      throw new Error(`Verdict requires returnRatio to be resolved for slot ${asset.slot}`);
    }
    returnsBySlot[asset.slot] = asset.returnRatio;
  }

  const blindAsset = input.assets.find((a) => a.slot === input.blindSlot);
  const finalAsset = input.assets.find((a) => a.slot === input.finalSlot);
  if (!blindAsset || !finalAsset) {
    throw new Error('Verdict requires both the blind-slot and final-slot assets to be present');
  }

  const blindReturn = blindAsset.returnRatio ?? 0;
  const finalReturn = finalAsset.returnRatio ?? 0;

  const winningSlots = determineWinningSlots(returnsBySlot);
  const impact = switchImpactPp(blindReturn, finalReturn);
  const tax = tickerTaxPp(blindReturn, finalReturn);

  // Per PRD §5.3: an explicit stick is always exactly 0.0pp, regardless of outcome.
  // A timeout also retains the blind choice, so it is likewise definitionally 0.0pp —
  // and must not be classified helped/hurt/unchanged since it was never an explicit
  // decision either way.
  const isExplicitSwitch = input.finalActionType === 'switch';

  return {
    assets: input.assets.map(toVerdictAssetView),
    winningSlots,
    blindSlot: input.blindSlot,
    finalSlot: input.finalSlot,
    finalActionType: input.finalActionType,
    blindReturnPct: blindReturn * 100,
    finalReturnPct: finalReturn * 100,
    switchImpactPp: input.finalActionType === 'switch' ? impact : 0,
    tickerTaxPp: input.finalActionType === 'switch' ? tax : 0,
    switchOutcome: isExplicitSwitch ? classifySwitchOutcome(impact) : null,
    blindWasWinner: winningSlots.includes(input.blindSlot),
    finalWasWinner: winningSlots.includes(input.finalSlot),
    pointsAwarded: pointsForFinalChoice(input.finalSlot, returnsBySlot),
  };
}
