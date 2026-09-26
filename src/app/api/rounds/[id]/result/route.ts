import { NextResponse, type NextRequest } from 'next/server';
import { buildRoundStageResponse, effectiveAttempt } from '@/lib/api/roundView';
import { findGuestAttempt } from '@/lib/repo/attempts';
import { loadRound } from '@/lib/repo/rounds';
import { readGuestId } from '@/lib/session';
import { withRequestTiming } from '@/lib/timing';

/**
 * Strictly gated on this attempt's own final lock (PRD §13: "The result endpoint must
 * require the requesting attempt's final lock"). A different player's round-scoped ID
 * cannot be used to read this player's result — the attempt is scoped by the verified
 * session cookie, never a client-supplied id. Read-only.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withRequestTiming('GET /api/rounds/:id/result', async () => {
    const { id } = await params;
    const loaded = await loadRound(id);
    const { attempt, dbNow } = loaded
      ? await findGuestAttempt(readGuestId(req), loaded.round.id)
      : { attempt: null, dbNow: new Date() };
    if (!loaded || !attempt) {
      return NextResponse.json({ error: 'attempt_not_found' }, { status: 404 });
    }

    const current = effectiveAttempt(attempt, dbNow);
    if (current.stage !== 'final_locked') {
      return NextResponse.json({ error: 'not_yet_final_locked', stage: current.stage }, { status: 403 });
    }

    return NextResponse.json(buildRoundStageResponse(loaded, attempt, dbNow));
  });
}
