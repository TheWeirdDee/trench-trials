import type { Pool, PoolClient } from 'pg';
import { getPool, withTransaction } from '../db';
import {
  buildLiveInitialManifest,
  buildLiveResolutionManifest,
  computeLiveSchedule,
  createLiveCommitment,
  isLiveEntryAllowed,
  isLiveResolutionAllowed,
  isLiveResolutionTimedOut,
  LIVE_RESOLVE_MIN_DATA_DELAY_SECONDS,
  type LiveCandidateAsset,
  type LiveResolutionManifest,
  type LiveResolvedAsset,
  type LiveSchedule,
  type LiveTimingConfig,
} from '../domain/live';
import { computeReturn, determineWinningSlots, type Slot } from '../domain/returns';
import { generateNonce, computeCommitment } from '../domain/commitment';
import {
  DEFAULT_MAX_NANSEN_CALLS_PER_LIVE_RESOLVE,
  DEFAULT_MAX_NANSEN_CREDITS_PER_LIVE_RESOLVE,
  MAX_NANSEN_CALLS_PER_LIVE_RESOLVE_ENV,
  MAX_NANSEN_CREDITS_PER_LIVE_RESOLVE_ENV,
  readNansenCreditBudget,
  NansenBudgetError,
  NansenCallBudget,
  readNansenCallBudget,
  type NansenAttemptRecorder,
  type NansenBudgetSummary,
} from '../nansen/budget';
import { fetchHistoricalOhlcv, NansenApiError, NansenInsufficientCreditsError } from '../nansen/client';
import { recordNansenAttempt } from './apiCallLog';
import { setRoundEligibility, type EligibilityDecision } from './eligibility';
import { isPlayerFacing, playerFacingSql } from '../domain/eligibility';
import type { RoundRow } from './rounds';

export interface CreateLiveRoundParams {
  chain: string;
  assets: LiveCandidateAsset[];
  timingConfig?: LiveTimingConfig;
  sourceReceipts?: Array<{
    endpoint: string;
    requestParams: Record<string, unknown>;
    responseSha256: string;
    retrievedAt?: Date;
    purpose?: string;
    requestId?: string | null;
    creditsUsed?: number | null;
  }>;
  snapshotPublishedAt?: Date;
  /**
   * Refuse to insert while another Live round is unresolved. Checked under a
   * transaction-scoped advisory lock, so concurrent creators cannot both insert.
   */
  requireNoActiveLiveRound?: boolean;
  /**
   * Eligibility recorded with the round, in the same transaction. Omitted, the round is
   * `pending_review` and not player-facing until reviewed.
   */
  eligibility?: EligibilityDecision;
}

/** Any Live round not yet in a terminal state still owns the single Live slot. */
const ACTIVE_LIVE_ROUND_SQL = `SELECT id, status, measurement_end_at FROM rounds
   WHERE mode = 'live' AND status NOT IN ('resolved', 'invalid')
   ORDER BY created_at DESC
   LIMIT 1`;

export interface ActiveLiveRound {
  id: string;
  status: string;
  measurement_end_at: Date | null;
}

export class ActiveLiveRoundExistsError extends Error {
  constructor(public readonly roundId: string, public readonly status: string) {
    super(`Live round ${roundId} is still ${status}; resolve it before creating another`);
    this.name = 'ActiveLiveRoundExistsError';
  }
}

export async function findActiveLiveRound(): Promise<ActiveLiveRound | null> {
  const result = await getPool().query<ActiveLiveRound>(ACTIVE_LIVE_ROUND_SQL);
  return result.rows[0] ?? null;
}

export interface CreateLiveRoundResult {
  roundId: string;
  commitmentHash: string;
  schedule: LiveSchedule;
  alreadyExisted?: boolean;
}

