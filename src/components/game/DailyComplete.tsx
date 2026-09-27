'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

function untilLabel(targetIso: string, now: number): string {
  const ms = Math.max(0, Date.parse(targetIso) - now);
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

/** Shown above a finished Daily: the day's one attempt is done, and when the next one arrives. */
export function DailyComplete({ resetAtUtc, nextScheduled }: { resetAtUtc: string; nextScheduled: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  return (
    <section
      className="mb-8 flex flex-col gap-4 rounded-card bg-raised p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6"
      data-testid="daily-complete"
      aria-label="Today’s Daily"
    >
      <div>
        <p className="text-[18px] font-extrabold tracking-[-0.02em]">Today’s Daily is complete.</p>
        <p className="mt-1 text-[15px] text-secondary" data-testid="next-daily">
          {nextScheduled
            ? `The next Daily opens in ${untilLabel(resetAtUtc, now)} (00:00 UTC).`
            : 'The next Daily has not been scheduled yet.'}{' '}
          One measured attempt per UTC day; your result is below.
        </p>
      </div>
      <Link href="/history" className="btn-quiet shrink-0">
        View History
      </Link>
    </section>
  );
}
