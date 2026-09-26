import { NextResponse, type NextRequest } from 'next/server';
import { countPlayerFacingReplayRounds, pickNextReplayRound } from '@/lib/repo/rounds';
import { readGuestId } from '@/lib/session';
import { withRequestTiming } from '@/lib/timing';

/**
 * The guest's next unplayed verified round. `available: false` is an honest, expected
 * state — never a fallback round — and says why: every approved round has been played
 * (`all_played`), or no round is approved for play right now (`none_approved`). Read-only.
 */
export async function GET(req: NextRequest) {
  return withRequestTiming('GET /api/rounds/next', async () => {
    const round = await pickNextReplayRound(readGuestId(req));
    if (round) return NextResponse.json({ available: true, roundId: round.id });
    const approved = await countPlayerFacingReplayRounds();
    return NextResponse.json(
      approved > 0
        ? { available: false, reason: 'all_played', message: 'You have completed every available verified round.' }
        : { available: false, reason: 'none_approved', message: 'No verified round is approved for play right now.' },
    );
  });
}