export async function createLiveRound(
  params: CreateLiveRoundParams,
): Promise<CreateLiveRoundResult> {
  return withTransaction(async (client) => {
    if (params.requireNoActiveLiveRound) {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('trench_trials:live_create'))`);
      const active = await client.query<ActiveLiveRound>(ACTIVE_LIVE_ROUND_SQL);
      const activeRow = active.rows[0];
      if (activeRow) throw new ActiveLiveRoundExistsError(activeRow.id, activeRow.status);
    }

    const publishedAt = params.snapshotPublishedAt ?? new Date();
    const schedule = computeLiveSchedule(publishedAt, params.timingConfig);

    const initialManifest = buildLiveInitialManifest({
      chain: params.chain,
      schedule,
      assets: params.assets,
      roundForgeVersion: 1,
      clueSchemaVersion: 1,
      pricePolicyVersion: 1,
    });

    const { commitmentHash, nonce } = createLiveCommitment(initialManifest);

    // Idempotency: check if an identical live round snapshot already exists
    const manifestJson = JSON.stringify(initialManifest);
    const existing = await client.query<{ id: string; initial_commitment_hash: string }>(
      `SELECT id, initial_commitment_hash FROM rounds WHERE initial_manifest = $1::jsonb LIMIT 1`,
      [manifestJson],
    );
    if (existing.rows[0]) {
      return {
        roundId: existing.rows[0].id,
        commitmentHash: existing.rows[0].initial_commitment_hash,
        schedule,
        alreadyExisted: true,
      };
    }

    const roundInsert = await client.query<{ id: string }>(
      `INSERT INTO rounds (
         mode, chain, status, cutoff, horizon_days, candle_interval, resolution_time,
         round_forge_version, clue_schema_version, price_policy_version,
         decision_window_seconds, decision_window_version,
         initial_manifest, initial_commitment_hash, initial_nonce,
         snapshot_published_at, entry_close_at, measurement_start_at, measurement_end_at,
         published_at
       ) VALUES (
         'live', $1, 'open', $2, 1, '5m', $3,
         1, 1, 1,
         15, 1,
         $4, $5, $6,
         $7, $8, $9, $10,
         $7
       ) RETURNING id`,
      [
        params.chain,
        schedule.entryCloseAt,
        schedule.measurementEndAt,
        JSON.stringify(initialManifest),
        commitmentHash,
        nonce,
        schedule.snapshotPublishedAt,
        schedule.entryCloseAt,
        schedule.measurementStartAt,
        schedule.measurementEndAt,
      ],
    );

    const roundId = roundInsert.rows[0]?.id;
    if (!roundId) throw new Error('Failed to insert live round');
    if (params.eligibility) await setRoundEligibility(client, roundId, params.eligibility);

    for (const asset of params.assets) {
      const buySell = asset.clues.buy_sell_balance;
      const accel = asset.clues.trading_acceleration;
      const netflow = asset.clues.netflow_over_liquidity;
      const momentum = asset.clues.recent_momentum;

      if (!buySell || !accel || !netflow || !momentum) {
        throw new Error(`Asset slot ${asset.slot} is missing required clues`);
      }

      await client.query(
        `INSERT INTO round_assets (
           round_id, slot, token_symbol, token_address, sectors,
           clue_buy_sell_balance, clue_buy_sell_balance_bucket,
           clue_trading_acceleration, clue_trading_acceleration_bucket,
           clue_netflow_over_liquidity, clue_netflow_over_liquidity_bucket,
           clue_recent_momentum, clue_recent_momentum_bucket
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          roundId,
          asset.slot,
          asset.tokenSymbol,
          asset.tokenAddress,
          asset.sectors,
          buySell.value,
          buySell.bucket,
          accel.value,
          accel.bucket,
          netflow.value,
          netflow.bucket,
          momentum.value,
          momentum.bucket,
        ],
      );
    }

    if (params.sourceReceipts) {
      for (const receipt of params.sourceReceipts) {
        await client.query(
          `INSERT INTO source_receipts (
             round_id, endpoint, request_params, retrieved_at, response_sha256, schema_version, purpose,
             request_id, credits_used
           ) VALUES ($1, $2, $3, $4, $5, 1, $6, $7, $8)`,
          [
            roundId,
            receipt.endpoint,
            JSON.stringify(receipt.requestParams),
            receipt.retrievedAt ?? schedule.snapshotPublishedAt,
            receipt.responseSha256,
            receipt.purpose ?? 'live_snapshot',
            receipt.requestId ?? null,
            receipt.creditsUsed ?? null,
          ],
        );
      }
    }

    return { roundId, commitmentHash, schedule, alreadyExisted: false };
  });
}

