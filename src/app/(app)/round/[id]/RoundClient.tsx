'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { CandidateCard } from '@/components/game/CandidateCard';
import { CountdownTimer } from '@/components/game/CountdownTimer';
import { DailyShareCard } from '@/components/game/DailyShareCard';
import { LiveStatusPanel } from '@/components/game/LiveStatusPanel';
import { RecognitionPrompt } from '@/components/game/RecognitionPrompt';
import { StageProgress } from '@/components/game/StageProgress';
import { VerdictView } from '@/components/game/VerdictView';
import {
  isBlindStage,
  isPendingStage,
  isUnmaskedStage,
  isVerdictStage,
  type ApiErrorResponse,
  type RoundMeta,
  type RoundStageResponse,
  type Slot,
} from '@/lib/api/types';

export interface DailyContext {
  dailyNumber: number;
  utcDate: string;
  resetAtUtc: string;
}

function modeLabel(round: RoundMeta, daily?: DailyContext): string {
  if (daily) return `Daily #${daily.dailyNumber}`;
  if (round.mode === 'live') return 'Live trial';
  return 'Verified trial';
}

function RoundHeader({ round, stage, daily }: { round: RoundMeta; stage: 1 | 2 | 3; daily?: DailyContext }) {
  return (
    <div className="flex flex-col gap-4 pb-8 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[15px]">
        <span className="font-extrabold">{modeLabel(round, daily)}</span>
        <span className="text-subtle" aria-hidden="true">
          ·
        </span>
        <span className="text-secondary">{round.mode === 'live' ? 'Next 24 hours' : round.coarsePeriod}</span>
        <span className="text-subtle" aria-hidden="true">
          ·
        </span>
        <span className="capitalize text-secondary">{round.chain}</span>
        <a href="https://www.nansen.ai/" target="_blank" rel="noopener noreferrer" className="link-quiet text-[14px]">
          Powered by Nansen
        </a>
      </div>
      <StageProgress current={stage} />
    </div>
  );
}

function shortUtc(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const month = d.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' });
  return `${d.toISOString().slice(11, 16)} UTC, ${d.getUTCDate()} ${month}`;
}

/** Live timing, always stated in UTC so no player has to guess a timezone. */
function LiveSchedule({ round }: { round: RoundMeta }) {
  return (
    <dl
      className="mb-8 grid gap-3 rounded-card bg-raised p-4 text-[15px] sm:grid-cols-3 sm:p-5"
      data-testid="live-schedule-header"
    >
      <div>
        <dt className="text-secondary">Entry closes</dt>
        <dd className="mono-value mt-1 text-[15px]">{shortUtc(round.entryCloseAt)}</dd>
      </div>
      <div>
        <dt className="text-secondary">Measurement starts</dt>
        <dd className="mono-value mt-1 text-[15px]">{shortUtc(round.measurementStartAt)}</dd>
      </div>
      <div>
        <dt className="text-secondary">Measurement ends</dt>
        <dd className="mono-value mt-1 text-[15px]">{shortUtc(round.measurementEndAt)}</dd>
      </div>
    </dl>
  );
}

function ActionBar({ children }: { children: React.ReactNode }) {
  return (
    // Sticky at every size, so the one primary action stays on screen even on short viewports (e.g. 1280×720).
    <div className="sticky bottom-0 z-20 -mx-4 mt-8 bg-canvas/92 px-4 pb-4 pt-3 backdrop-blur-md sm:mx-0 sm:px-0">
      <div className="flex flex-col gap-3 rounded-card sm:flex-row sm:items-center sm:justify-between sm:bg-raised sm:p-5">
        {children}
      </div>
    </div>
  );
}

