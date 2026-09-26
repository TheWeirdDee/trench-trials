import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { buildRoundStageResponse } from '@/lib/api/roundView';
import { lockBlindForGuest } from '@/lib/repo/attempts';
import { loadRound } from '@/lib/repo/rounds';
import { applySessionCookie, resolveOrIssueGuest, type GuestIdentity } from '@/lib/session';
import { timed, withRequestTiming } from '@/lib/timing';

const bodySchema = z.object({ slot: z.enum(['A', 'B', 'C']) });

/**
 * The first intentional, persistent action: creates the guest (if new) and their attempt,
 * then locks the blind choice. The Unmask deadline is set by the database clock at the
 * final write of this transition.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withRequestTiming('POST /api/rounds/:id/blind', async () => {
    const { id } = await params;
    const loaded = await loadRound(id);
    if (!loaded || loaded.round.status === 'invalid') {
      return NextResponse.json({ error: 'round_not_found_or_invalid' }, { status: 404 });
    }
    const { round } = loaded;

    const parsed = bodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: 'invalid_request', details: parsed.error.flatten() }, { status: 400 });
    }

    // Cheap pre-check so a late entry creates nothing; the transaction re-checks on the DB clock.
    if (round.mode === 'live' && Date.now() > (round.entry_close_at ?? round.cutoff).getTime()) {
      return NextResponse.json({ error: 'blind_choice_rejected', reason: 'live_entry_closed' }, { status: 409 });
    }

    let identity: GuestIdentity;
    try {
      identity = resolveOrIssueGuest(req);
    } catch {
      return NextResponse.json({ error: 'session_unavailable' }, { status: 503 });
    }

    const result = await lockBlindForGuest({ guestId: identity.guestId, round, slot: parsed.data.slot });
    if (result.outcome === 'rejected') {
      return NextResponse.json({ error: 'blind_choice_rejected', reason: result.reason }, { status: 409 });
    }

    const body = await timed('view.unmask', async () => buildRoundStageResponse(loaded, result.attempt, result.dbNow));
    const response = NextResponse.json(body);
    applySessionCookie(response, identity);
    return response;
  });
}
