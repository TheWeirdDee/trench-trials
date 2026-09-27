'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { GuestHistory, HistoryEntry } from '@/lib/domain/history';

type HistoryResponse = GuestHistory & { retention: 'guest_browser'; hasGuestSession: boolean };

function pct(ratio: number | null): string {
  return ratio === null ? '—' : `${Math.round(ratio * 100)}%`;
}
function signedPct(n: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}
function signedPp(n: number | null): string {
  return n === null ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(1)} pp`;
}

function Metric({ label, value, note, testId }: { label: string; value: string; note?: string; testId: string }) {
  return (
    <div className="rounded-card bg-raised p-5" data-testid={testId}>
      <dt className="text-[15px] font-semibold text-secondary">{label}</dt>
      <dd className="mt-2 text-[32px] font-extrabold leading-none tracking-[-0.03em]" data-testid={`${testId}-value`}>
        {value}
      </dd>
      {note && <dd className="mt-2 text-[14px] text-subtle">{note}</dd>}
    </div>
  );
}

const STATUS_LABEL: Record<HistoryEntry['status'], string> = {
  completed: 'Completed',
  repeat: 'Repeat · not counted',
  pending: 'Awaiting outcome',
  void: 'Void · not scored',
  withdrawn: 'Withdrawn · not scored',
};

function decisionLabel(e: HistoryEntry): string {
  if (e.finalActionType === 'timeout') return `Timed out · kept Slot ${e.blindSlot}`;
  if (e.finalActionType === 'stick') return `Kept Slot ${e.blindSlot}`;
  return `Switched ${e.blindSlot} → ${e.finalSlot}`;
}

function EntryRow({ entry }: { entry: HistoryEntry }) {
  const modeName = entry.mode === 'live' ? 'Live' : entry.mode === 'daily' ? 'Daily' : 'Replay';
  return (
    <li className="rounded-card bg-raised p-5 sm:p-6" data-testid="history-entry">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-[14px]">
        <span className="font-bold text-cream">{modeName}</span>
        <span className="text-subtle" aria-hidden="true">
          ·
        </span>
        <span className="text-secondary">{entry.dailyDate ? `${entry.dailyDate} UTC` : entry.period}</span>
        <span className="rounded-full bg-raised-2 px-3 py-1 font-semibold text-secondary sm:ml-auto">
          {STATUS_LABEL[entry.status]}
        </span>
      </div>
      <div className="mt-4 grid gap-4 sm:grid-cols-[1.3fr_1fr_1fr] sm:items-end">
        <div>
          <p className="text-[20px] font-extrabold tracking-[-0.02em]">{decisionLabel(entry)}</p>
          <p className="mt-1 text-[15px] text-secondary">
            Blind: {entry.blindSymbol ?? `Slot ${entry.blindSlot}`}
            {entry.finalSlot !== entry.blindSlot && <> · Final: {entry.finalSymbol ?? `Slot ${entry.finalSlot}`}</>}
          </p>
        </div>
        {entry.outcome ? (
          <>
            <p className="text-[15px] text-secondary">
              Final return{' '}
              <span
                className={`mono-value block text-[18px] ${entry.outcome.finalReturnPct >= 0 ? 'text-gain' : 'text-loss'}`}
              >
                {signedPct(entry.outcome.finalReturnPct)}
              </span>
              <span className="block text-[14px]" data-testid="history-entry-switch-impact">
                {entry.finalActionType === 'switch'
                  ? `Switch impact ${signedPp(entry.outcome.switchImpactPp)}`
                  : 'No switch · 0.0 pp'}
              </span>
            </p>
            <p className="text-[15px] text-secondary">
              {entry.outcome.finalWasWinner ? 'Winning pick' : `Winner: ${entry.outcome.winnerSymbols.join(', ')}`}{' '}
              <span className="block text-[18px] font-bold text-cream">{entry.outcome.pointsAwarded} points</span>
            </p>
          </>
        ) : (
          <p className="text-[15px] text-secondary sm:col-span-2">
            {entry.status === 'void'
              ? 'The round was invalidated before its outcome could be confirmed. Nothing was scored.'
              : entry.status === 'withdrawn'
                ? 'This round was withdrawn from play. Nothing from it is scored.'
                : 'The outcome is not available yet.'}
          </p>
        )}
      </div>
      <p className="mt-4 text-[14px]">
        <Link href={`/round/${entry.roundId}`} className="link-quiet">
          Open this trial
        </Link>
      </p>
    </li>
  );
}

export default function HistoryPage() {
  const [data, setData] = useState<HistoryResponse | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/history', { credentials: 'include' });
        if (!res.ok) throw new Error('history_unavailable');
        const body: HistoryResponse = await res.json();
        if (!cancelled) setData(body);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const summary = data?.summary;
  const tax = summary?.tickerTax;

  return (
    <div className="page py-12 sm:py-16">
      <p className="eyebrow" data-testid="history-retention">
        Guest history · Saved on this browser
      </p>
      <h1 className="type-section mt-4 max-w-4xl">Your decisions, before and after the reveal.</h1>
      <p className="type-body mt-5 max-w-2xl" data-testid="history-retention-note">
        Your trial history is saved to this browser. Clearing site data or using another device starts a new
        anonymous profile.
      </p>

      {failed && (
        <p className="type-body mt-8" role="alert">
          Your History could not be loaded. Try again in a moment.
        </p>
      )}

      {!data && !failed && (
        <p className="type-body mt-8" role="status">
          Loading your History…
        </p>
      )}

      {data && data.entries.length === 0 && (
        <div className="mt-10 max-w-2xl rounded-panel bg-raised p-8 sm:p-10" data-testid="history-empty-state">
          <p className="type-lead">You have not completed a trial yet. Your first verdict will appear here.</p>
          <Link href="/play" className="btn-primary mt-8">
            Play your first trial
          </Link>
        </div>
      )}

      {data && summary && tax && data.entries.length > 0 && (
        <div className="mt-10 grid gap-12" data-testid="history-content">
          <section aria-labelledby="metrics-heading">
            <h2 id="metrics-heading" className="sr-only">
              Your metrics
            </h2>
            <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Metric
                testId="stat-completed"
                label="Completed trials"
                value={String(summary.eligibleCount)}
                note="First plays only"
              />
              <Metric
                testId="stat-blind-accuracy"
                label="Blind accuracy"
                value={pct(summary.blindAccuracy)}
                note="Before the names"
              />
              <Metric
                testId="stat-final-accuracy"
                label="Final accuracy"
                value={pct(summary.finalAccuracy)}
                note="After the reveal"
              />
              <Metric
                testId="stat-switches"
                label="Switches helped / hurt"
                value={`${summary.switchesHelped} / ${summary.switchesHurt}`}
                note={`${summary.switches} switched · ${summary.explicitSticks} kept · ${summary.timeouts} timed out`}
              />
              <Metric
                testId="stat-switch-impact"
                label="Average switch impact"
                value={signedPp(summary.averageSwitchImpactPp)}
                note="Final return − blind return, switches only"
              />
              <div className="col-span-2 rounded-card bg-burgundy-surface p-5 lg:col-span-3" data-testid="ticker-tax">
                <dt className="text-[15px] font-semibold text-cream/80">Ticker Tax</dt>
                <dd
                  className="mt-2 text-[32px] font-extrabold leading-none tracking-[-0.03em]"
                  data-testid="ticker-tax-status"
                >
                  {tax.status === 'measured' ? signedPp(tax.averagePp) : 'Insufficient evidence'}
                </dd>
                <dd className="mt-2 text-[14px] text-cream/75" data-testid="ticker-tax-evidence">
                  {tax.status === 'measured'
                    ? `Measured from ${tax.evidenceCount} explicit decisions.`
                    : `${tax.evidenceCount} of ${tax.threshold} explicit decisions so far. Timeouts do not count.`}
                </dd>
              </div>
            </dl>
            <p className="mt-4 max-w-3xl text-[15px] text-subtle">
              Ticker Tax is the average of blind return minus final return across your explicit decisions. Positive
              means seeing the names cost you. Repeats of a round you already played are listed but not counted.
            </p>
            {summary.live.totalAttempts > 0 && (
              <p className="mt-2 text-[15px] text-secondary" data-testid="history-live-counts">
                Live: {summary.live.resolvedCount} resolved · {summary.live.pendingCount} pending ·{' '}
                {summary.live.invalidCount} void. Live predictions are kept separate from these metrics.
              </p>
            )}
          </section>

          <section aria-labelledby="attempts-heading">
            <h2 id="attempts-heading" className="type-title">
              Every decision
            </h2>
            <ol className="mt-6 grid gap-3" data-testid="history-list">
              {data.entries.map((entry) => (
                <EntryRow key={`${entry.roundId}-${entry.decidedAt}`} entry={entry} />
              ))}
            </ol>
          </section>
        </div>
      )}
    </div>
  );
}