export interface LiveRoundWithTiming extends RoundRow {
  snapshot_published_at: Date | null;
  entry_close_at: Date | null;
  measurement_start_at: Date | null;
  measurement_end_at: Date | null;
  initial_commitment_hash: string;
  resolution_manifest: LiveResolutionManifest | null;
}

/** The latest Live round; with `playerFacingOnly`, the latest one players may see. */
export async function getCurrentLiveRound(
  options: { playerFacingOnly?: boolean } = {},
): Promise<LiveRoundWithTiming | null> {
  const result = await getPool().query<LiveRoundWithTiming>(
    `SELECT * FROM rounds r
     WHERE r.mode = 'live' ${options.playerFacingOnly ? `AND ${playerFacingSql('r')}` : ''}
     ORDER BY r.created_at DESC
     LIMIT 1`,
  );
  return result.rows[0] ?? null;
}

export type ResolveLiveRoundResult =
  | {
      ok: true;
      roundId: string;
      manifest: LiveResolutionManifest;
      alreadyResolved?: boolean;
      nansen?: NansenBudgetSummary;
    }
  | {
      ok: false;
      error: string;
      reason?: string | null;
      measurementEndAt?: Date;
      retryUntil?: Date;
      notBefore?: Date;
      nansen?: NansenBudgetSummary;
    };

/** Failures a retry cannot fix get their own code; anything else is reported as pending. */
function nansenFailureCode(err: unknown): string | null {
  if (err instanceof NansenInsufficientCreditsError) return 'nansen_insufficient_credits';
  if (err instanceof NansenBudgetError) return err.code;
  if (err instanceof NansenApiError && (err.status === 401 || err.status === 403)) return 'nansen_auth_rejected';
  if (err instanceof NansenApiError && err.status >= 400 && err.status < 500 && !err.retryable) {
    return 'nansen_request_rejected';
  }
  if (err instanceof SyntaxError) return 'nansen_response_malformed';
  return null;
}

