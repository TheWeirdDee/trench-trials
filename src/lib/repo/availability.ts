import { getPool } from '../db';
import { playerFacingSql } from '../domain/eligibility';

export interface ModeAvailability {
  /** A verified round is assigned as today's Daily (UTC). */
  daily: boolean;
  /** The latest Live round can be entered right now (open, entry window running) or has resolved. */
  live: boolean;
}

// A short cache keeps navigation cheap. MODE_AVAILABILITY_TTL_MS=0 turns it off (the e2e
// server does, so a test-owned Daily is reflected in navigation immediately).
const TTL_MS = Number(process.env.MODE_AVAILABILITY_TTL_MS ?? 30_000);
let cached: { value: ModeAvailability; expires: number } | null = null;

/** Which optional modes may be promised in navigation. Fails closed: unknown means hidden. */
export async function getModeAvailability(): Promise<ModeAvailability> {
  if (cached && cached.expires > Date.now()) return cached.value;
  try {
    const res = await getPool().query<{ daily: boolean; live: boolean | null }>(
      `SELECT EXISTS (
           SELECT 1 FROM daily_challenges dc JOIN rounds r ON r.id = dc.round_id
           WHERE dc.utc_date = (now() AT TIME ZONE 'UTC')::date AND r.status IN ('ready', 'resolved')
             AND ${playerFacingSql('r')}
         ) AS daily,
         (SELECT r.status = 'resolved' OR (r.status = 'open' AND now() < COALESCE(r.entry_close_at, r.cutoff))
            FROM rounds r WHERE r.mode = 'live' AND ${playerFacingSql('r')}
            ORDER BY r.created_at DESC LIMIT 1) AS live`,
    );
    const row = res.rows[0];
    // Live is promised only while it can be played or its real result can be shown —
    // not while it is measuring or awaiting resolution, and never when invalid.
    const value: ModeAvailability = { daily: Boolean(row?.daily), live: Boolean(row?.live) };
    cached = { value, expires: Date.now() + TTL_MS };
    return value;
  } catch {
    return { daily: false, live: false };
  }
}