export function RoundClient({ roundId, daily }: { roundId: string; daily?: DailyContext }) {
  const [data, setData] = useState<RoundStageResponse | null>(null);
  // (server time − browser time) from the latest response; the countdown runs on server time.
  const [clockOffsetMs, setClockOffsetMs] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [pendingFinalSlot, setPendingFinalSlot] = useState<Slot | null>(null);
  const [selectedBlindSlot, setSelectedBlindSlot] = useState<Slot | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [justRevealed, setJustRevealed] = useState(false);

  const acceptResponse = useCallback((body: RoundStageResponse) => {
    if (body.serverNow) setClockOffsetMs(Date.parse(body.serverNow) - Date.now());
    setData(body);
  }, []);

  const refetch = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(`/api/rounds/${roundId}`, { credentials: 'include' });
      const body = await res.json();
      if (!res.ok) {
        setError((body as ApiErrorResponse).error ?? 'round_unavailable');
        return;
      }
      acceptResponse(body as RoundStageResponse);
    } catch {
      setError('network');
    } finally {
      setLoading(false);
    }
  }, [roundId, acceptResponse]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  useEffect(() => {
    if (data && isUnmaskedStage(data) && pendingFinalSlot === null) {
      setPendingFinalSlot(data.attempt.blindSlot);
    }
  }, [data, pendingFinalSlot]);

  const lockBlind = useCallback(
    async (slot: Slot) => {
      setSubmitting(true);
      setSubmitError(null);
      try {
        const res = await fetch(`/api/rounds/${roundId}/blind`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ slot }),
        });
        const body = await res.json();
        if (res.ok) {
          setJustRevealed(true);
          acceptResponse(body as RoundStageResponse);
        } else {
          await refetch();
        }
      } catch {
        setSubmitError('Could not reach the server. Your selection is still here — try locking it in again.');
      } finally {
        setSubmitting(false);
      }
    },
    [roundId, refetch, acceptResponse],
  );

  const lockFinal = useCallback(
    async (slot: Slot) => {
      setSubmitting(true);
      setSubmitError(null);
      try {
        const res = await fetch(`/api/rounds/${roundId}/final`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ slot }),
        });
        const body = await res.json();
        if (body && body.attempt) acceptResponse(body as RoundStageResponse);
        else await refetch();
      } catch {
        setSubmitError('Could not reach the server. Your choice is still here — try again.');
      } finally {
        setSubmitting(false);
      }
    },
    [roundId, refetch, acceptResponse],
  );

  const handleExpire = useCallback(() => {
    refetch();
  }, [refetch]);

  if (loading) {
    return (
      <div className="page py-16" role="status">
        <div className="grid gap-4 md:grid-cols-3" aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-72 animate-pulse rounded-card bg-raised" />
          ))}
        </div>
        <p className="mt-6 text-[16px] text-secondary">Loading verified round…</p>
      </div>
    );
  }

  if (error || !data) {
    const entryClosed = error === 'live_entry_closed';
    const notFound = error === 'round_not_found';
    const notAvailable = error === 'round_not_available';
    return (
      <div className="page py-16">
        <div className="max-w-2xl rounded-panel bg-raised p-8 sm:p-10" data-testid="round-error">
          <p className="eyebrow">
            {entryClosed ? 'Entry closed' : notFound ? 'Not found' : notAvailable ? 'Withdrawn' : 'Unavailable'}
          </p>
          <h1 className="type-title mt-3">
            {entryClosed
              ? 'Entry to this Live trial has closed.'
              : notFound
                ? 'This round does not exist.'
                : notAvailable
                  ? 'This round is not available for play.'
                  : 'This round could not be loaded.'}
          </h1>
          <p className="type-body mt-4">
            {entryClosed
              ? 'Predictions are accepted only while entry is open. The round is measured and resolved from real Nansen candle data, and only players who entered before the close are scored.'
              : notFound
                ? 'Check the link, or start a new verified round.'
                : notAvailable
                  ? 'It has been withdrawn or is awaiting an eligibility review, so it cannot be started. Nothing is lost if you had not begun it.'
                  : 'The server could not be reached. Your choices are safe — try again in a moment.'}
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link href="/play" className="btn-primary">
              Play a verified round
            </Link>
            {!entryClosed && !notFound && !notAvailable && (
              <button type="button" onClick={() => refetch()} className="btn-quiet">
                Try again
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  const isLive = data.round.mode === 'live';
  const stage: 1 | 2 | 3 = isBlindStage(data) ? 1 : isUnmaskedStage(data) ? 2 : 3;

  return (
    <div className="page py-8 sm:py-10">
      <RoundHeader round={data.round} stage={stage} daily={daily} />
      {isLive && (isBlindStage(data) || isUnmaskedStage(data)) && <LiveSchedule round={data.round} />}

      {isBlindStage(data) && (
        <section aria-labelledby="blind-heading">
          <h1 id="blind-heading" className="type-title max-w-3xl">
            Choose with the names hidden.
          </h1>
          <p className="type-body mt-3 max-w-2xl">
            Three real tokens, four signals each, all frozen at the historical cutoff. No names, no prices, no future.
            {isLive ? ' Lock your prediction before entry closes.' : ''}
          </p>
          <div className="mt-8 grid gap-5 md:grid-cols-3" role="list" aria-label="Anonymous candidates">
            {data.assets.map((asset) => (
              <div role="listitem" key={asset.slot}>
                <CandidateCard
                  slot={asset.slot}
                  clues={asset.clues}
                  selected={selectedBlindSlot === asset.slot}
                  disabled={submitting}
                  onSelect={() => setSelectedBlindSlot(asset.slot)}
                />
              </div>
            ))}
          </div>
          <ActionBar>
            <p className="hidden text-[15px] text-secondary sm:block">
              {selectedBlindSlot ? (
                <>
                  Locking <strong className="text-cream">Slot {selectedBlindSlot}</strong> reveals all three names and
                  starts a {data.round.decisionWindowSeconds}-second decision window.
                </>
              ) : (
                'Select the candidate you think returned the most.'
              )}
            </p>
            <button
              type="button"
              disabled={!selectedBlindSlot || submitting}
              onClick={() => selectedBlindSlot && lockBlind(selectedBlindSlot)}
              data-testid="lock-blind-button"
              className="btn-primary shrink-0"
            >
              {submitting ? 'Locking…' : selectedBlindSlot ? `Lock ${selectedBlindSlot} as my blind pick` : 'Choose a slot to continue'}
            </button>
          </ActionBar>
          {submitError && (
            <p className="mt-3 text-[15px] font-semibold text-loss" role="alert" data-testid="submit-error">
              {submitError}
            </p>
          )}
        </section>
      )}

      {isUnmaskedStage(data) && (
        <section aria-labelledby="unmask-heading">
          <div className="flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h1 id="unmask-heading" className="type-title max-w-3xl">
                Names revealed. Future still sealed.
              </h1>
              <p className="type-body mt-3 max-w-2xl">
                Now you know the names. The future outcome is still hidden. Keep your blind pick or switch before the
                window closes.
              </p>
            </div>
            {data.attempt.finalDeadlineAt && (
              <CountdownTimer
                deadlineIso={data.attempt.finalDeadlineAt}
                totalSeconds={data.round.decisionWindowSeconds}
                onExpire={handleExpire}
                clockOffsetMs={clockOffsetMs}
              />
            )}
          </div>
          <div className="mt-8 grid gap-5 md:grid-cols-3" role="list" aria-label="Revealed candidates">
            {data.assets.map((asset) => (
              <div role="listitem" key={asset.slot}>
                <CandidateCard
                  slot={asset.slot}
                  clues={asset.clues}
                  tokenSymbol={asset.tokenSymbol}
                  revealed={justRevealed}
                  isBlindSlot={asset.slot === data.attempt.blindSlot}
                  selected={pendingFinalSlot === asset.slot}
                  disabled={submitting}
                  onSelect={() => setPendingFinalSlot(asset.slot)}
                />
              </div>
            ))}
          </div>
          <ActionBar>
            <p className="hidden text-[15px] text-secondary sm:block">
              {pendingFinalSlot === data.attempt.blindSlot ? (
                <>
                  Keeping <strong className="text-cream">Slot {data.attempt.blindSlot}</strong>. Tap another card to switch.
                </>
              ) : (
                <>
                  Switching from <strong className="text-cream">Slot {data.attempt.blindSlot}</strong> to{' '}
                  <strong className="text-cream">Slot {pendingFinalSlot}</strong>.
                </>
              )}
            </p>
            <button
              type="button"
              disabled={!pendingFinalSlot || submitting}
              onClick={() => pendingFinalSlot && lockFinal(pendingFinalSlot)}
              data-testid="lock-final-button"
              className="btn-primary shrink-0"
            >
              {submitting
                ? 'Locking…'
                : pendingFinalSlot === data.attempt.blindSlot
                  ? `Keep Slot ${data.attempt.blindSlot}`
                  : `Switch to Slot ${pendingFinalSlot}`}
            </button>
          </ActionBar>
          {submitError && (
            <p className="mt-3 text-[15px] font-semibold text-loss" role="alert" data-testid="submit-error">
              {submitError}
            </p>
          )}
        </section>
      )}

      {isPendingStage(data) && (
        <div className="grid gap-8">
          <LiveStatusPanel round={data.round} attempt={data.attempt} provenance={data.provenance} onRefresh={refetch} />
          <div className="grid gap-5 md:grid-cols-3" role="list" aria-label="Candidates">
            {data.assets.map((asset) => (
              <div role="listitem" key={asset.slot}>
                <CandidateCard
                  slot={asset.slot}
                  clues={asset.clues}
                  tokenSymbol={asset.tokenSymbol}
                  isBlindSlot={asset.slot === data.attempt.blindSlot}
                  isFinalSlot={asset.slot === data.attempt.finalSlot}
                  decided={Boolean(data.attempt.finalSlot)}
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {isVerdictStage(data) && (
        <VerdictView verdict={data.verdict} round={data.round} provenance={data.provenance} isLive={isLive}>
          <div className="grid gap-5 md:grid-cols-3" role="list" aria-label="Verdict — real returns">
            {data.verdict.assets.map((asset) => (
              <div role="listitem" key={asset.slot}>
                <CandidateCard
                  slot={asset.slot}
                  clues={asset.clues}
                  tokenSymbol={asset.tokenSymbol}
                  returnPct={asset.returnPct}
                  isWinner={data.verdict.winningSlots.includes(asset.slot)}
                  isBlindSlot={asset.slot === data.verdict.blindSlot}
                  isFinalSlot={asset.slot === data.verdict.finalSlot}
                  decided
                />
              </div>
            ))}
          </div>
          {daily && (
            <DailyShareCard dailyNumber={daily.dailyNumber} verdict={data.verdict} />
          )}
          <RecognitionPrompt roundId={data.round.id} attempt={data.attempt} />
        </VerdictView>
      )}
    </div>
  );
}
