/**
 * Exports an approved round as a redistribution-safe bundle under data/verified-rounds/, so
 * a fresh clone can play it without a Nansen key (npm run setup:demo).
 *
 * A bundle holds only what the round itself publishes at its verdict: the derived round
 * manifest (tokens, clue inputs and buckets, boundary prices, returns, winner, policy) and
 * provenance metadata (endpoints, our request bodies, Nansen request IDs, response SHA-256
 * hashes, credits, times). Raw Nansen response bodies are never included. Read-only.
 *
 * Usage: npm run export:bundle -- --round <uuid> --out data/verified-rounds/<name>.json
 */
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { writeFileSync } from 'node:fs';
import { getPool } from '../src/lib/db';
import { isPlayerFacing } from '../src/lib/domain/eligibility';
import type { VerifiedRound } from '../src/lib/repo/verifiedRoundImport';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

interface ManifestAsset {
  slot: 'A' | 'B' | 'C';
  token_symbol: string;
  token_address: string;
  sectors: string[];
  clue_inputs: Record<string, number>;
  clues: Record<string, { value: number; bucket: string }>;
  entry_candle_start: string;
  entry_price: number;
  exit_candle_start: string;
  exit_price: number;
  return_ratio: number;
  source_response_sha256: Record<string, string>;
}

async function main() {
  const roundId = arg('round');
  const out = arg('out');
  if (!roundId || !/^[0-9a-f-]{36}$/i.test(roundId)) throw new Error('--round <uuid> is required');
  if (!out || !/^data\/verified-rounds\/[a-z0-9-]+\.json$/.test(out)) throw new Error('--out data/verified-rounds/<name>.json is required');

  const pool = getPool();
  const r = (
    await pool.query<{
      id: string;
      mode: string;
      status: string;
      initial_manifest: Record<string, unknown> & { assets: ManifestAsset[] };
      initial_commitment_hash: string;
      eligibility_status: string;
      eligibility_policy_version: number | null;
      rebuilt_from: string | null;
    }>(
      `SELECT id, mode, status, initial_manifest, initial_commitment_hash, eligibility_status,
              eligibility_policy_version, rebuilt_from
       FROM rounds WHERE id = $1`,
      [roundId],
    )
  ).rows[0];
  if (!r) throw new Error(`Round ${roundId} not found`);
  if (r.mode !== 'replay' || !isPlayerFacing(r)) throw new Error('Only approved Replay rounds are exported');

  const m = r.initial_manifest as Record<string, any>;
  const round: VerifiedRound = {
    round_id: m.round_id_source,
    mode: 'replay',
    chain: m.chain,
    cutoff: m.cutoff,
    horizon_days: m.horizon_days,
    candle_interval: m.candle_interval,
    resolution_time: m.resolution_time,
    round_forge_version: m.round_forge_version,
    clue_schema_version: m.clue_schema_version,
    price_policy_version: m.price_policy_version,
    eligibility_policy: m.eligibility_policy,
    assets: (m.assets as ManifestAsset[]).map((a) => ({
      slot: a.slot,
      token_symbol: a.token_symbol,
      token_address: a.token_address,
      sectors: a.sectors,
      clue_inputs: a.clue_inputs,
      clues: a.clues,
      price: {
        entry_candle_start: a.entry_candle_start,
        entry_close: a.entry_price,
        exit_candle_start: a.exit_candle_start,
        exit_close: a.exit_price,
      },
      return: a.return_ratio,
      source_response_sha256: a.source_response_sha256,
    })),
    winner_slot: m.winner_slot,
    provenance: m.provenance,
  };

  const receipts = (
    await pool.query<{
      endpoint: string;
      purpose: string;
      request_params: Record<string, unknown>;
      response_sha256: string;
      retrieved_at: Date;
      request_id: string | null;
      credits_used: number | null;
    }>(
      `SELECT endpoint, purpose, request_params, response_sha256, retrieved_at, request_id, credits_used
       FROM source_receipts WHERE round_id = $1 ORDER BY retrieved_at, purpose`,
      [roundId],
    )
  ).rows.map((x) => ({
    endpoint: x.endpoint,
    purpose: x.purpose,
    requestParams: x.request_params,
    responseSha256: x.response_sha256,
    retrievedAt: new Date(x.retrieved_at).toISOString(),
    requestId: x.request_id,
    creditsUsed: x.credits_used,
  }));

  const bundle = {
    format: 'trench-trials.verified-round-bundle/1',
    note:
      'Derived from authenticated Nansen API responses. Raw response bodies are not included; each is identified by its Nansen request ID and SHA-256. Not synthetic.',
    source: {
      round_id: r.id,
      commitment_hash: r.initial_commitment_hash,
      eligibility_policy_version: r.eligibility_policy_version,
      rebuilt_from: r.rebuilt_from,
    },
    round,
    receipts,
  };
  writeFileSync(out, `${JSON.stringify(bundle, null, 2)}\n`);
  console.log(`Wrote ${out}: ${round.assets.map((a) => a.token_symbol).join('/')}, ${receipts.length} receipts, no raw bodies.`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => getPool().end());
