import { NextResponse } from 'next/server';
import { getDailyNumber, getDailyRoundForToday } from '@/lib/repo/rounds';

export async function GET() {
  const daily = await getDailyRoundForToday();

  if (!daily) {
    return NextResponse.json(
      { available: false, message: "Today's Trial is not available yet." },
      { status: 404 },
    );
  }

  const dateStr =
    typeof daily.utcDate === 'string'
      ? daily.utcDate.slice(0, 10)
      : new Date(daily.utcDate).toISOString().slice(0, 10);
  const dailyNumber = await getDailyNumber(dateStr);
  const cutoffMs = Date.parse(`${dateStr}T00:00:00Z`);
  const resetAtUtc = new Date(cutoffMs + 24 * 60 * 60 * 1000).toISOString();

  return NextResponse.json({
    available: true,
    roundId: daily.round.id,
    utcDate: dateStr,
    dailyNumber,
    resetAtUtc,
  });
}
