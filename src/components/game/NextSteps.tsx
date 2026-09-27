'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

interface NextResponse {
  available: boolean;
  reason?: 'all_played' | 'daily_only' | 'none_approved';
  progress?: { daily: { available: boolean; completed: boolean } };
}

/**
 * What to do after a verdict, based on what is genuinely playable for this guest:
 * "Play another round" only when an unplayed Replay round exists; otherwise today's Daily
 * (if not yet played), History and the evidence. A Daily verdict never offers "another round".
 */
export function NextSteps({ context }: { context: 'replay' | 'daily' | 'live' }) {
  const [next, setNext] = useState<NextResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/rounds/next', { credentials: 'include' })
      .then((res) => (res.ok ? res.json() : null))
      .then((body: NextResponse | null) => !cancelled && setNext(body))
      .catch(() => !cancelled && setNext(null));
    return () => {
      cancelled = true;
    };
  }, []);

  const history = (primary: boolean) => (
    <Link href="/history" className={primary ? 'btn-primary' : 'btn-quiet'} data-testid="view-history-button">
      View History
    </Link>
  );
  const evidence = (
    <Link href="/evidence" className="btn-quiet" data-testid="see-evidence-button">
      See the evidence
    </Link>
  );

  let actions: React.ReactNode;
  if (context === 'daily' || !next) {
    actions = (
      <>
        {history(true)}
        {evidence}
      </>
    );
  } else if (next.available) {
    actions = (
      <>
        <Link href="/play" className="btn-primary" data-testid="play-again-button">
          Play another round
        </Link>
        {history(false)}
      </>
    );
  } else if (next.progress?.daily.available && !next.progress.daily.completed) {
    actions = (
      <>
        <Link href="/daily" className="btn-primary" data-testid="play-daily-button">
          Play today’s Daily
        </Link>
        {history(false)}
        {evidence}
      </>
    );
  } else {
    actions = (
      <>
        {history(true)}
        {evidence}
      </>
    );
  }

  return (
    <div className="flex flex-col gap-3 sm:flex-row" data-testid="next-steps">
      {actions}
    </div>
  );
}
