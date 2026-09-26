import { NextResponse, type NextRequest } from 'next/server';
import { getGuestHistory } from '@/lib/repo/summary';
import { readGuestId } from '@/lib/session';
import { withRequestTiming } from '@/lib/timing';

/**
 * The guest's History: summary metrics and every decided attempt. Guest history lives
 * with this browser's session cookie — there is no account and no cross-device sync.
 * Read-only; a new guest gets an empty History.
 */
export async function GET(req: NextRequest) {
  return withRequestTiming('GET /api/history', async () => {
    const guestId = readGuestId(req);
    const history = await getGuestHistory(guestId);
    return NextResponse.json({ retention: 'guest_browser', hasGuestSession: guestId !== null, ...history });
  });
}
