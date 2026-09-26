import type { PoolClient } from 'pg';
import { getPool, withTransaction } from '../db';
import {
  applyTimeoutIfExpired,
  lockBlind,
  lockFinal,
  type AttemptState,
} from '../domain/attemptStateMachine';
import { playerFacingSql } from '../domain/eligibility';
import type { Slot } from '../domain/returns';
import { timed } from '../timing';
import type { RoundRow } from './rounds';

/**
 * Thin transactional layer around the pure state machine in
 * src/lib/domain/attemptStateMachine.ts. All decision logic (immutability, idempotency,
 * timeout-vs-stick) lives in that pure module; this layer locks the row, feeds the
 * machine the DATABASE clock, and persists the result together with its
 * decision_events in one statement.
 *
 * Nothing here is reachable from a read: a guest's player row and attempt are created
 * only by the first intentional action, the Blind Pick lock.
 */

export interface AttemptRow {
  id: string;
  player_id: string;
  round_id: string;
  stage: string;
  blind_slot: string | null;
  blind_locked_at: Date | null;
  identity_disclosed_at: Date | null;
  final_deadline_at: Date | null;
  final_slot: string | null;
  final_action_type: string | null;
  final_locked_at: Date | null;
  decision_window_seconds: number | null;
  decision_window_version: number | null;
  is_repeat: boolean;
  recognition_slots: string[] | null;
  recognition_skipped: boolean;
  recognition_submitted_at: Date | null;
  created_at: Date;
}

type AttemptRowWithClock = AttemptRow & { db_now: Date };

function splitClock(row: AttemptRowWithClock): { attempt: AttemptRow; dbNow: Date } {
  const { db_now, ...attempt } = row;
  return { attempt, dbNow: db_now };
}

export function rowToState(row: AttemptRow): AttemptState {
  return {
    stage: row.stage as AttemptState['stage'],
    blindSlot: row.blind_slot as Slot | null,
    blindLockedAt: row.blind_locked_at,
    identityDisclosedAt: row.identity_disclosed_at,
    finalDeadlineAt: row.final_deadline_at,
    finalSlot: row.final_slot as Slot | null,
    finalActionType: row.final_action_type as AttemptState['finalActionType'],
    finalLockedAt: row.final_locked_at,
    decisionWindowSeconds: row.decision_window_seconds,
    decisionWindowVersion: row.decision_window_version,
  };
}

/** Rolls the transaction back and reports a rejection without leaving any row behind. */
class Rejected extends Error {
  constructor(public readonly reason: string) {
    super(reason);
  }
}

/**
 * The guest's attempt on a round, the database clock, and whether the round is
 * player-facing right now (read fresh, never from the round cache, so a withdrawal takes
 * effect at once). Read-only; never creates a player or an attempt. A request without a
 * verified guest id has no attempt.
 */
export async function findGuestAttempt(
  guestId: string | null,
  roundId: string,
): Promise<{ attempt: AttemptRow | null; dbNow: Date; roundPlayerFacing: boolean }> {
  const res = await timed('db.attempt', () =>
    getPool().query<AttemptRowWithClock & { round_player_facing: boolean | null }>(
      `SELECT a.*, clock_timestamp() AS db_now,
              (SELECT ${playerFacingSql('r')} FROM rounds r WHERE r.id = $2) AS round_player_facing
       FROM (SELECT 1) AS one
       LEFT JOIN players p ON $1::text IS NOT NULL AND p.anon_id = $1
       LEFT JOIN attempts a ON a.player_id = p.id AND a.round_id = $2`,
      [guestId, roundId],
    ),
  );
  const { round_player_facing, ...row } = res.rows[0]!;
  const { attempt, dbNow } = splitClock(row);
  return { attempt: attempt.id ? attempt : null, dbNow, roundPlayerFacing: round_player_facing === true };
}

interface DecisionEvent {
  type: 'final_lock';
  slot: string | null;
  actionType: string | null;
  metadata: Record<string, unknown>;
}