export async function resolveLiveRound(
  roundId: string,
  options?: {
    customExitPrices?: LiveResolvedAsset[];
    now?: Date;
    /** Defaults to MAX_NANSEN_CALLS_PER_LIVE_RESOLVE, else DEFAULT_MAX_NANSEN_CALLS_PER_LIVE_RESOLVE. */
    maxNansenCalls?: number;
    /** Defaults to writing api_call_log. */
    recordNansenAttempt?: NansenAttemptRecorder;
  },
): Promise<ResolveLiveRoundResult> {
  return withTransaction(async (client) => {
    const roundRes = await client.query<LiveRoundWithTiming>(
      `SELECT * FROM rounds WHERE id = $1 FOR UPDATE`,
      [roundId],
    );
    const round = roundRes.rows[0];
    if (!round) return { ok: false, error: 'round_not_found' };
    if (round.mode !== 'live') return { ok: false, error: 'round_not_live_mode' };

    // Idempotency: if already resolved, return the existing result cleanly
    if (round.status === 'resolved' && round.resolution_manifest) {
      return {
        ok: true,
        roundId,
        manifest: round.resolution_manifest,
        alreadyResolved: true,
      };
    }

    if (round.status === 'invalid') {
      return { ok: false, error: 'round_already_invalid', reason: round.invalid_reason };
    }

    // No verdict is ever published for a round that is not approved under the current
    // eligibility policy, and no credits are spent on one.
    if (!isPlayerFacing(round)) {
      return { ok: false, error: 'round_not_approved', reason: round.eligibility_status ?? null };
    }

    const now = options?.now ?? new Date();
    const measurementEndAt = round.measurement_end_at ?? round.resolution_time;
    const measurementStartAt = round.measurement_start_at ?? round.cutoff;

    // Reject resolution if measurement window has not yet completed
    if (now.getTime() < measurementEndAt.getTime()) {
      return {
        ok: false,
        error: 'resolution_before_measurement_end',
        measurementEndAt,
      };
    }

    const assetsRes = await client.query<{
      slot: string;
      token_symbol: string;
      token_address: string;
    }>(`SELECT slot, token_symbol, token_address FROM round_assets WHERE round_id = $1 ORDER BY slot ASC`, [
      roundId,
    ]);
    const assetRows = assetsRes.rows;

    let resolvedAssets: LiveResolvedAsset[] = [];
    let resolvedNansen: NansenBudgetSummary | undefined;

    if (options?.customExitPrices) {
      // Test / Fixture path: validate provided prices
      resolvedAssets = options.customExitPrices;
      for (const a of resolvedAssets) {
        if (!Number.isFinite(a.entryPrice) || a.entryPrice <= 0) {
          return { ok: false, error: 'invalid_entry_price', reason: `Slot ${a.slot} price ${a.entryPrice}` };
        }
        if (!Number.isFinite(a.exitPrice) || a.exitPrice <= 0) {
          return { ok: false, error: 'invalid_exit_price', reason: `Slot ${a.slot} price ${a.exitPrice}` };
        }
      }
    } else {
      // Real Nansen API fetch path
      const retryDeadline = new Date(measurementEndAt.getTime() + 6 * 3600 * 1000);
      const isTimedOut = now.getTime() >= retryDeadline.getTime();

      // Every OHLCV request is billed; before the exit candle can be indexed it would
      // only spend credits and come back pending.
      const notBefore = new Date(measurementEndAt.getTime() + LIVE_RESOLVE_MIN_DATA_DELAY_SECONDS * 1000);
      if (now.getTime() < notBefore.getTime()) {
        return { ok: false, error: 'market_data_not_yet_expected', measurementEndAt, notBefore };
      }

      let budget: NansenCallBudget;
      try {
        budget = new NansenCallBudget({
          operation: `live_resolve:${roundId}`,
          maxNetworkCalls:
            options?.maxNansenCalls ??
            readNansenCallBudget(MAX_NANSEN_CALLS_PER_LIVE_RESOLVE_ENV, DEFAULT_MAX_NANSEN_CALLS_PER_LIVE_RESOLVE),
          requiredNetworkCalls: assetRows.length,
          maxCredits: readNansenCreditBudget(MAX_NANSEN_CREDITS_PER_LIVE_RESOLVE_ENV, DEFAULT_MAX_NANSEN_CREDITS_PER_LIVE_RESOLVE),
          recorder: options?.recordNansenAttempt ?? recordNansenAttempt,
        });
      } catch (err) {
        return { ok: false, error: nansenFailureCode(err) ?? 'nansen_budget_invalid', reason: (err as Error).message };
      }

      try {
        const startIso = measurementStartAt.toISOString();
        const endIso = measurementEndAt.toISOString();

        for (const row of assetRows) {
          const ohlcvRequest = {
            chain: round.chain,
            token_address: row.token_address,
            // Full datetime, as validated in DATA-CONTRACT.md §1.2 ("2026-08-19T00:00:00Z").
            date_from: `${startIso.slice(0, 10)}T00:00:00Z`,
            // DATA-CONTRACT.md §1.2: exactly one of as_of_date / as_of_ts is required.
            as_of_date: endIso.slice(0, 10),
            timeframe: '5m' as const,
          };
          const ohlcvRes = await fetchHistoricalOhlcv(ohlcvRequest, budget);

          const candles = ohlcvRes.data.data ?? [];

          // Exact equality matching on interval_start for 5m candle
          const entryCandle = candles.find((c) => c.interval_start === startIso);
          const exitCandle = candles.find((c) => c.interval_start === endIso);

          if (!entryCandle || entryCandle.open === null || !Number.isFinite(entryCandle.open) || entryCandle.open <= 0 ||
              !exitCandle || exitCandle.open === null || !Number.isFinite(exitCandle.open) || exitCandle.open <= 0) {
            if (isTimedOut) {
              await client.query(
                `UPDATE rounds SET status = 'invalid', invalid_reason = 'exact_candle_unavailable_after_6h' WHERE id = $1`,
                [roundId],
              );
              return {
                ok: false,
                error: 'round_invalidated',
                reason: 'exact_candle_unavailable_after_6h',
                nansen: budget.summary(),
              };
            }
            await client.query(`UPDATE rounds SET status = 'resolving' WHERE id = $1`, [roundId]);
            // A truncated window will not grow on retry: stop and investigate instead.
            return {
              ok: false,
              error: ohlcvRes.data.truncated ? 'ohlcv_response_truncated' : 'market_data_pending',
              reason: `Exact 5m candle (${startIso} / ${endIso}) not ${
                ohlcvRes.data.truncated ? 'in truncated response' : 'yet available'
              } for ${row.token_symbol}`,
              retryUntil: retryDeadline,
              nansen: budget.summary(),
            };
          }

          const entryPrice = entryCandle.open;
          const exitPrice = exitCandle.open;
          const returnRatio = computeReturn(entryPrice, exitPrice);

          resolvedAssets.push({
            slot: row.slot as Slot,
            tokenSymbol: row.token_symbol,
            tokenAddress: row.token_address,
            entryCandleStart: entryCandle.interval_start,
            entryPrice,
            exitCandleStart: exitCandle.interval_start,
            exitPrice,
            returnRatio,
            sourceResponseSha256: {
              ohlcv: ohlcvRes.meta.responseSha256,
            },
          });

          // Log source receipt for this resolution call
          await client.query(
            `INSERT INTO source_receipts (
               round_id, endpoint, request_params, retrieved_at, response_sha256, schema_version, purpose,
               request_id, credits_used
             ) VALUES ($1, $2, $3, $4, $5, 1, 'resolution', $6, $7)`,
            [
              roundId,
              ohlcvRes.meta.endpoint,
              JSON.stringify(ohlcvRequest),
              ohlcvRes.meta.retrievedAt,
              ohlcvRes.meta.responseSha256,
              ohlcvRes.meta.requestId,
              ohlcvRes.meta.creditsUsed,
            ],
          );
        }
      } catch (err) {
        if (isTimedOut) {
          await client.query(
            `UPDATE rounds SET status = 'invalid', invalid_reason = 'market_data_fetch_failed' WHERE id = $1`,
            [roundId],
          );
          return { ok: false, error: 'round_invalidated', reason: 'market_data_fetch_failed', nansen: budget.summary() };
        }
        await client.query(`UPDATE rounds SET status = 'resolving' WHERE id = $1`, [roundId]);
        return {
          ok: false,
          error: nansenFailureCode(err) ?? 'market_data_pending',
          reason: err instanceof Error ? err.message : 'Nansen fetch pending',
          retryUntil: retryDeadline,
          nansen: budget.summary(),
        };
      }
      resolvedNansen = budget.summary();
    }

    // Update round_assets
    for (const a of resolvedAssets) {
      await client.query(
        `UPDATE round_assets SET
           entry_candle_start = $2,
           entry_price = $3,
           exit_candle_start = $4,
           exit_price = $5,
           return_ratio = $6,
           source_response_sha256 = $7
         WHERE round_id = $1 AND slot = $8`,
        [
          roundId,
          a.entryCandleStart,
          a.entryPrice,
          a.exitCandleStart,
          a.exitPrice,
          a.returnRatio,
          JSON.stringify(a.sourceResponseSha256),
          a.slot,
        ],
      );
    }

    const resolutionManifest = buildLiveResolutionManifest({
      roundId,
      initialCommitmentHash: round.initial_commitment_hash,
      measurementStartAt: measurementStartAt.toISOString(),
      measurementEndAt: measurementEndAt.toISOString(),
      resolutionTime: now.toISOString(),
      assets: resolvedAssets,
    });

    const resNonce = generateNonce();
    const resCommitmentHash = computeCommitment(resolutionManifest, resNonce);

    await client.query(
      `UPDATE rounds SET
         status = 'resolved',
         resolution_manifest = $2,
         resolution_commitment_hash = $3,
         resolution_nonce = $4
       WHERE id = $1`,
      [roundId, JSON.stringify(resolutionManifest), resCommitmentHash, resNonce],
    );

    return {
      ok: true,
      roundId,
      manifest: resolutionManifest,
      ...(resolvedNansen ? { nansen: resolvedNansen } : {}),
    };
  });
}
