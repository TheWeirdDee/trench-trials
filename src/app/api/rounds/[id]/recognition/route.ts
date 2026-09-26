import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { submitRecognitionForGuest } from '@/lib/repo/attempts';
import { readGuestId } from '@/lib/session';
import { withRequestTiming } from '@/lib/timing';

const bodySchema = z.object({
  recognizedSlots: z.array(z.enum(['A', 'B', 'C'])).default([]),
  skipped: z.boolean().default(false),
});

/** Optional, post-verdict only, at most once per attempt (PRD §5.3). Never creates a player. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withRequestTiming('POST /api/rounds/:id/recognition', async () => {
    const { id: roundId } = await params;
    const guestId = readGuestId(req);
    if (!guestId) {
      return NextResponse.json({ error: 'attempt_not_found' }, { status: 404 });
    }

    const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json({ error: 'invalid_request', details: parsed.error.flatten() }, { status: 400 });
    }

    const result = await submitRecognitionForGuest(guestId, roundId, parsed.data.recognizedSlots, parsed.data.skipped);
    if (result.outcome === 'not_found') {
      return NextResponse.json({ error: 'attempt_not_found' }, { status: 404 });
    }
    if (result.outcome === 'not_final' || result.outcome === 'conflict') {
      return NextResponse.json({ error: 'recognition_rejected' }, { status: 409 });
    }
    return NextResponse.json({
      ok: true,
      recognizedSlots: result.attempt.recognition_slots,
      skipped: result.attempt.recognition_skipped,
    });
  });
}
