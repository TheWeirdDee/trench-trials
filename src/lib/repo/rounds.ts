import { getPool, withTransaction } from '../db';
import type { RoundAssetFull } from '../allowlist';
import { isPlayerFacing, playerFacingSql } from '../domain/eligibility';
import type { Slot } from '../domain/returns';
import { timed } from '../timing';

export interface RoundRow {
  id: string;
  mode: 'replay' | 'daily' | 'live';
  chain: string;
  status: string;
  cutoff: Date;
  horizon_days: number;
  candle_interval: string;
  resolution_time: Date;
  round_forge_version: number;
  clue_schema_version: number;
  price_policy_version: number;
  decision_window_seconds: number;
  decision_window_version: number;
  invalid_reason: string | null;
  repeat_of: string | null;
  created_at: Date;
  snapshot_published_at?: Date | null;
  entry_close_at?: Date | null;
  measurement_start_at?: Date | null;
  measurement_end_at?: Date | null;
  initial_manifest?: unknown;
  initial_nonce?: string | null;
  resolution_manifest?: unknown;
  resolution_nonce?: string | null;
  resolution_commitment_hash?: string | null;
  eligibility_status?: string | null;
  eligibility_policy_version?: number | null;
}

interface RoundAssetDbRow {
  slot: string;
  token_symbol: string;
  token_address: string;
  sectors: string[];
  clue_buy_sell_balance_bucket: string;
  clue_trading_acceleration_bucket: string;
  clue_netflow_over_liquidity_bucket: string;
  clue_recent_momentum_bucket: string;
  entry_candle_start: Date | string | null;
  entry_price: string | null;
  exit_candle_start: Date | string | null;
  exit_price: string | null;
  return_ratio: string | null;
}

function toRoundAssetFull(row: RoundAssetDbRow): RoundAssetFull {
  return {
    slot: row.slot as Slot,
    tokenSymbol: row.token_symbol,
    tokenAddress: row.token_address,
    sectors: row.sectors,
    clueBuySellBalanceBucket: row.clue_buy_sell_balance_bucket,
    clueTradingAccelerationBucket: row.clue_trading_acceleration_bucket,
    clueNetflowOverLiquidityBucket: row.clue_netflow_over_liquidity_bucket,
    clueRecentMomentumBucket: row.clue_recent_momentum_bucket,
    entryCandleStart: row.entry_candle_start ? new Date(row.entry_candle_start).toISOString() : null,
    entryPrice: row.entry_price !== null && row.entry_price !== undefined ? Number(row.entry_price) : null,
    exitCandleStart: row.exit_candle_start ? new Date(row.exit_candle_start).toISOString() : null,
    exitPrice: row.exit_price !== null && row.exit_price !== undefined ? Number(row.exit_price) : null,
    returnRatio: row.return_ratio !== null && row.return_ratio !== undefined ? Number(row.return_ratio) : null,
  };
}

export async function getRoundById(roundId: string): Promise<RoundRow | null> {
  const result = await getPool().query<RoundRow>('SELECT * FROM rounds WHERE id = $1', [roundId]);
  return result.rows[0] ?? null;
}

export async function getRoundAssets(roundId: string): Promise<RoundAssetFull[]> {
  const result = await getPool().query<RoundAssetDbRow>(
    `SELECT slot, token_symbol, token_address, sectors,
            clue_buy_sell_balance_bucket, clue_trading_acceleration_bucket,
            clue_netflow_over_liquidity_bucket, clue_recent_momentum_bucket,
            entry_candle_start, entry_price, exit_candle_start, exit_price, return_ratio
     FROM round_assets WHERE round_id = $1 ORDER BY slot ASC`,
    [roundId],
  );
  return result.rows.map(toRoundAssetFull);
}

export interface SourceReceiptView {
  endpoint: string;
  purpose: string | null;
  responseSha256: string;
  requestId: string | null;
  retrievedAt: string;
}