/** Writes the state and (optionally) its decision event in one round trip. */
async function persistState(
  client: PoolClient,
  attemptId: string,
  state: AttemptState,
  event: DecisionEvent | null,
): Promise<{ attempt: AttemptRow; dbNow: Date }> {
  const res = await client.query<AttemptRowWithClock>(
    `WITH updated AS (
       UPDATE attempts SET
         stage = $2, blind_slot = $3, blind_locked_at = $4,
         identity_disclosed_at = $5, final_deadline_at = $6,
         final_slot = $7, final_action_type = $8, final_locked_at = $9,
         decision_window_seconds = $10, decision_window_version = $11
       WHERE id = $1
       RETURNING *
     ), event AS (
       INSERT INTO decision_events (attempt_id, event_type, slot, action_type, metadata)
       SELECT id, $12::text, $13::text, $14::text, $15::jsonb FROM updated WHERE $12::text IS NOT NULL
     )
     SELECT updated.*, clock_timestamp() AS db_now FROM updated`,
    [
      attemptId,
      state.stage,
      state.blindSlot,
      state.blindLockedAt,
      state.identityDisclosedAt,
      state.finalDeadlineAt,
      state.finalSlot,
      state.finalActionType,
      state.finalLockedAt,
      state.decisionWindowSeconds,
      state.decisionWindowVersion,
      event?.type ?? null,
      event?.slot ?? null,
      event?.actionType ?? null,
      JSON.stringify(event?.metadata ?? {}),
    ],
  );
  const row = res.rows[0];
  if (!row) throw new Error(`Attempt ${attemptId} disappeared during update`);
  return splitClock(row);
}

const TIMEOUT_EVENT_METADATA = { reason: 'decision_window_expired' };

export type BlindLockResult =
  | { outcome: 'locked' | 'idempotent_replay'; attempt: AttemptRow; dbNow: Date }
  | { outcome: 'rejected'; reason: string };

/**
 * The first intentional action. Creates the guest's player row and attempt if needed,
 * then locks the blind choice. The decision deadline is computed from the database
 * clock in the same final write that records the lock — not from when the request
 * started — so slow reads before it cannot eat into the player's window. A rejection
 * rolls everything back: no player or attempt is left behind. A new attempt is created
 * only on a round that is player-facing at that moment (`round_not_available` otherwise);
 * an existing attempt stays replayable after a withdrawal.
 */
