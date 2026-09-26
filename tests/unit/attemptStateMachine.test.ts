import { describe, expect, it } from 'vitest';
import {
  applyTimeoutIfExpired,
  INITIAL_ATTEMPT_STATE,
  lockBlind,
  lockFinal,
  type AttemptState,
} from '@/lib/domain/attemptStateMachine';

const T0 = new Date('2026-09-24T00:00:00Z');
const WINDOW_S = 15;

describe('lockBlind', () => {
  it('locks the blind choice and atomically authorizes disclosure with a server-computed deadline', () => {
    const result = lockBlind(INITIAL_ATTEMPT_STATE, 'A', T0, WINDOW_S, 1);
    expect(result.outcome).toBe('locked');
    expect(result.state.stage).toBe('unmasked');
    expect(result.state.blindSlot).toBe('A');
    expect(result.state.identityDisclosedAt).toEqual(T0);
    expect(result.state.finalDeadlineAt).toEqual(new Date(T0.getTime() + 15000));
  });

  it('is idempotent when the same slot is resubmitted (duplicate request / second tab)', () => {
    const first = lockBlind(INITIAL_ATTEMPT_STATE, 'B', T0, WINDOW_S, 1);
    const second = lockBlind(first.state, 'B', new Date(T0.getTime() + 1000), WINDOW_S, 1);
    expect(second.outcome).toBe('idempotent_replay');
    // The deadline from the FIRST lock is preserved, not recomputed from the second call's time.
    expect(second.state.finalDeadlineAt).toEqual(first.state.finalDeadlineAt);
  });

  it('rejects an attempt to change the blind choice after it is locked', () => {
    const first = lockBlind(INITIAL_ATTEMPT_STATE, 'A', T0, WINDOW_S, 1);
    const second = lockBlind(first.state, 'C', new Date(T0.getTime() + 1000), WINDOW_S, 1);
    expect(second.outcome).toBe('rejected');
    expect(second.state.blindSlot).toBe('A'); // unchanged
  });

  it('refresh/reopen cannot reset the deadline: repeated calls with later "now" do not move it', () => {
    const first = lockBlind(INITIAL_ATTEMPT_STATE, 'A', T0, WINDOW_S, 1);
    const muchLater = new Date(T0.getTime() + 10 * 60 * 1000);
    const replay = lockBlind(first.state, 'A', muchLater, WINDOW_S, 1);
    expect(replay.state.finalDeadlineAt).toEqual(first.state.finalDeadlineAt);
  });
});

describe('applyTimeoutIfExpired', () => {
  const unmasked = lockBlind(INITIAL_ATTEMPT_STATE, 'A', T0, WINDOW_S, 1).state;

  it('does nothing before the deadline', () => {
    const before = new Date(T0.getTime() + 14_000);
    expect(applyTimeoutIfExpired(unmasked, before)).toEqual(unmasked);
  });

  it('transitions to final_locked with reason timeout exactly at/after the deadline, retaining the blind slot', () => {
    const at = new Date(T0.getTime() + 15_000);
    const result = applyTimeoutIfExpired(unmasked, at);
    expect(result.stage).toBe('final_locked');
    expect(result.finalSlot).toBe('A');
    expect(result.finalActionType).toBe('timeout');
  });

  it('never labels a timeout as an explicit stick', () => {
    const result = applyTimeoutIfExpired(unmasked, new Date(T0.getTime() + 60_000));
    expect(result.finalActionType).not.toBe('stick');
    expect(result.finalActionType).toBe('timeout');
  });

  it('is a no-op on an already-blind (not yet unmasked) attempt', () => {
    expect(applyTimeoutIfExpired(INITIAL_ATTEMPT_STATE, new Date(T0.getTime() + 999_999))).toEqual(
      INITIAL_ATTEMPT_STATE,
    );
  });

  it('uses the stored deadline (not "now") as the lock timestamp, so repeated calls are deterministic', () => {
    const r1 = applyTimeoutIfExpired(unmasked, new Date(T0.getTime() + 20_000));
    const r2 = applyTimeoutIfExpired(unmasked, new Date(T0.getTime() + 999_999));
    expect(r1.finalLockedAt).toEqual(r2.finalLockedAt);
    expect(r1.finalLockedAt).toEqual(unmasked.finalDeadlineAt);
  });
});

