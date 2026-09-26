import type { FinalActionType } from './scoring';
import type { Slot } from './returns';

export type AttemptStage = 'blind' | 'unmasked' | 'final_locked';

export interface AttemptState {
  stage: AttemptStage;
  blindSlot: Slot | null;
  blindLockedAt: Date | null;
  identityDisclosedAt: Date | null;
  finalDeadlineAt: Date | null;
  finalSlot: Slot | null;
  finalActionType: FinalActionType | null;
  finalLockedAt: Date | null;
  decisionWindowSeconds: number | null;
  decisionWindowVersion: number | null;
}

export const INITIAL_ATTEMPT_STATE: AttemptState = {
  stage: 'blind',
  blindSlot: null,
  blindLockedAt: null,
  identityDisclosedAt: null,
  finalDeadlineAt: null,
  finalSlot: null,
  finalActionType: null,
  finalLockedAt: null,
  decisionWindowSeconds: null,
  decisionWindowVersion: null,
};

export type LockBlindOutcome =
  | { outcome: 'locked'; state: AttemptState }
  | { outcome: 'idempotent_replay'; state: AttemptState }
  | { outcome: 'rejected'; reason: string; state: AttemptState };

/**
 * Locking the blind choice and authorizing identity disclosure happen atomically in
 * the same transition (PRD §5.2: "The server starts the deadline atomically when it
 * authorizes identity disclosure") — there is no separate "reveal" step to race.
 * Refresh/reopen cannot reset the deadline because it is computed once, here, from
 * server time, and stored — never recomputed from a client-supplied timestamp.
 */
export function lockBlind(
  current: AttemptState,
  slot: Slot,
  now: Date,
  decisionWindowSeconds: number,
  decisionWindowVersion: number,
): LockBlindOutcome {
  if (current.stage !== 'blind') {
    if (current.blindSlot === slot) {
      return { outcome: 'idempotent_replay', state: current };
    }
    return { outcome: 'rejected', reason: 'blind choice already locked', state: current };
  }

  const identityDisclosedAt = now;
  const finalDeadlineAt = new Date(now.getTime() + decisionWindowSeconds * 1000);

  const state: AttemptState = {
    ...current,
    stage: 'unmasked',
    blindSlot: slot,
    blindLockedAt: now,
    identityDisclosedAt,
    finalDeadlineAt,
    decisionWindowSeconds,
    decisionWindowVersion,
  };
  return { outcome: 'locked', state };
}

/**
 * If the attempt is in 'unmasked' stage and its deadline has passed with no final
 * choice recorded, transitions it to final_locked with the ORIGINAL blind slot and
 * reason 'timeout' — never an explicit stick (PRD §5.2: "retain the blind choice and
 * record timeout, not an explicit stick decision"). Uses the stored deadline as the
 * lock timestamp (not `now`) so repeated calls are deterministic and idempotent.
 */
export function applyTimeoutIfExpired(state: AttemptState, now: Date): AttemptState {
  if (state.stage !== 'unmasked') return state;
  if (!state.finalDeadlineAt || !state.blindSlot) return state;
  if (now.getTime() < state.finalDeadlineAt.getTime()) return state;

  return {
    ...state,
    stage: 'final_locked',
    finalSlot: state.blindSlot,
    finalActionType: 'timeout',
    finalLockedAt: state.finalDeadlineAt,
  };
}

export type LockFinalOutcome =
  | { outcome: 'locked_stick' | 'locked_switch'; state: AttemptState }
  | { outcome: 'idempotent_replay'; state: AttemptState }
  | { outcome: 'rejected'; reason: string; state: AttemptState };

/**
 * Locks the final choice. A request arriving after the deadline never overrides the
 * retained blind choice, even if it names a different slot — the player's click
 * simply didn't count in time. Resubmitting the same already-locked final choice
 * (duplicate request / multiple tabs) is idempotent, not an error.
 */
export function lockFinal(current: AttemptState, requestedSlot: Slot, now: Date): LockFinalOutcome {
  if (current.stage === 'blind') {
    return { outcome: 'rejected', reason: 'blind choice not yet locked', state: current };
  }

  const wasAlreadyFinalLocked = current.stage === 'final_locked';
  const afterTimeout = applyTimeoutIfExpired(current, now);
  const timedOutByThisCall = !wasAlreadyFinalLocked && afterTimeout.stage === 'final_locked';

  if (timedOutByThisCall) {
    return { outcome: 'rejected', reason: 'decision window expired', state: afterTimeout };
  }

  if (afterTimeout.stage === 'final_locked') {
    // Already locked before this call (explicit stick/switch, or an earlier timeout).
    return { outcome: 'idempotent_replay', state: afterTimeout };
  }

  // stage === 'unmasked', not expired: accept the choice.
  const actionType: FinalActionType = requestedSlot === afterTimeout.blindSlot ? 'stick' : 'switch';
  const state: AttemptState = {
    ...afterTimeout,
    stage: 'final_locked',
    finalSlot: requestedSlot,
    finalActionType: actionType,
    finalLockedAt: now,
  };
  return { outcome: actionType === 'stick' ? 'locked_stick' : 'locked_switch', state };
}
