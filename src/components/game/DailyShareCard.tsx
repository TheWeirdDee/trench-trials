'use client';

import { useEffect, useState } from 'react';
import { buildDailyShareText } from '@/lib/domain/dailyShare';
import type { VerdictData } from '@/lib/api/types';

/**
 * Share surface for a completed Daily, derived from the player's real attempt. It never
 * names a token, slot or per-token return, so it cannot spoil the Daily for anyone else.
 */
export function DailyShareCard({ dailyNumber, verdict }: { dailyNumber: number; verdict: VerdictData }) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [challengeUrl, setChallengeUrl] = useState('/daily');
  const [streak, setStreak] = useState(0);

  useEffect(() => {
    setChallengeUrl(`${window.location.origin}/daily`);
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/history', { credentials: 'include' });
        if (!res.ok) return;
        const body = await res.json();
        if (!cancelled && typeof body?.summary?.dailyStreak === 'number') setStreak(body.summary.dailyStreak);
      } catch {
        // The streak line is optional; the rest of the card stands on the verdict alone.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const shareText = buildDailyShareText({
    dailyNumber,
    challengeUrl,
    finalWasWinner: verdict.finalWasWinner,
    action: verdict.finalActionType,
    tickerTaxPp:
      verdict.finalActionType === 'timeout' ? null : verdict.finalActionType === 'switch' ? verdict.tickerTaxPp : 0,
    streak,
  });

  async function share() {
    if (typeof navigator !== 'undefined' && 'share' in navigator) {
      try {
        await navigator.share({ text: shareText });
        return;
      } catch {
        // Cancelled or unsupported — fall back to the clipboard.
      }
    }
    try {
      await navigator.clipboard.writeText(shareText);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
  }

  return (
    <section className="rounded-card bg-raised p-5 sm:p-6" data-testid="daily-share-card" aria-labelledby="daily-share-heading">
      <div className="flex items-center justify-between gap-4">
        <h2 id="daily-share-heading" className="text-[18px] font-extrabold tracking-[-0.02em]">
          Share today’s trial
        </h2>
        <span className="text-[14px] font-semibold text-subtle">Daily #{dailyNumber}</span>
      </div>
      <p className="mt-1 text-[15px] text-secondary">No tokens, slots or returns — nothing that spoils it for anyone else.</p>
      <pre
        className="mt-4 select-all whitespace-pre-wrap rounded-control bg-raised-2 p-4 font-sans text-[15px] leading-relaxed text-cream"
        data-testid="daily-share-text"
      >
        {shareText}
      </pre>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button type="button" onClick={share} data-testid="daily-share-button" className="btn-light min-h-[44px] text-[15px]">
          Share result
        </button>
        {copyState === 'copied' && (
          <p className="text-[15px] font-semibold text-secondary" role="status" data-testid="daily-share-feedback">
            Copied to your clipboard.
          </p>
        )}
        {copyState === 'failed' && (
          <p className="text-[15px] text-secondary" role="alert" data-testid="daily-share-feedback">
            Could not copy automatically — select the text above.
          </p>
        )}
      </div>
    </section>
  );
}
