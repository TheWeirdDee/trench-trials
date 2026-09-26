import type { Pool, PoolClient } from 'pg';
import { setRoundEligibility, type EligibilityDecision } from './eligibility';
import { computeCommitment, generateNonce } from '../domain/commitment';

export interface VerifiedRoundAsset {
  slot: 'A' | 'B' | 'C';
  token_symbol: string;
  token_address: string;
  sectors: string[];
  clue_inputs: Record<string, number>;
  clues: Record<string, { value: number; bucket: string }>;
  price: {
    entry_candle_start: string;
    entry_close: number;
    exit_candle_start: string;
    exit_close: number;
  };
  return: number;
  source_response_sha256: Record<string, string>;
}

export interface VerifiedRound {
  round_id: string;
  mode: string;
  chain: string;
  cutoff: string;
  horizon_days: number;
  candle_interval: string;
  resolution_time: string;
  round_forge_version: number;
  clue_schema_version: number;
  price_policy_version: number;
  eligibility_policy: unknown;
  assets: VerifiedRoundAsset[];
  winner_slot: string;
  provenance: unknown;
  repeat_of?: string | null;
}

export interface ImportOptions {
  decisionWindowSeconds?: number;
  decisionWindowVersion?: number;
  /**
   * Eligibility recorded with the round. Omitted, the round is `pending_review` and not
   * player-facing until reviewed (scripts/review-round.ts).
   */
  eligibility?: EligibilityDecision;
  /**
   * One receipt per Nansen response the round was built from, with its request, request
   * ID and credits. When given, these are stored instead of the per-asset hash labels.
   */
  receipts?: Array<{
    endpoint: string;
    purpose: string;
    requestParams: Record<string, unknown>;
    responseSha256: string;
    retrievedAt: string;
    requestId: string | null;
    creditsUsed: number | null;
  }>;
}

/**
 * Persists a round already generated from real, authenticated Nansen responses (or,
 * for tests only, a clearly-labeled synthetic fixture — see tests/integration/fixtures.ts)
 * as a playable round. Performs zero Nansen API calls.
 */
export async function insertVerifiedRound(
  pool: Pool | PoolClient,
  round: VerifiedRound,
  options: ImportOptions = {},
): Promise<{ roundId: string; commitmentHash: string }> {
  const decisionWindowSeconds = options.decisionWindowSeconds ?? 15;
  const decisionWindowVersion = options.decisionWindowVersion ?? 1;

  const manifest = {
    round_id_source: round.round_id,
    chain: round.chain,
    cutoff: round.cutoff,
    horizon_days: round.horizon_days,
    candle_interval: round.candle_interval,
    resolution_time: round.resolution_time,
    round_forge_version: round.round_forge_version,
    clue_schema_version: round.clue_schema_version,
    price_policy_version: round.price_policy_version,
    eligibility_policy: round.eligibility_policy,
    assets: round.assets.map((a) => ({
      slot: a.slot,
      token_symbol: a.token_symbol,
      token_address: a.token_address,
      sectors: a.sectors,
      clue_inputs: a.clue_inputs,
      clues: a.clues,
      entry_candle_start: a.price.entry_candle_start,
      entry_price: a.price.entry_close,
      exit_candle_start: a.price.exit_candle_start,
      exit_price: a.price.exit_close,
      return_ratio: a.return,
      source_response_sha256: a.source_response_sha256,
    })),
    winner_slot: round.winner_slot,
    provenance: round.provenance,
  };

  const nonce = generateNonce();
  const commitmentHash = computeCommitment(manifest, nonce);

  const roundResult = await pool.query<{ id: string }>(
    `INSERT INTO rounds (
       mode, chain, status, cutoff, horizon_days, candle_interval, resolution_time,
       round_forge_version, clue_schema_version, price_policy_version,
       decision_window_seconds, decision_window_version,
       initial_manifest, initial_commitment_hash, initial_nonce,
       eligibility_policy, published_at, repeat_of
     ) VALUES (
       $1, $2, 'ready', $3, $4, $5, $6,
       $7, $8, $9,
       $10, $11,
       $12, $13, $14,
       $15, now(), $16
     )
     RETURNING id`,
    [
      round.mode,
      round.chain,
      round.cutoff,
      round.horizon_days,
      round.candle_interval,
      round.resolution_time,
      round.round_forge_version,
      round.clue_schema_version,
      round.price_policy_version,
      decisionWindowSeconds,
      decisionWindowVersion,
      JSON.stringify(manifest),
      commitmentHash,
      nonce,
      JSON.stringify(round.eligibility_policy),
      round.repeat_of ?? null,
    ],
  );
  const roundIdRow = roundResult.rows[0];
  if (!roundIdRow) throw new Error('Failed to insert round');
  const roundId = roundIdRow.id;

  for (const asset of round.assets) {
    const buySell = asset.clues.buy_sell_balance;
    const accel = asset.clues.trading_acceleration;
    const netflow = asset.clues.netflow_over_liquidity;
    const momentum = asset.clues.recent_momentum;
    if (!buySell || !accel || !netflow || !momentum) {
      throw new Error(`Asset slot ${asset.slot} is missing one or more required clues`);
    }

    await pool.query(
      `INSERT INTO round_assets (
         round_id, slot, token_symbol, token_address, sectors,
         clue_buy_sell_balance, clue_buy_sell_balance_bucket,
         clue_trading_acceleration, clue_trading_acceleration_bucket,
         clue_netflow_over_liquidity, clue_netflow_over_liquidity_bucket,
         clue_recent_momentum, clue_recent_momentum_bucket,
         entry_candle_start, entry_price, exit_candle_start, exit_price, return_ratio,
         source_response_sha256
       ) VALUES ($1,$2,$3,$4,$5, $6,$7, $8,$9, $10,$11, $12,$13, $14,$15,$16,$17,$18, $19)`,
      [
        roundId,
        asset.slot,
        asset.token_symbol,
        asset.token_address,
        asset.sectors,
        buySell.value,
        buySell.bucket,
        accel.value,
        accel.bucket,
        netflow.value,
        netflow.bucket,
        momentum.value,
        momentum.bucket,
        asset.price.entry_candle_start,
        asset.price.entry_close,
        asset.price.exit_candle_start,
        asset.price.exit_close,
        asset.return,
        JSON.stringify(asset.source_response_sha256),
      ],
    );

    if (options.receipts) continue;
    for (const [callLabel, hash] of Object.entries(asset.source_response_sha256)) {
      await pool.query(
        `INSERT INTO source_receipts (round_id, endpoint, request_params, retrieved_at, response_sha256, schema_version)
         VALUES ($1, $2, $3, $4, $5, 1)`,
        [
          roundId,
          callLabel,
          JSON.stringify({ slot: asset.slot, token_address: asset.token_address }),
          (round.provenance as { retrieved_at_utc?: string } | undefined)?.retrieved_at_utc?.split(
            '_to_',
          )[0] ?? new Date().toISOString(),
          hash,
        ],
      );
    }
  }

  for (const r of options.receipts ?? []) {
    await pool.query(
      `INSERT INTO source_receipts (
         round_id, endpoint, request_params, retrieved_at, response_sha256, schema_version, purpose,
         request_id, credits_used
       ) VALUES ($1, $2, $3, $4, $5, 1, $6, $7, $8)`,
      [roundId, r.endpoint, JSON.stringify(r.requestParams), r.retrievedAt, r.responseSha256, r.purpose, r.requestId, r.creditsUsed],
    );
  }

  if (options.eligibility) await setRoundEligibility(pool, roundId, options.eligibility);

  return { roundId, commitmentHash };
}
