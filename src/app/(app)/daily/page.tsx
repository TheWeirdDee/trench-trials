import Link from 'next/link';
import { RoundClient } from '../round/[id]/RoundClient';
import { getDailyNumber, getDailyRoundForToday, getPlayerProgress } from '@/lib/repo/rounds';

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
            No Daily is scheduled for today’s UTC date. Try a Replay round; a new Daily appears here when one is
            scheduled.
          </p>
          <div className="mt-10 flex flex-col gap-3 sm:flex-row">
            <Link href="/play" className="btn-primary">
              Play Replay
            </Link>
            <Link href="/docs#daily" className="btn-quiet">
              How the Daily works
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const [dailyNumber, progress] = await Promise.all([getDailyNumber(daily.utcDate), getPlayerProgress(null)]);
  return (
    <RoundClient
      roundId={daily.round.id}
      daily={{
        dailyNumber,
        utcDate: daily.utcDate,
        resetAtUtc: nextUtcMidnight(daily.utcDate),
        nextScheduled: progress.daily.nextScheduled,
      }}
    />
  );
}
