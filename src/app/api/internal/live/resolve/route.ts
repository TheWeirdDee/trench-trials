import { NextResponse, type NextRequest } from 'next/server';
import { isAuthorizedInternalRequest } from '@/lib/internalAuth';
import { getCurrentLiveRound, resolveLiveRound } from '@/lib/repo/live';

export async function POST(req: NextRequest) {
  if (!isAuthorizedInternalRequest(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));

  // Caller-supplied prices or clock are fixture inputs: only the test runner may use
  // them. In production they could fake an outcome or force an early/invalid resolve.
  if ((body.customExitPrices || body.now) && process.env.NODE_ENV !== 'test') {
    return NextResponse.json({ ok: false, error: 'fixture_inputs_disabled' }, { status: 403 });
  }

  let roundId = body.roundId;

  if (!roundId) {
    const current = await getCurrentLiveRound();
    if (!current) {
      return NextResponse.json({ error: 'no_live_round_found' }, { status: 404 });
    }
    roundId = current.id;
  }

  const result = await resolveLiveRound(roundId, {
    customExitPrices: body.customExitPrices,
    now: body.now ? new Date(body.now) : undefined,
  });

  if (!result.ok) {
    const status =
      result.error === 'resolution_before_measurement_end' || result.error === 'market_data_not_yet_expected'
        ? 409
        : 422;
    return NextResponse.json(result, { status });
  }

  return NextResponse.json(result);
}