export async function lockBlindForGuest(params: { guestId: string; round: RoundRow; slot: Slot }): Promise<BlindLockResult> {
  const { guestId, round, slot } = params;
  try {
    return await withTransaction(async (client) => {
      const ensured = await timed('db.blind.ensure', () =>
        client.query<{ player_id: string | null }>(
          `WITH new_player AS (
             INSERT INTO players (anon_id) VALUES ($1) ON CONFLICT (anon_id) DO NOTHING RETURNING id
           ), player AS (
             SELECT id FROM new_player UNION ALL SELECT id FROM players WHERE anon_id = $1
           ), new_attempt AS (
             INSERT INTO attempts (player_id, round_id, stage, is_repeat)
             SELECT id, $2, 'blind', $3 FROM player
             WHERE EXISTS (SELECT 1 FROM rounds r WHERE r.id = $2 AND ${playerFacingSql('r')})
             LIMIT 1
             ON CONFLICT (player_id, round_id) DO NOTHING
             RETURNING id
           )
           SELECT (SELECT id FROM player LIMIT 1) AS player_id, (SELECT count(*) FROM new_attempt) AS created`,
          [guestId, round.id, Boolean(round.repeat_of)],
        ),
      );
      let playerId = ensured.rows[0]?.player_id ?? null;
      if (!playerId) {
        // A concurrent request created this guest's row after our statement's snapshot.
        const again = await client.query<{ id: string }>('SELECT id FROM players WHERE anon_id = $1', [guestId]);
        playerId = again.rows[0]?.id ?? null;
        if (!playerId) throw new Error('Guest player could not be created');
        await client.query(
          `INSERT INTO attempts (player_id, round_id, stage, is_repeat)
           SELECT $1, $2, 'blind', $3
           WHERE EXISTS (SELECT 1 FROM rounds r WHERE r.id = $2 AND ${playerFacingSql('r')})
           ON CONFLICT (player_id, round_id) DO NOTHING`,
          [playerId, round.id, Boolean(round.repeat_of)],
        );
      }

      const locked = await timed('db.blind.select', () =>
        client.query<AttemptRowWithClock>(
          `SELECT a.*, clock_timestamp() AS db_now FROM attempts a WHERE a.player_id = $1 AND a.round_id = $2 FOR UPDATE`,
          [playerId, round.id],
        ),
      );
      // No attempt: none existed and the round is not player-facing, so none was created.
      if (!locked.rows[0]) throw new Rejected('round_not_available');
      const { attempt, dbNow } = splitClock(locked.rows[0]);

      if (round.mode === 'live' && dbNow.getTime() > (round.entry_close_at ?? round.cutoff).getTime()) {
        throw new Rejected('live_entry_closed');
      }

      const result = lockBlind(
        rowToState(attempt),
        slot,
        dbNow,
        round.decision_window_seconds,
        round.decision_window_version,
      );
      if (result.outcome === 'rejected') throw new Rejected(result.reason);
      if (result.outcome === 'idempotent_replay') return { outcome: 'idempotent_replay', attempt, dbNow };

      const written = await timed('db.blind.lock', () =>
        client.query<AttemptRowWithClock>(
          `WITH t AS (SELECT clock_timestamp() AS now),
           updated AS (
             UPDATE attempts SET
               stage = 'unmasked', blind_slot = $2,
               blind_locked_at = t.now, identity_disclosed_at = t.now,
               final_deadline_at = t.now + ($3::int * interval '1 second'),
               decision_window_seconds = $3::int, decision_window_version = $4::int
             FROM t
             WHERE attempts.id = $1 AND attempts.stage = 'blind'
             RETURNING attempts.*, t.now AS db_now
           ), blind_event AS (
             INSERT INTO decision_events (attempt_id, event_type, slot, decision_window_version)
             SELECT id, 'blind_lock', $2, $4::int FROM updated
           ), disclosure_event AS (
             INSERT INTO decision_events (attempt_id, event_type, decision_window_version, metadata)
             SELECT id, 'identity_disclosure', $4::int,
                    jsonb_build_object('deadline', to_char(final_deadline_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
             FROM updated
           )
           SELECT * FROM updated`,
          [attempt.id, slot, round.decision_window_seconds, round.decision_window_version],
        ),
      );
      const row = written.rows[0];
      if (!row) throw new Error(`Attempt ${attempt.id} changed stage during the blind lock`);
      const lockedNow = splitClock(row);
      return { outcome: 'locked', attempt: lockedNow.attempt, dbNow: lockedNow.dbNow };
    });
  } catch (err) {
    if (err instanceof Rejected) return { outcome: 'rejected', reason: err.reason };
    throw err;
  }
}

export type FinalLockResult =
  | { outcome: 'locked_stick' | 'locked_switch' | 'idempotent_replay'; attempt: AttemptRow; dbNow: Date }
  | { outcome: 'rejected'; reason: string; attempt: AttemptRow | null; dbNow: Date };

/**
 * Locks the final choice for the guest's existing attempt, judged against the database
 * clock. Never creates anything: without a locked blind pick there is nothing to lock.
 */
