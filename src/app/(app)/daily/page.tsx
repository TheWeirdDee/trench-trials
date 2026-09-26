import Link from 'next/link';
import { RoundClient } from '../round/[id]/RoundClient';
import { getDailyNumber, getDailyRoundForToday } from '@/lib/repo/rounds';

export const metadata = { title: 'Daily trial · Trench Trials' };

function nextUtcMidnight(utcDate: string): string {
  return new Date(Date.parse(`${utcDate}T00:00:00Z`) + 24 * 60 * 60 * 1000).toISOString();
}

export default async function DailyPage() {
  const daily = await getDailyRoundForToday();

  if (!daily) {
    return (
      <div className="page py-16 sm:py-24">
        <div className="max-w-3xl">
          <p className="eyebrow">Daily trial</p>
          <h1 className="type-section mt-4">No Daily today.</h1>
          <p className="type-lead mt-6" data-testid="daily-unavailable">
            A Daily is published only when a verified round has been assigned to today’s UTC date. None has been, so
            there is nothing to play here — and no substitute round will be invented.
          </p>
          <div className="mt-10 flex flex-col gap-3 sm:flex-row">
            <Link href="/play" className="btn-primary">
              Play a verified round
            </Link>
            <Link href="/docs#daily" className="btn-quiet">
              How the Daily works
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const dailyNumber = await getDailyNumber(daily.utcDate);
  return (
    <RoundClient
      roundId={daily.round.id}
      daily={{ dailyNumber, utcDate: daily.utcDate, resetAtUtc: nextUtcMidnight(daily.utcDate) }}
    />
  );
}
