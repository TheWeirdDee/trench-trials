import { NextResponse, type NextRequest } from 'next/server';
import { getPlayerProgress, pickNextReplayRound } from '@/lib/repo/rounds';
import { readGuestId } from '@/lib/session';
import { withRequestTiming } from '@/lib/timing';

/**
 * The guest's next unplayed Replay round, plus where they stand. `available: false` is an
 * honest, expected state — never a filler round — and `reason` says why:
 * - `all_played`: the guest has played every approved round;
 * - `daily_only`: the remaining rounds are today's or an upcoming Daily;
 * - `none_approved`: no round is open for play at all.
 * Read-only: never creates a player or attempt.
 */
export async function GET(req: NextRequest) {
  return withRequestTiming('GET /api/rounds/next', async () => {
    const guestId = readGuestId(req);
    const [round, progress] = await Promise.all([pickNextReplayRound(guestId), getPlayerProgress(guestId)]);
    if (round) return NextResponse.json({ available: true, roundId: round.id, progress });
    const reason =
      progress.catalogSize === 0 ? 'none_approved' : progress.reservedForDaily > 0 ? 'daily_only' : 'all_played';
    return NextResponse.json({ available: false, reason, progress });
  });
}
