import { getPool } from '../db';
import { playerFacingSql } from '../domain/eligibility';
import { buildGuestHistory, type GuestHistory, type HistoryAttemptInput } from '../domain/history';
import type { Slot } from '../domain/returns';
import type { FinalActionType } from '../domain/scoring';
import { timed } from '../timing';

interface RawAttemptRow {
  round_id: string;
  repeat_of: string | null;
  mode: 'replay' | 'daily' | 'live';
  round_status: string;
  player_facing: boolean;
  cutoff: Date;
  stage: string;
  blind_slot: Slot | null;
  final_slot: Slot | null;
  final_action_type: FinalActionType | null;
  final_deadline_at: Date | null;
  final_locked_at: Date | null;
  created_at: Date;
  daily_date: string | null;
  assigned_daily_dates: string[] | null;
  db_now: Date;
  assets: Array<{ slot: Slot; token_symbol: string; return_ratio: string | null }>;
}

const EMPTY_HISTORY = () => buildGuestHistory([], new Date());

/**
 * The guest's History (see domain/history.ts for every count's definition). Read-only:
 * a request without a verified guest id gets an empty History and creates nothing.
 */
export async function getGuestHistory(guestId: string | null): Promise<GuestHistory> {
  if (!guestId) return EMPTY_HISTORY();
  const result = await timed('db.history', () =>
    getPool().query<RawAttemptRow>(
      `SELECT a.round_id, r.repeat_of, r.mode, r.status AS round_status, ${playerFacingSql('r')} AS player_facing, r.cutoff,
              a.stage, a.blind_slot, a.final_slot, a.final_action_type,
              a.final_deadline_at, a.final_locked_at, a.created_at,
              (SELECT dc.utc_date::text FROM daily_challenges dc
                WHERE dc.round_id = r.id AND dc.utc_date = (a.created_at AT TIME ZONE 'UTC')::date) AS daily_date,
              (SELECT array_agg(dc.utc_date::text) FROM daily_challenges dc
                WHERE dc.utc_date <= (clock_timestamp() AT TIME ZONE 'UTC')::date) AS assigned_daily_dates,
              clock_timestamp() AS db_now,
              COALESCE((SELECT json_agg(json_build_object(
                          'slot', ra.slot, 'token_symbol', ra.token_symbol, 'return_ratio', ra.return_ratio::text)
                        ORDER BY ra.slot)
                        FROM round_assets ra WHERE ra.round_id = r.id), '[]'::json) AS assets
       FROM attempts a
       JOIN players p ON p.id = a.player_id
       JOIN rounds r ON r.id = a.round_id
       WHERE p.anon_id = $1
       ORDER BY a.created_at ASC`,
      [guestId],
    ),
  );
  if (result.rows.length === 0) return EMPTY_HISTORY();

  const attempts: HistoryAttemptInput[] = result.rows.map((row) => ({
    roundId: row.round_id,
    repeatOf: row.repeat_of,
    mode: row.mode,
    roundStatus: row.round_status,
    roundWithdrawn: !row.player_facing,
    cutoff: row.cutoff,
    stage: row.stage,
    blindSlot: row.blind_slot,
    finalSlot: row.final_slot,
    finalActionType: row.final_action_type,
    finalDeadlineAt: row.final_deadline_at,
    finalLockedAt: row.final_locked_at,
    createdAt: row.created_at,
    dailyDate: row.daily_date,
    assets: row.assets.map((a) => ({
      slot: a.slot,
      tokenSymbol: a.token_symbol,
      returnRatio: a.return_ratio === null ? null : Number(a.return_ratio),
    })),
  }));
  const first = result.rows[0]!;
  return buildGuestHistory(attempts, first.db_now, first.assigned_daily_dates ?? []);
}