export interface LoadedRound {
  round: RoundRow & { initial_commitment_hash: string };
  assets: RoundAssetFull[];
  /** Provenance of the round's Nansen data. Only ever shown once the attempt is decided. */
  receipts: SourceReceiptView[];
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROUND_CACHE_TTL_MS = 5 * 60_000;
const ROUND_CACHE_MAX = 500;
const roundCache = new Map<string, { value: LoadedRound; expires: number }>();

/** A round whose row and assets can no longer change: terminal, or a published historical round. */
function isImmutable(round: RoundRow): boolean {
  if (round.status === 'resolved' || round.status === 'invalid') return true;
  return round.mode !== 'live' && round.status === 'ready';
}

/**
 * The round and its assets in one query. Immutable rounds are served from a short-lived
 * in-process cache, so a gameplay transition does not re-read the same evidence.
 * A malformed id is simply "not found".
 */
export async function loadRound(roundId: string): Promise<LoadedRound | null> {
  if (!UUID_PATTERN.test(roundId)) return null;
  const cached = roundCache.get(roundId);
  if (cached && cached.expires > Date.now()) return cached.value;

  const result = await timed('db.round', () =>
    getPool().query<RoundRow & { initial_commitment_hash: string; assets: RoundAssetDbRow[]; receipts: SourceReceiptView[] }>(
      `SELECT r.*, COALESCE(
         (SELECT json_agg(json_build_object(
            'slot', ra.slot, 'token_symbol', ra.token_symbol, 'token_address', ra.token_address,
            'sectors', ra.sectors,
            'clue_buy_sell_balance_bucket', ra.clue_buy_sell_balance_bucket,
            'clue_trading_acceleration_bucket', ra.clue_trading_acceleration_bucket,
            'clue_netflow_over_liquidity_bucket', ra.clue_netflow_over_liquidity_bucket,
            'clue_recent_momentum_bucket', ra.clue_recent_momentum_bucket,
            'entry_candle_start', ra.entry_candle_start, 'entry_price', ra.entry_price::text,
            'exit_candle_start', ra.exit_candle_start, 'exit_price', ra.exit_price::text,
            'return_ratio', ra.return_ratio::text) ORDER BY ra.slot)
          FROM round_assets ra WHERE ra.round_id = r.id), '[]'::json) AS assets,
         COALESCE(
         (SELECT json_agg(json_build_object(
            'endpoint', sr.endpoint, 'purpose', sr.purpose, 'responseSha256', sr.response_sha256,
            'requestId', sr.request_id, 'retrievedAt', sr.retrieved_at) ORDER BY sr.retrieved_at, sr.endpoint)
          FROM source_receipts sr WHERE sr.round_id = r.id), '[]'::json) AS receipts
       FROM rounds r WHERE r.id = $1`,
      [roundId],
    ),
  );
  const row = result.rows[0];
  if (!row) return null;
  const { assets, receipts, ...round } = row;
  const value: LoadedRound = {
    round: round as LoadedRound['round'],
    assets: assets.map(toRoundAssetFull),
    receipts: receipts.map((r) => ({ ...r, retrievedAt: new Date(r.retrievedAt).toISOString() })),
  };

  if (isImmutable(value.round)) {
    if (roundCache.size >= ROUND_CACHE_MAX) {
      const oldest = roundCache.keys().next().value;
      if (oldest) roundCache.delete(oldest);
    }
    roundCache.set(roundId, { value, expires: Date.now() + ROUND_CACHE_TTL_MS });
  }
  return value;
}

/**
 * Next verified Replay round this guest has not played (by canonical round, so a repeat
 * of a played round is excluded too), oldest-published first. A round assigned as a
 * current or upcoming Daily stays out of Replay, and only player-facing rounds (approved
 * under the current eligibility policy) are ever picked. Read-only: never creates a player.
 * Null = every available verified round has been played.
 */
export async function pickNextReplayRound(guestId: string | null): Promise<RoundRow | null> {
  const result = await timed('db.next_round', () =>
    getPool().query<RoundRow>(
      `SELECT r.* FROM rounds r
       WHERE r.mode = 'replay' AND r.status IN ('ready', 'resolved') AND ${playerFacingSql('r')}
         AND NOT EXISTS (
           SELECT 1 FROM attempts a
           JOIN players p ON p.id = a.player_id
           JOIN rounds played ON played.id = a.round_id
           WHERE p.anon_id = $1 AND COALESCE(played.repeat_of, played.id) = COALESCE(r.repeat_of, r.id)
         )
         AND NOT EXISTS (
           SELECT 1 FROM daily_challenges dc
           WHERE dc.round_id = r.id AND dc.utc_date >= (now() AT TIME ZONE 'UTC')::date
         )
       ORDER BY r.published_at ASC NULLS LAST, r.created_at ASC
       LIMIT 1`,
      [guestId],
    ),
  );
  return result.rows[0] ?? null;
}

export interface PlayerProgress {
  /** Approved Replay rounds in the catalog, including any serving as a Daily. */
  catalogSize: number;
  /** Approved rounds this guest has played (any mode). */
  completedCount: number;
  /** Approved rounds not yet played that are held back because they are today's or an upcoming Daily. */
  reservedForDaily: number;
  daily: {
    /** Today's (UTC) Daily exists and is approved. */
    available: boolean;
    roundId: string | null;
    utcDate: string;
    /** This guest has locked a final choice on today's Daily, or let its window expire. */
    completed: boolean;
    /** Next UTC midnight: when today's Daily ends. */
    resetAtUtc: string;
    /** A Daily is already assigned for tomorrow (UTC). */
    nextScheduled: boolean;
  };
}

/**
 * Where a guest stands, in one read-only query: catalog size, rounds played, rounds held
 * for the Daily, and today's Daily. Explains an empty Replay queue honestly instead of
 * implying the guest has played rounds they have not. A null guest has played nothing.
 */
export async function getPlayerProgress(guestId: string | null): Promise<PlayerProgress> {
  const res = await getPool().query<{
    catalog_size: number;
    completed_count: number;
    reserved_for_daily: number;
    today: string;
    daily_round_id: string | null;
    daily_completed: boolean;
    next_scheduled: boolean;
  }>(
    `WITH me AS (SELECT id FROM players WHERE $1::text IS NOT NULL AND anon_id = $1),
          catalog AS (
            SELECT r.id FROM rounds r
            WHERE r.mode = 'replay' AND r.status IN ('ready', 'resolved') AND r.repeat_of IS NULL AND ${playerFacingSql('r')}
          ),
          played AS (SELECT DISTINCT a.round_id FROM attempts a JOIN me ON me.id = a.player_id),
          today AS (SELECT (now() AT TIME ZONE 'UTC')::date AS d),
          daily AS (
            SELECT dc.round_id FROM daily_challenges dc JOIN rounds r ON r.id = dc.round_id, today
            WHERE dc.utc_date = today.d AND ${playerFacingSql('r')}
          )
     SELECT
       (SELECT count(*)::int FROM catalog) AS catalog_size,
       (SELECT count(*)::int FROM catalog c JOIN played p ON p.round_id = c.id) AS completed_count,
       (SELECT count(*)::int FROM catalog c
          WHERE NOT EXISTS (SELECT 1 FROM played p WHERE p.round_id = c.id)
            AND EXISTS (SELECT 1 FROM daily_challenges dc, today WHERE dc.round_id = c.id AND dc.utc_date >= today.d)) AS reserved_for_daily,
       (SELECT d::text FROM today) AS today,
       (SELECT round_id FROM daily) AS daily_round_id,
       EXISTS (
         SELECT 1 FROM attempts a JOIN me ON me.id = a.player_id JOIN daily ON daily.round_id = a.round_id
         WHERE a.stage = 'final_locked' OR (a.final_deadline_at IS NOT NULL AND a.final_deadline_at <= now())
       ) AS daily_completed,
       EXISTS (
         SELECT 1 FROM daily_challenges dc JOIN rounds r ON r.id = dc.round_id, today
         WHERE dc.utc_date = today.d + 1 AND ${playerFacingSql('r')}
       ) AS next_scheduled`,
    [guestId],
  );
  const row = res.rows[0]!;
  const utcDate = row.today.slice(0, 10);
  return {
    catalogSize: row.catalog_size,
    completedCount: row.completed_count,
    reservedForDaily: row.reserved_for_daily,
    daily: {
      available: row.daily_round_id !== null,
      roundId: row.daily_round_id,
      utcDate,
      completed: row.daily_completed,
      resetAtUtc: new Date(Date.parse(`${utcDate}T00:00:00Z`) + 86_400_000).toISOString(),
      nextScheduled: row.next_scheduled,
    },
  };
}

/** Today's Daily, only while its round is player-facing: a withdrawn round's Daily is not shown. */
export async function getDailyRoundForToday(): Promise<{ round: RoundRow; utcDate: string } | null> {
  const result = await getPool().query<RoundRow & { utc_date: string | Date }>(
    `SELECT r.*, dc.utc_date::text AS utc_date FROM daily_challenges dc
     JOIN rounds r ON r.id = dc.round_id
     WHERE dc.utc_date = (now() AT TIME ZONE 'UTC')::date AND ${playerFacingSql('r')}`,
  );
  const row = result.rows[0];
  if (!row) return null;
  const { utc_date, ...round } = row;
  const utcDate = typeof utc_date === 'string' ? utc_date.slice(0, 10) : new Date(utc_date).toISOString().slice(0, 10);
  return { round, utcDate };
}

/** 1-based sequence number of a Daily date among all assigned Daily dates up to and including it. */
export async function getDailyNumber(utcDate: string): Promise<number> {
  const result = await getPool().query<{ n: string }>(
    `SELECT count(*) AS n FROM daily_challenges WHERE utc_date <= $1::date`,
    [utcDate],
  );
  return Number(result.rows[0]?.n ?? 0);
}

export type DailyAssignmentError =
  | 'round_not_found'
  | 'round_not_resolved'
  | 'round_is_live'
  | 'round_is_repeat'
  | 'round_sourceless'
  | 'round_not_approved'
  | 'round_already_daily'
  | 'date_already_assigned';

export type DailyAssignmentResult =
  | { ok: true; utcDate: string; roundId: string }
  | { ok: false; error: DailyAssignmentError };

export interface DailyAssignmentOptions {
  source?: string;
  assignedByHash?: string;
  replacementReason?: string;
}

export async function assignDailyRound(
  utcDate: string,
  roundId: string,
  options: DailyAssignmentOptions = {},
): Promise<DailyAssignmentResult> {
  const pool = getPool();

  const round = await getRoundById(roundId);
  if (!round) return { ok: false, error: 'round_not_found' };
  if (!['ready', 'resolved'].includes(round.status)) return { ok: false, error: 'round_not_resolved' };
  // A Daily is a canonical verified round itself — never a Live round and never a copy.
  if (round.mode === 'live') return { ok: false, error: 'round_is_live' };
  if (round.repeat_of) return { ok: false, error: 'round_is_repeat' };
  if (!isPlayerFacing(round)) return { ok: false, error: 'round_not_approved' };

  const receipts = await pool.query<{ n: string }>(
    'SELECT count(*) AS n FROM source_receipts WHERE round_id = $1',
    [roundId],
  );
  if (Number(receipts.rows[0]?.n ?? 0) === 0) return { ok: false, error: 'round_sourceless' };

  const assignmentSource = options.source ?? 'admin_api';
  const assignedByHash = options.assignedByHash ?? null;

  // Each round is a Daily at most once, so a Daily is always new to everyone that day.
  // The check and the insert run under one lock so two assignments cannot both pass it.
  const outcome = await withTransaction(async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('trench_trials.daily_assignment'))`);
    const used = await client.query('SELECT 1 FROM daily_challenges WHERE round_id = $1 LIMIT 1', [roundId]);
    if (used.rowCount) return 'round_already_daily' as const;
    // Re-checked under the lock: a withdrawal between the read above and here must win.
    const approved = await client.query(`SELECT 1 FROM rounds r WHERE r.id = $1 AND ${playerFacingSql('r')} FOR SHARE`, [roundId]);
    if (!approved.rowCount) return 'round_not_approved' as const;
    const inserted = await client.query(
      `INSERT INTO daily_challenges (utc_date, round_id, assigned_at, assignment_source, assigned_by_hash)
       VALUES ($1::date, $2, now(), $3, $4)
       ON CONFLICT (utc_date) DO NOTHING`,
      [utcDate, roundId, assignmentSource, assignedByHash],
    );
    return inserted.rowCount ? ('ok' as const) : ('date_already_assigned' as const);
  });
  if (outcome !== 'ok') return { ok: false, error: outcome };

  console.log(
    `[daily-assignment] utc_date=${utcDate} round_id=${roundId} source=${assignmentSource} assigned_at=${new Date().toISOString()}`,
  );

  return { ok: true, utcDate, roundId };
}
