/**
 * Offline, leak-free rebuild of a stored Replay round (docs/NANSEN-CONTRACT-AUDIT.md, F1).
 *
 * The historical screener's `to_date = D` reflects the market around D 12:00 UTC, so a
 * round with its entry at D 00:00 leaked about 12 hours of its outcome window into its
 * clues. The ancestor's preserved responses support a leak-free descendant: keep the
 * clue snapshot (`to_date = D`) and move the cutoff to D+1 00:00 UTC, with the outcome
 * window [D+1 00:00, D+8 00:00] read from the SAME preserved hourly candles. That is
 * exactly Round Forge v4's rule (`to_date = cutoff − 1 day`).
 *
 * - Zero Nansen calls: every input is a preserved, authenticated response in
 *   `.nansen-raw/`, re-hashed and matched to the ancestor's receipts (request ID,
 *   endpoint, request body, SHA-256) before use. Anything that does not match fails closed.
 * - The current eligibility policy is applied without exceptions, and the selection must
 *   reproduce the ancestor's three tokens (no other token has preserved candles).
 * - The descendant is a NEW round: new id, manifest, nonce and commitment, `rebuilt_from`
 *   pointing at the ancestor, and status `pending_review`. The ancestor is not modified.
 *
 * Reads the ancestor from `public` (read-only) and inserts into the schema selected by
 * DB_SCHEMA (production when unset). Dry run by default; `--confirm` inserts.
 *
 * Usage: npm run rebuild:round -- --from <uuid> [--out plan.json] [--confirm]
 */
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dbSchema, getPool, withTransaction } from '../src/lib/db';
import { determineWinningSlots, computeReturn, type Slot } from '../src/lib/domain/returns';
import { HISTORICAL_OHLCV_PATH, HISTORICAL_SCREENER_PATH, type HistoricalScreenerRow, type OhlcvCandle } from '../src/lib/nansen/client';
import { historicalOhlcvResponseSchema, historicalScreenerResponseSchema } from '../src/lib/nansen/contracts';
import { insertVerifiedRound, type VerifiedRound } from '../src/lib/repo/verifiedRoundImport';
import {
  boundaryClose,
  policyForCutoff,
  REPLAY_FORGE_VERSION,
  REPLAY_HORIZON_DAYS,
  selectReplayCandidates,
  validateOutcomeWindow,
  type GeneratedReceipt,
} from '../src/lib/services/replayForge';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const RAW_DIR = '.nansen-raw';

interface RawEntry {
  operation: string;
  endpoint: string;
  requestBody: Record<string, unknown>;
  status: number;
  requestId: string | null;
  retrievedAt: string;
  responseSha256: string;
  body: string;
}

interface AncestorReceipt {
  endpoint: string;
  purpose: string | null;
  request_params: Record<string, unknown>;
  response_sha256: string;
  request_id: string | null;
  retrieved_at: Date;
  credits_used: number | null;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0) return process.argv[i + 1];
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
}

function canonical(value: unknown): string {
  const sort = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sort)
      : v && typeof v === 'object'
        ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sort((v as Record<string, unknown>)[k])]))
        : v;
  return JSON.stringify(sort(value));
}

function fail(message: string): never {
  throw new Error(`FAIL CLOSED: ${message}`);
}

/** The preserved response for one ancestor receipt, re-hashed and matched field by field. */
function preservedResponse(raw: RawEntry[], receipt: AncestorReceipt): RawEntry {
  if (!receipt.request_id) fail(`receipt ${receipt.purpose} has no request ID`);
  const matches = raw.filter((r) => r.requestId === receipt.request_id);
  if (matches.length !== 1) fail(`expected exactly one preserved response for request ${receipt.request_id}, found ${matches.length}`);
  const entry = matches[0]!;
  const sha = createHash('sha256').update(entry.body, 'utf8').digest('hex');
  if (sha !== entry.responseSha256) fail(`preserved body for ${receipt.request_id} does not re-hash to its recorded SHA-256`);
  if (sha !== receipt.response_sha256) fail(`preserved body for ${receipt.request_id} does not match the ancestor's receipt hash`);
  if (entry.endpoint !== receipt.endpoint) fail(`endpoint mismatch for ${receipt.request_id}`);
  if (canonical(entry.requestBody) !== canonical(receipt.request_params)) fail(`request body mismatch for ${receipt.request_id}`);
  if (entry.status !== 200) fail(`preserved response ${receipt.request_id} has HTTP ${entry.status}`);
  return entry;
}

