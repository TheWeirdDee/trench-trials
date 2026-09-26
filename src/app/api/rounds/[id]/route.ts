import { NextResponse, type NextRequest } from 'next/server';
import { buildRoundStageResponse } from '@/lib/api/roundView';
import { findGuestAttempt } from '@/lib/repo/attempts';
import { loadRound } from '@/lib/repo/rounds';
import { readGuestId } from '@/lib/session';
import { withRequestTiming } from '@/lib/timing';

/**
 * Read-only. Returns the round at the guest's current stage — the blind stage with no
 * attempt behind it until their first Blind Pick. Never creates a player or attempt.
 * A round that is not player-facing is 404 unless this guest already has an attempt or
 * the round is invalid (a read-only void record).
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withRequestTiming('GET /api/rounds/:id', async () => {
    const { id } = await params;
    const loaded = await loadRound(id);
    if (!loaded) {
      return NextResponse.json({ error: 'round_not_found' }, { status: 404 });
    }
    const { round } = loaded;

    const { attempt, dbNow, roundPlayerFacing } = await findGuestAttempt(readGuestId(req), round.id);

    // Only a round approved under the current eligibility policy can be started. A guest
    // who already played a since-withdrawn round can still open their own attempt, and an
    // invalid round stays readable as a void audit record — it can never be played or scored.
    if (!attempt && !roundPlayerFacing && round.status !== 'invalid') {
      return NextResponse.json(
        { error: 'round_not_available', message: 'This round is not available for play.' },
        { status: 404 },
      );
    }

    // A Live round without this guest's attempt can only be entered while entry is open.
    if (!attempt && round.mode === 'live' && round.status !== 'invalid') {
      const entryCloseAt = round.entry_close_at ?? round.cutoff;
      if (dbNow.getTime() > entryCloseAt.getTime()) {
        return NextResponse.json(
          { error: 'live_entry_closed', message: 'Live round entry window has closed' },
          { status: 403 },
        );
      }
    }

    return NextResponse.json(buildRoundStageResponse(loaded, attempt, dbNow));
  });
}