describe('lockFinal', () => {
  const unmasked = lockBlind(INITIAL_ATTEMPT_STATE, 'A', T0, WINDOW_S, 1).state;

  it('rejects a final choice before the blind choice is locked', () => {
    const result = lockFinal(INITIAL_ATTEMPT_STATE, 'A', T0);
    expect(result.outcome).toBe('rejected');
  });

  it('records an explicit stick when the final slot matches the blind slot', () => {
    const result = lockFinal(unmasked, 'A', new Date(T0.getTime() + 5000));
    expect(result.outcome).toBe('locked_stick');
    if (result.outcome === 'locked_stick') {
      expect(result.state.finalActionType).toBe('stick');
      expect(result.state.finalSlot).toBe('A');
    }
  });

  it('records an explicit switch when the final slot differs from the blind slot', () => {
    const result = lockFinal(unmasked, 'B', new Date(T0.getTime() + 5000));
    expect(result.outcome).toBe('locked_switch');
    if (result.outcome === 'locked_switch') {
      expect(result.state.finalActionType).toBe('switch');
      expect(result.state.finalSlot).toBe('B');
    }
  });

  it('rejects a final choice submitted after the deadline and records it as a timeout instead', () => {
    const tooLate = new Date(T0.getTime() + 16_000);
    const result = lockFinal(unmasked, 'B', tooLate);
    expect(result.outcome).toBe('rejected');
    if (result.outcome === 'rejected') {
      expect(result.reason).toMatch(/expired/i);
      // The underlying attempt is still correctly finalized as a timeout, retaining blind slot A —
      // the late click for B must NOT have been recorded.
      expect(result.state.stage).toBe('final_locked');
      expect(result.state.finalActionType).toBe('timeout');
      expect(result.state.finalSlot).toBe('A');
    }
  });

  it('is idempotent when the same final choice is resubmitted (duplicate request / second tab)', () => {
    const locked = lockFinal(unmasked, 'A', new Date(T0.getTime() + 5000));
    const replay = lockFinal(locked.state, 'A', new Date(T0.getTime() + 6000));
    expect(replay.outcome).toBe('idempotent_replay');
  });

  it('cannot be changed by a second, different request after it is locked (immutability)', () => {
    const locked = lockFinal(unmasked, 'A', new Date(T0.getTime() + 5000));
    const attempted = lockFinal(locked.state, 'B', new Date(T0.getTime() + 6000));
    expect(attempted.outcome).toBe('idempotent_replay');
    expect(attempted.state.finalSlot).toBe('A'); // unchanged despite requesting B
  });

  it('replaying a request against an already-timed-out attempt just returns the timeout result, not an error', () => {
    const timedOut = lockFinal(unmasked, 'B', new Date(T0.getTime() + 16_000)); // times out
    const replay = lockFinal(timedOut.state, 'B', new Date(T0.getTime() + 20_000));
    expect(replay.outcome).toBe('idempotent_replay');
    expect(replay.state.finalActionType).toBe('timeout');
  });

  it('simultaneous requests (same input state, same instant) converge on the same outcome', () => {
    const now = new Date(T0.getTime() + 5000);
    const r1 = lockFinal(unmasked, 'C', now);
    const r2 = lockFinal(unmasked, 'C', now);
    expect(r1.outcome).toBe(r2.outcome);
    expect((r1.state as AttemptState).finalSlot).toBe((r2.state as AttemptState).finalSlot);
  });
});