async function main() {
  const confirm = process.argv.includes('--confirm');
  const fromId = arg('from');
  if (!fromId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(fromId)) {
    throw new Error('--from <ancestor round uuid> is required');
  }
  const pool = getPool();

  // --- Ancestor (read-only, always from production's public schema) ---
  const anc = await pool.query<{ id: string; mode: string; status: string; cutoff: Date; initial_commitment_hash: string }>(
    `SELECT id, mode, status, cutoff, initial_commitment_hash FROM public.rounds WHERE id = $1`,
    [fromId],
  );
  const ancestor = anc.rows[0] ?? fail(`ancestor ${fromId} not found in public.rounds`);
  if (ancestor.mode !== 'replay') fail(`ancestor is ${ancestor.mode}, not replay`);
  const D = new Date(ancestor.cutoff);
  if (D.getTime() % DAY_MS !== 0) fail(`ancestor cutoff ${D.toISOString()} is not 00:00 UTC`);
  const ancestorAssets = (
    await pool.query<{ slot: string; token_address: string; token_symbol: string }>(
      `SELECT slot, token_address, token_symbol FROM public.round_assets WHERE round_id = $1 ORDER BY slot`,
      [fromId],
    )
  ).rows;
  const receipts = (
    await pool.query<AncestorReceipt>(
      `SELECT endpoint, purpose, request_params, response_sha256, request_id, retrieved_at, credits_used
       FROM public.source_receipts WHERE round_id = $1 ORDER BY retrieved_at, purpose`,
      [fromId],
    )
  ).rows;
  if (receipts.length !== 5) fail(`ancestor has ${receipts.length} receipts; a forge round has exactly 5`);

  // --- Preserved responses, matched to every receipt ---
  const raw: RawEntry[] = readdirSync(RAW_DIR).map((f) => JSON.parse(readFileSync(join(RAW_DIR, f), 'utf8')) as RawEntry);
  const screener = receipts.filter((r) => r.endpoint === HISTORICAL_SCREENER_PATH);
  const ohlcv = receipts.filter((r) => r.endpoint === HISTORICAL_OHLCV_PATH);
  if (screener.length !== 2 || ohlcv.length !== 3) fail('ancestor receipts are not 2 screener + 3 OHLCV');

  const toDate = D.toISOString().slice(0, 10);
  const byWindow = new Map<number, RawEntry>();
  for (const r of screener) {
    const entry = preservedResponse(raw, r);
    if (entry.requestBody.to_date !== toDate) fail(`screener to_date ${String(entry.requestBody.to_date)} is not ${toDate}`);
    byWindow.set(Number(entry.requestBody.timeframe_days), entry);
  }
  const s7 = byWindow.get(7) ?? fail('no preserved 7-day screener response');
  const s1 = byWindow.get(1) ?? fail('no preserved 1-day screener response');
  const res7 = historicalScreenerResponseSchema.parse(JSON.parse(s7.body)) as { data: HistoricalScreenerRow[]; pagination: { is_last_page: boolean } };
  const res1 = historicalScreenerResponseSchema.parse(JSON.parse(s1.body)) as { data: HistoricalScreenerRow[] };

  // --- New, leak-free schedule ---
  const cutoff = new Date(D.getTime() + DAY_MS); // D+1 00:00 UTC: after the whole to_date = D snapshot day
  const resolution = new Date(cutoff.getTime() + REPLAY_HORIZON_DAYS * DAY_MS);
  const entryStart = new Date(cutoff.getTime() - HOUR_MS);
  const exitStart = new Date(resolution.getTime() - HOUR_MS);

  // The current policy, with the market-cap band exactly as the preserved request asked for it.
  const requestedBand = (s1.requestBody.filters as { market_cap_usd?: { min?: number; max?: number } } | undefined)?.market_cap_usd;
  if (typeof requestedBand?.min !== 'number' || typeof requestedBand?.max !== 'number') fail('preserved request has no market-cap band');
  const base = policyForCutoff(cutoff);
  const policy = {
    ...base,
    market_cap_usd_band: [requestedBand.min, requestedBand.max] as [number, number],
    market_cap_usd_band_source: `the preserved to_date=${toDate} request (the band rotation is keyed to the ancestor's cutoff)`,
    rebuild: {
      ancestor_round_id: fromId,
      reason: 'F1: the historical screener to_date = D reads about D 12:00 UTC; the ancestor entered at D 00:00',
      clue_snapshot: `historical screener to_date=${toDate} (preserved responses, anchored before ${cutoff.toISOString()})`,
    },
  };
  for (const [label, got, want] of [
    ['liquidity_usd.min', (s1.requestBody.filters as any)?.liquidity_usd?.min, policy.liquidity_usd_min],
    ['token_age_days.min', (s1.requestBody.filters as any)?.token_age_days?.min, policy.token_age_days_min],
    ['exclude_sectors', canonical(s1.requestBody.exclude_sectors), canonical(policy.exclude_sectors)],
  ] as const) {
    if (got !== want) fail(`preserved request ${label} (${String(got)}) differs from the current policy (${String(want)})`);
  }

  // --- Candidate selection under the current policy, on the preserved rows ---
  // Token reuse (±reuse_window_days) is judged against the catalog as it stood when these
  // responses were acquired, exactly as the generator did. It can only remove candidates.
  // The near-duplicate rule applies among retained (approved) rounds and is checked at review.
  const reuse = await pool.query<{ token_address: string }>(
    `SELECT DISTINCT ra.token_address FROM public.rounds r JOIN public.round_assets ra ON ra.round_id = r.id
     WHERE r.mode IN ('replay', 'daily') AND r.id <> $1
       AND r.created_at < (SELECT created_at FROM public.rounds WHERE id = $1)
       AND abs(extract(epoch FROM (r.cutoff - $2::timestamptz))) <= $3 * 86400`,
    [fromId, cutoff.toISOString(), policy.reuse_window_days],
  );
  const excluded = new Set(reuse.rows.map((r) => r.token_address));
  Object.assign(policy, {
    reuse_exclusion_catalog: `rounds that existed when the preserved responses were acquired (${excluded.size} token(s) within ±${policy.reuse_window_days} days)`,
    near_duplicate_scope: 'retained (approved) rounds',
  });
  const candidates = selectReplayCandidates(res7.data, res1.data, policy, excluded, [], res7.pagination.is_last_page !== false);
  const selected = candidates.map((c) => c.address).sort();
  const original = ancestorAssets.map((a) => a.token_address).sort();
  if (canonical(selected) !== canonical(original)) {
    fail(`the current policy selects ${candidates.map((c) => c.symbol).join('/')} — not the ancestor's tokens, and only the ancestor's tokens have preserved candles`);
  }

  // --- Outcome from the preserved candles ---
  const outReceipts: GeneratedReceipt[] = [
    ...[s7, s1].map((e) => {
      const r = screener.find((x) => x.request_id === e.requestId)!;
      return {
        endpoint: e.endpoint,
        purpose: r.purpose ?? `replay_discovery_${e.requestBody.timeframe_days}d`,
        requestParams: e.requestBody,
        responseSha256: e.responseSha256,
        retrievedAt: e.retrievedAt,
        requestId: e.requestId,
        creditsUsed: r.credits_used,
      };
    }),
  ];
  const assets: VerifiedRound['assets'] = [];
  for (const c of candidates) {
    const r = ohlcv.find((x) => (x.request_params as { token_address?: string }).token_address === c.address) ?? fail(`no OHLCV receipt for ${c.symbol}`);
    const entry = preservedResponse(raw, r);
    const res = historicalOhlcvResponseSchema.parse(JSON.parse(entry.body)) as { data: OhlcvCandle[]; truncated: boolean };
    if (res.truncated) fail(`preserved OHLCV for ${c.symbol} is truncated`);
    const entryClose = boundaryClose(res.data, entryStart, c.symbol);
    const exitClose = boundaryClose(res.data, exitStart, c.symbol);
    validateOutcomeWindow(res.data, entryStart, exitStart, c.symbol);
    outReceipts.push({
      endpoint: entry.endpoint,
      purpose: `replay_outcome_${c.slot}`,
      requestParams: entry.requestBody,
      responseSha256: entry.responseSha256,
      retrievedAt: entry.retrievedAt,
      requestId: entry.requestId,
      creditsUsed: r.credits_used,
    });
    assets.push({
      slot: c.slot,
      token_symbol: c.symbol,
      token_address: c.address,
      sectors: c.sectors,
      clue_inputs: c.clueInputs,
      clues: c.clues,
      price: {
        entry_candle_start: entryStart.toISOString(),
        entry_close: entryClose,
        exit_candle_start: exitStart.toISOString(),
        exit_close: exitClose,
      },
      return: computeReturn(entryClose, exitClose),
      source_response_sha256: { discovery_7d: s7.responseSha256, discovery_1d: s1.responseSha256, ohlcv: entry.responseSha256 },
    });
  }
  const returns = Object.fromEntries(assets.map((a) => [a.slot, a.return])) as Record<Slot, number>;
  const winners = determineWinningSlots(returns);
  const day = cutoff.toISOString().slice(0, 10);
  const round: VerifiedRound = {
    round_id: `rebuild-v${REPLAY_FORGE_VERSION}-${day}-from-${fromId}`,
    mode: 'replay',
    chain: policy.chain,
    cutoff: cutoff.toISOString(),
    horizon_days: REPLAY_HORIZON_DAYS,
    candle_interval: '1h',
    resolution_time: resolution.toISOString(),
    round_forge_version: REPLAY_FORGE_VERSION,
    clue_schema_version: 1,
    price_policy_version: 1,
    eligibility_policy: policy,
    assets,
    winner_slot: winners.join(','),
    provenance: {
      generated_by: 'npm run rebuild:round (offline, zero Nansen calls)',
      data_source: 'Nansen API (preserved authenticated responses)',
      rebuilt_from: fromId,
      rebuilt_from_commitment: ancestor.initial_commitment_hash,
      requests: outReceipts.map((r) => ({
        purpose: r.purpose,
        endpoint: r.endpoint,
        request_id: r.requestId,
        response_sha256: r.responseSha256,
        credits_used: r.creditsUsed,
        retrieved_at: r.retrievedAt,
      })),
    },
  };

  console.log(`Rebuild plan for ${fromId} (target schema ${dbSchema() ?? 'public'})`);
  console.log(`  clue snapshot: to_date=${toDate}; new cutoff ${cutoff.toISOString()}; outcome ${cutoff.toISOString()} → ${resolution.toISOString()}`);
  for (const a of assets) {
    console.log(
      `  ${a.slot} ${a.token_symbol.padEnd(11)} sectors=[${a.sectors.join(', ')}] entry=${a.price.entry_close} exit=${a.price.exit_close} return=${(a.return * 100).toFixed(4)}%`,
    );
  }
  console.log(`  winner: ${winners.join(', ')}; receipts: ${outReceipts.length} preserved responses; Nansen calls: 0`);
  const out = arg('out');
  if (out) writeFileSync(out, JSON.stringify({ round, receipts: outReceipts }, null, 2));

  if (!confirm) {
    console.log('\nDry run: nothing written. Re-run with --confirm to insert the descendant (pending_review).');
    return;
  }
  const inserted = await withTransaction(async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('trench_trials.replay_catalog'))`);
    const existing = await client.query(`SELECT id FROM rounds WHERE rebuilt_from = $1`, [fromId]);
    if (existing.rowCount) fail(`a descendant of ${fromId} already exists (${existing.rows[0].id})`);
    const { roundId, commitmentHash } = await insertVerifiedRound(client, round, { receipts: outReceipts });
    await client.query(`UPDATE rounds SET rebuilt_from = $2 WHERE id = $1`, [roundId, fromId]);
    return { roundId, commitmentHash };
  });
  console.log(`\nInserted ${inserted.roundId} (commitment ${inserted.commitmentHash}), pending_review, rebuilt_from ${fromId}.`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => getPool().end());
