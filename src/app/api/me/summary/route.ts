import { NextResponse, type NextRequest } from 'next/server';
import { getGuestHistory } from '@/lib/repo/summary';
import { readGuestId } from '@/lib/session';
import { withRequestTiming } from '@/lib/timing';

/** Summary metrics only (see /api/history for the attempt list). Read-only; a new guest gets an empty summary. */
export async function GET(req: NextRequest) {
  return withRequestTiming('GET /api/me/summary', async () => {
    const history = await getGuestHistory(readGuestId(req));
    return NextResponse.json(history.summary);
  });
}
