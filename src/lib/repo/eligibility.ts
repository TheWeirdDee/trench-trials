import type { Pool, PoolClient } from 'pg';
import { ELIGIBILITY_POLICY_VERSION } from '../domain/assetPolicy';
import { ELIGIBILITY_STATUSES, type EligibilityStatus } from '../domain/eligibility';

export interface EligibilityDecision {
  status: EligibilityStatus;
  /** Who decided: a reviewer handle, `live_create_policy`, or `test_fixture`. */
  actor: string;
  note: string;
}

export interface EligibilityChange {
  roundId: string;
  from: string;
  to: EligibilityStatus;
  policyVersion: number;
}

/**
 * Sets a round's eligibility and records the change, in one statement. The decision is
 * stamped with the CURRENT policy version: approving under policy N makes a round
 * player-facing only while N is current. Nothing else on the round is touched.
 */
export async function setRoundEligibility(
  db: Pool | PoolClient,
  roundId: string,
  decision: EligibilityDecision,
): Promise<EligibilityChange> {
  if (!ELIGIBILITY_STATUSES.includes(decision.status)) throw new Error(`Unknown eligibility status ${decision.status}`);
  if (!decision.actor.trim() || !decision.note.trim()) throw new Error('An eligibility decision needs an actor and a note');
  const res = await db.query<{ from_status: string }>(
    `WITH prior AS (
       SELECT id, eligibility_status FROM rounds WHERE id = $1 FOR UPDATE
     ), updated AS (
       UPDATE rounds r SET eligibility_status = $2, eligibility_policy_version = $3,
              eligibility_reviewed_at = now(), eligibility_note = $4
       FROM prior WHERE r.id = prior.id
       RETURNING r.id
     ), event AS (
       INSERT INTO round_eligibility_events (round_id, from_status, to_status, policy_version, note, actor)
       SELECT prior.id, prior.eligibility_status, $2, $3, $4, $5 FROM prior JOIN updated ON updated.id = prior.id
     )
     SELECT prior.eligibility_status AS from_status FROM prior`,
    [roundId, decision.status, ELIGIBILITY_POLICY_VERSION, decision.note, decision.actor],
  );
  const row = res.rows[0];
  if (!row) throw new Error(`Round ${roundId} not found`);
  return { roundId, from: row.from_status, to: decision.status, policyVersion: ELIGIBILITY_POLICY_VERSION };
}
