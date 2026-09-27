import { toBlindAssetView, toUnmaskedAssetView } from '../allowlist';
import { applyTimeoutIfExpired } from '../domain/attemptStateMachine';
import { coarsePeriod } from '../domain/period';
import { buildVerdict } from '../domain/verdict';
import { deriveLivePhase } from '../domain/live';
import type { Slot } from '../domain/returns';
import type { FinalActionType } from '../domain/scoring';
import type { CommitmentReveal } from './types';
import { rowToState, type AttemptRow } from '../repo/attempts';
import type { LoadedRound } from '../repo/rounds';

function toIsoOrNull(val: unknown): string | null {
  if (!val) return null;
  if (val instanceof Date) return val.toISOString();
  try {
    return new Date(val as string | number).toISOString();
  } catch {
    return null;
  }
}

/**
 * The attempt as it stands at `now`. An Unmask window that has already expired is shown
 * as the timeout it deterministically is (blind choice retained, never an explicit
 * stick) — without a write, so a read never changes the database. The first
 * transition that locks the row persists it.
 */
export function effectiveAttempt(attempt: AttemptRow, now: Date): AttemptRow {
  const state = rowToState(attempt);
  const next = applyTimeoutIfExpired(state, now);
  if (next === state) return attempt;
  return {
    ...attempt,
    stage: next.stage,
    final_slot: next.finalSlot,
    final_action_type: next.finalActionType,
    final_locked_at: next.finalLockedAt,
  };
}

/**
 * The single place that decides what a client is allowed to see for a given attempt
 * stage. Every round-reading API route calls this instead of hand-building a
 * response, so there is exactly one path where the blind/unmask/verdict allowlists
 * (src/lib/allowlist.ts) get applied — no route can accidentally serialize a raw DB
 * row (PRD §15).
 *
 * `attempt` is null until the guest's first intentional action: the round is then
 * shown at the blind stage with no attempt behind it. `serverNow` is the authoritative
 * clock the client counts the decision window against.
 */
export function buildRoundStageResponse(loaded: LoadedRound, storedAttempt: AttemptRow | null, serverNow: Date) {
  const { round, assets } = loaded;
  // Verification details — only once the outcome may be shown (verdict) or the round is void.
  const provenance = {
    commitmentHash: round.initial_commitment_hash,
    sourceReceipts: loaded.receipts,
  };
  const attempt = storedAttempt ? effectiveAttempt(storedAttempt, serverNow) : null;

  // Live schedule fields exist only for Live rounds. A Replay or Daily round's exact cutoff and
  // resolution are released only with the verdict (exactCutoff / resolutionTime below), never
  // during Blind Pick or Unmask.
  const isLiveRound = round.mode === 'live';
  const snapshotPublishedAt = isLiveRound
    ? (toIsoOrNull(round.snapshot_published_at) ?? toIsoOrNull(round.created_at) ?? serverNow.toISOString())
    : null;
  const entryCloseAt = isLiveRound
    ? (toIsoOrNull(round.entry_close_at) ?? toIsoOrNull(round.cutoff) ?? serverNow.toISOString())
    : null;
  const measurementStartAt = isLiveRound ? toIsoOrNull(round.measurement_start_at) : null;
  const measurementEndAt = isLiveRound
    ? (toIsoOrNull(round.measurement_end_at) ?? toIsoOrNull(round.resolution_time) ?? serverNow.toISOString())
    : null;
  const exactCutoff = toIsoOrNull(round.cutoff);
  const resolutionTime = toIsoOrNull(round.resolution_time);

  const livePhase =
    round.mode === 'live'
      ? deriveLivePhase({
          status: round.status,
          entryCloseAt: round.entry_close_at ?? round.cutoff,
          measurementStartAt: round.measurement_start_at ?? round.cutoff,
          measurementEndAt: round.measurement_end_at ?? round.resolution_time,
          now: serverNow,
        })
      : null;

  const base = {
    serverNow: serverNow.toISOString(),
    round: {
      id: round.id,
      mode: round.mode,
      chain: round.chain,
      status: round.status,
      horizonDays: round.horizon_days,
      coarsePeriod: coarsePeriod(round.cutoff),
      decisionWindowSeconds: round.decision_window_seconds,
      decisionWindowVersion: round.decision_window_version,
      snapshotPublishedAt,
      entryCloseAt,
      measurementStartAt,
      measurementEndAt,
      invalidReason: round.invalid_reason ?? null,
      livePhase,
    },
    attempt: {
      id: attempt?.id ?? null,
      stage: attempt?.stage ?? 'blind',
      blindSlot: attempt?.blind_slot ?? null,
      finalSlot: attempt?.final_slot ?? null,
      finalActionType: attempt?.final_action_type ?? null,
      finalDeadlineAt: toIsoOrNull(attempt?.final_deadline_at),
      isRepeat: attempt?.is_repeat ?? false,
      recognitionSlots: attempt?.recognition_slots ?? null,
      recognitionSkipped: attempt?.recognition_skipped ?? false,
      recognitionSubmitted: Boolean(attempt?.recognition_submitted_at),
    },
  };

  if (round.status === 'invalid' || livePhase === 'INVALID') {
    return {
      ...base,
      attempt: {
        ...base.attempt,
        stage: 'invalid',
      },
      assets: assets.map(toUnmaskedAssetView),
      round: {
        ...base.round,
        exactCutoff,
        resolutionTime,
      },
      provenance,
    };
  }

  if (!attempt || attempt.stage === 'blind') {
    return { ...base, assets: assets.map(toBlindAssetView) };
  }

  if (attempt.stage === 'unmasked') {
    return { ...base, assets: assets.map(toUnmaskedAssetView) };
  }

  if (!attempt.blind_slot || !attempt.final_slot || !attempt.final_action_type) {
    throw new Error(`Attempt ${attempt.id} is final_locked but missing required fields`);
  }

  // For Live rounds that are not yet resolved: DO NOT return verdict or price data
  if (round.mode === 'live' && round.status !== 'resolved') {
    return {
      ...base,
      attempt: {
        ...base.attempt,
        stage: 'pending',
      },
      assets: assets.map(toUnmaskedAssetView),
      round: {
        ...base.round,
        exactCutoff,
        resolutionTime,
      },
    };
  }

  const verdict = buildVerdict({
    assets,
    blindSlot: attempt.blind_slot as Slot,
    finalSlot: attempt.final_slot as Slot,
    finalActionType: attempt.final_action_type as FinalActionType,
  });

  // The verdict opens the round's sealed commitments so anyone can recompute them.
  const commitments: CommitmentReveal[] = [];
  if (round.initial_manifest && round.initial_nonce) {
    commitments.push({
      kind: 'initial',
      hash: round.initial_commitment_hash,
      manifest: round.initial_manifest,
      nonce: round.initial_nonce,
    });
  }
  if (round.resolution_manifest && round.resolution_nonce && round.resolution_commitment_hash) {
    commitments.push({
      kind: 'resolution',
      hash: round.resolution_commitment_hash,
      manifest: round.resolution_manifest,
      nonce: round.resolution_nonce,
    });
  }

  return {
    ...base,
    round: {
      ...base.round,
      exactCutoff,
      resolutionTime,
    },
    verdict,
    provenance: { ...provenance, commitments },
  };
}
