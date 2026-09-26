import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { buildRoundStageResponse } from '@/lib/api/roundView';
import { lockFinalForGuest } from '@/lib/repo/attempts';
import { loadRound } from '@/lib/repo/rounds';
import { readGuestId } from '@/lib/session';
import { timed, withRequestTiming } from '@/lib/timing';

const bodySchema = z.object({ slot: z.enum(['A', 'B', 'C']) });

/** Locks the final choice of the guest's existing attempt. Never creates a player or attempt. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withRequestTiming('POST /api/rounds/:id/final', async () => {
    const { id } = await params;
    const loaded = await loadRound(id);
    if (!loaded) {
      return NextResponse.json({ error: 'round_not_found' }, { status: 404 });
    }

    const parsed = bodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: 'invalid_request', details: parsed.error.flatten() }, { status: 400 });
    }

    const guestId = readGuestId(req);
    if (!guestId) {
      return NextResponse.json(
        { error: 'final_choice_rejected', reason: 'blind choice not yet locked' },
        { status: 409 },
      );
    }

    const result = await lockFinalForGuest({ guestId, round: loaded.round, slot: parsed.data.slot });

    if (result.outcome === 'rejected') {
      // A late request still gets the true (server-decided) current state back — e.g. the
      // timeout result — never the caller's requested slot.
      const body = result.attempt ? buildRoundStageResponse(loaded, result.attempt, result.dbNow) : {};
      return NextResponse.json({ error: 'final_choice_rejected', reason: result.reason, ...body }, { status: 409 });
    }

    const body = await timed('view.verdict', async () => buildRoundStageResponse(loaded, result.attempt, result.dbNow));
    return NextResponse.json(body);
  });
}
