'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { RoundClient } from '../round/[id]/RoundClient';
import { formatUtc } from '@/components/game/VerificationDetails';

interface LiveInfo {
  roundId: string;
  chain: string;
  status: string;
  livePhase?: string;
  snapshotPublishedAt: string;
  entryCloseAt: string;
  measurementStartAt: string | null;
  measurementEndAt: string;
  invalidReason: string | null;
}

function Horizon() {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[15px]">
      <span className="font-extrabold">Live trial</span>
      <span className="text-subtle" aria-hidden="true">
        ·
      </span>
      <span className="text-secondary">24-Hour Horizon</span>
      <span className="text-subtle" aria-hidden="true">
        ·
      </span>
      <span className="text-secondary">All times UTC</span>
    </div>
  );
}

export default function LivePage() {
  const [live, setLive] = useState<LiveInfo | null | undefined>(undefined);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/live', { credentials: 'include' });
        const body = await res.json();
        if (!cancelled) setLive(body.live ?? null);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (failed) {
    return (
      <div className="page py-16">
        <div className="max-w-2xl rounded-panel bg-raised p-8 sm:p-10" role="alert">
          <h1 className="type-title">Live status could not be loaded.</h1>
          <p className="type-body mt-4">The server could not be reached. Try again in a moment.</p>
        </div>
      </div>
    );
  }

  if (live === undefined) {
    return (
      <div className="page py-16">
        <p className="text-[16px] text-secondary" role="status">
          Checking Live trial status…
        </p>
      </div>
    );
  }

  if (live && live.status !== 'invalid') {
    return <RoundClient roundId={live.roundId} />;
  }

  const voided = live?.status === 'invalid';
  return (
    <div className="page py-16 sm:py-24" data-testid="live-empty-state">
      <div className="max-w-3xl">
        <Horizon />
        <h1 className="type-section mt-6">{voided ? 'Live Trial Paused.' : 'No Live trial is open.'}</h1>
        <p className="type-lead mt-6">
          {voided
            ? 'No Live Trial is open right now. The most recent one was voided: its committed 24-hour outcome window could not be verified from Nansen data, so no winner was manufactured and nothing was scored.'
            : 'No Live Trial is open right now. A Live trial opens only when a fresh Nansen snapshot yields three candidates that qualify. Entry then stays open for five minutes before a 24-hour measurement begins.'}
        </p>
        <div className="mt-10 flex flex-col gap-3 sm:flex-row">
          <Link href="/play" className="btn-primary">
            Play Replay
          </Link>
          <Link href="/docs#live" className="btn-quiet">
            How Live trials work
          </Link>
        </div>
        {voided && live && (
          <details className="mt-10 rounded-card bg-raised p-5 sm:p-6" data-testid="live-audit">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-[16px] font-bold [&::-webkit-details-marker]:hidden">
              Audit record for the voided round
              <span className="text-secondary" aria-hidden="true">
                +
              </span>
            </summary>
            <dl className="mt-4 grid gap-3 text-[15px] sm:grid-cols-[220px_1fr]">
              {[
                ['Round', live.roundId],
                ['Status', 'Invalid — not scored'],
                ['Reason', live.invalidReason ?? 'Outcome window could not be verified'],
                ['Chain', live.chain],
                ['Snapshot published', formatUtc(live.snapshotPublishedAt)],
                ['Entry closed', formatUtc(live.entryCloseAt)],
                ['Measurement start', formatUtc(live.measurementStartAt)],
                ['Measurement end', formatUtc(live.measurementEndAt)],
              ].map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-secondary">{k}</dt>
                  <dd className="mono-value break-all">{v}</dd>
                </div>
              ))}
            </dl>
          </details>
        )}
      </div>
    </div>
  );
}