export async function lockFinalForGuest(params: { guestId: string; round: RoundRow; slot: Slot }): Promise<FinalLockResult> {
  const { guestId, round, slot } = params;
  return withTransaction(async (client) => {
    const res = await timed('db.final.select', () =>
      client.query<AttemptRowWithClock>(
        `SELECT a.*, clock_timestamp() AS db_now
         FROM attempts a JOIN players p ON p.id = a.player_id
         WHERE p.anon_id = $1 AND a.round_id = $2
         FOR UPDATE OF a`,
        [guestId, round.id],
      ),
    );
    const row = res.rows[0];
    if (!row) return { outcome: 'rejected', reason: 'blind choice not yet locked', attempt: null, dbNow: new Date() };
    const { attempt, dbNow } = splitClock(row);
    const current = rowToState(attempt);

    // Live: no prediction is accepted once measurement has begun.
    if (round.mode === 'live' && round.measurement_start_at && dbNow.getTime() >= round.measurement_start_at.getTime()) {
      const next = applyTimeoutIfExpired(current, dbNow);
      if (next === current) return { outcome: 'rejected', reason: 'measurement_started', attempt, dbNow };
      const persisted = await persistState(client, attempt.id, next, {
        type: 'final_lock',
        slot: next.finalSlot,
        actionType: 'timeout',
        metadata: TIMEOUT_EVENT_METADATA,
      });
      return { outcome: 'rejected', reason: 'measurement_started', ...persisted };
    }

    const result = lockFinal(current, slot, dbNow);

    if (result.outcome === 'idempotent_replay') return { outcome: 'idempotent_replay', attempt, dbNow };

    if (result.outcome === 'rejected') {
      // A late request can carry a state change (the timeout it just discovered) — persist it.
      if (result.state === current) return { outcome: 'rejected', reason: result.reason, attempt, dbNow };
      const persisted = await timed('db.final.timeout', () =>
        persistState(client, attempt.id, result.state, {
          type: 'final_lock',
          slot: result.state.finalSlot,
          actionType: 'timeout',
          metadata: TIMEOUT_EVENT_METADATA,
        }),
      );
      return { outcome: 'rejected', reason: result.reason, ...persisted };
    }

    const persisted = await timed('db.final.lock', () =>
      persistState(client, attempt.id, result.state, {
        type: 'final_lock',
        slot,
        actionType: result.state.finalActionType,
        metadata: {},
      }),
    );
    return { outcome: result.outcome, ...persisted };
  });
}

export type SubmitRecognitionOutcome =
  | { outcome: 'stored' | 'idempotent'; attempt: AttemptRow }
  | { outcome: 'conflict'; attempt: AttemptRow }
  | { outcome: 'not_found' }
  | { outcome: 'not_final' };

/** Optional, post-verdict only, at most once per attempt (PRD §5.3). Never creates a player or attempt. */
export async function submitRecognitionForGuest(
  guestId: string,
  roundId: string,
  recognizedSlots: Slot[],
  skipped: boolean,
): Promise<SubmitRecognitionOutcome> {
  return withTransaction(async (client) => {
    const res = await client.query<AttemptRowWithClock>(
      `SELECT a.*, clock_timestamp() AS db_now FROM attempts a JOIN players p ON p.id = a.player_id
       WHERE p.anon_id = $1 AND a.round_id = $2
       FOR UPDATE OF a`,
      [guestId, roundId],
    );
    const row = res.rows[0];
    if (!row) return { outcome: 'not_found' };
    let { attempt } = splitClock(row);
    const { dbNow } = splitClock(row);

    // The verdict the player saw may be a timeout that no write has recorded yet.
    const state = rowToState(attempt);
    const next = applyTimeoutIfExpired(state, dbNow);
    if (next !== state) {
      attempt = (
        await persistState(client, attempt.id, next, {
          type: 'final_lock',
          slot: next.finalSlot,
          actionType: 'timeout',
          metadata: TIMEOUT_EVENT_METADATA,
        })
      ).attempt;
    }
    if (attempt.stage !== 'final_locked') return { outcome: 'not_final' };

    if (attempt.recognition_submitted_at) {
      const storedSkipped = Boolean(attempt.recognition_skipped);
      const reqSkipped = Boolean(skipped);

      if (storedSkipped && reqSkipped) {
        return { outcome: 'idempotent', attempt };
      }
      if (!storedSkipped && !reqSkipped) {
        const storedSlots = (attempt.recognition_slots ?? []).slice().sort();
        const reqSlots = (recognizedSlots ?? []).slice().sort();
        if (
          storedSlots.length === reqSlots.length &&
          storedSlots.every((s, i) => s === reqSlots[i])
        ) {
          return { outcome: 'idempotent', attempt };
        }
      }
      return { outcome: 'conflict', attempt };
    }

    const updated = await client.query<AttemptRow>(
      `UPDATE attempts
       SET recognition_slots = $2, recognition_skipped = $3, recognition_submitted_at = now()
       WHERE id = $1
       RETURNING *`,
      [attempt.id, skipped ? null : recognizedSlots, skipped],
    );
    const saved = updated.rows[0];
    if (!saved) throw new Error('Failed to save recognition');
    return { outcome: 'stored', attempt: saved };
  });
}
