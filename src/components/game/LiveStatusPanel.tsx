import type { AttemptMeta, Provenance, RoundMeta } from '@/lib/api/types';
import { VerificationDetails, formatUtc } from './VerificationDetails';

const COPY: Record<string, { title: string; body: string }> = {
  ENTRY_OPEN: {
    title: 'Prediction locked — the window has not started',
    body: 'Your call is recorded. Entry closes for everyone shortly, then a 24-hour measurement begins from a fixed 5-minute candle.',
  },
  FINAL_LOCK_WINDOW: {
    title: 'Prediction locked — measurement starts at the next boundary',
    body: 'Entry has closed. Measurement begins at the committed 5-minute candle boundary.',
  },
  MEASURING: {
    title: 'Measuring the next 24 hours',
    body: 'The market is deciding. The outcome resolves from real Nansen candle data after the committed 24-hour window.',
  },
  RESOLVING: {
    title: 'Window closed — resolving from Nansen data',
    body: 'The 24-hour measurement has ended. The round resolves once the committed candles are available from Nansen.',
  },
  INVALID: {
    title: 'Live Trial Paused',
    body: 'This round was invalidated because its committed outcome window could not be verified. No winner was manufactured and no result will be scored.',
  },
};

/** A Live round the player has a locked prediction on, but no verdict yet — or a void one. */
export function LiveStatusPanel({
  round,
  attempt,
  provenance,
  onRefresh,
}: {
  round: RoundMeta;
  attempt: AttemptMeta;
  provenance?: Provenance;
  onRefresh: () => void;
}) {
  const invalid = round.status === 'invalid' || round.livePhase === 'INVALID';
  const phase = invalid ? 'INVALID' : (round.livePhase ?? 'MEASURING');
  const copy =
    invalid && round.invalidReason === 'quality_ineligible_assets'
      ? {
          title: COPY.INVALID!.title,
          body: 'This round was withdrawn before resolution: an eligibility review found candidates that were not fair comparisons. It was never resolved, no winner was manufactured and no result will be scored.',
        }
      : (COPY[phase] ?? COPY.MEASURING!);

  return (
    <div className="grid gap-6">
      <section
        className={`rounded-panel p-6 sm:p-10 ${invalid ? 'bg-raised' : 'bg-burgundy-surface'}`}
        data-testid="live-pending-banner"
      >
        <p className="eyebrow">{invalid ? 'Live round · void' : 'Live round'}</p>
        <h1 className="type-title mt-3" data-testid="live-pending-title">
          {copy.title}
        </h1>
        <p className="mt-4 max-w-2xl text-[17px] leading-relaxed text-secondary" data-testid="live-pending-body">
          {copy.body}
        </p>
        {attempt.finalSlot && (
          <p className="mt-6 inline-flex flex-wrap items-center gap-2 rounded-control bg-canvas/50 px-4 py-3 text-[16px]">
            <span className="text-secondary">Your locked prediction:</span>{' '}
            <strong>Slot {attempt.finalSlot}</strong>{' '}
            <span className="text-secondary">
              ({attempt.finalActionType === 'switch' ? `switched from Slot ${attempt.blindSlot}` : attempt.finalActionType === 'timeout' ? 'blind pick retained' : 'kept'})
            </span>
          </p>
        )}
        {phase === 'RESOLVING' && (
          <div className="mt-6">
            <button type="button" onClick={onRefresh} className="btn-quiet" data-testid="live-refresh-button">
              Check resolution status
            </button>
          </div>
        )}
      </section>

      <VerificationDetails
        summary={invalid ? 'Why this round was invalidated' : 'Verification details'}
        provenance={provenance}
        rows={[
          ['Round', round.id],
          ['Chain', round.chain],
          ['Snapshot published', formatUtc(round.snapshotPublishedAt)],
          ['Entry closed', formatUtc(round.entryCloseAt)],
          ['Measurement start', formatUtc(round.measurementStartAt)],
          ['Measurement end', formatUtc(round.measurementEndAt)],
          ...(invalid ? ([['Invalidation reason', round.invalidReason ?? 'unverifiable outcome window']] as Array<[string, string]>) : []),
        ]}
      />
    </div>
  );
}
