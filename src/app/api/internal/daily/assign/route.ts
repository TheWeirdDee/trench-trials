import { NextResponse } from 'next/server';
import { z } from 'zod';
import { isAuthorizedInternalRequest } from '@/lib/internalAuth';
import { assignDailyRound } from '@/lib/repo/rounds';

const bodySchema = z.object({
  utcDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'utcDate must be YYYY-MM-DD'),
  roundId: z.string().uuid(),
});

/**
 * Internal-only. Maps an already-verified, already-resolved canonical round (Replay or
 * Daily mode — never Live, never a repeat copy, never one already used as a Daily) to
 * a UTC calendar date. The Daily references that round directly; nothing is cloned. Never touches Nansen, never generates or modifies market
 * data — see src/lib/repo/rounds.ts::assignDailyRound for the full rejection list.
 */
export async function POST(req: Request) {
  if (!isAuthorizedInternalRequest(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_request', details: parsed.error.flatten() }, { status: 400 });
  }

  const result = await assignDailyRound(parsed.data.utcDate, parsed.data.roundId);
  if (!result.ok) {
    const status = result.error === 'round_not_found' ? 404 : 409;
    return NextResponse.json({ error: result.error }, { status });
  }

  return NextResponse.json({ ok: true, utcDate: result.utcDate, roundId: result.roundId });
}
