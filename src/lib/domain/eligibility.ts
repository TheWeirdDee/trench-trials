import { ELIGIBILITY_POLICY_VERSION } from './assetPolicy';

/**
 * Round eligibility (migration 1790266000000_round_eligibility_status). A round is
 * player-facing — selectable for Replay, assignable and shown as a Daily, enterable as
 * Live — only when it was approved under the CURRENT eligibility policy version. Anything
 * else (pending review, under investigation, withdrawn, or approved under an older
 * policy) fails closed. Withdrawal is a status change only and is reversible.
 */
export const ELIGIBILITY_STATUSES = ['pending_review', 'approved', 'investigate', 'withdrawn'] as const;
export type EligibilityStatus = (typeof ELIGIBILITY_STATUSES)[number];

export interface RoundEligibility {
  eligibility_status?: string | null;
  eligibility_policy_version?: number | null;
}

export function isPlayerFacing(round: RoundEligibility): boolean {
  return round.eligibility_status === 'approved' && round.eligibility_policy_version === ELIGIBILITY_POLICY_VERSION;
}

/** SQL predicate for the same rule; `alias` is the rounds alias in the calling query. */
export function playerFacingSql(alias: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(alias)) throw new Error(`Invalid SQL alias ${alias}`);
  return `(${alias}.eligibility_status = 'approved' AND ${alias}.eligibility_policy_version = ${Number(ELIGIBILITY_POLICY_VERSION)})`;
}
