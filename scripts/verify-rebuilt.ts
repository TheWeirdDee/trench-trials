/**
 * npm run verify:rebuilt
 *
 * Independent verification of rounds rebuilt offline (scripts/rebuild-round.ts). Like
 * scripts/verify.ts it deliberately imports nothing from src/: every formula, list and
 * threshold below is re-implemented from DATA-CONTRACT.md and the audit, so a defect in
 * the production code cannot verify itself.
 *
 * From the preserved responses in `.nansen-raw/` it re-checks, per rebuilt round:
 * - every receipt: request ID, endpoint, request body and SHA-256 of the preserved body;
 * - the clue snapshot is `to_date = cutoff − 1 day`, and per token the screener's price
 *   and 1-day change fit the hourly candles best at a time strictly BEFORE the cutoff
 *   (the measured F1 anchoring), so no clue uses outcome-window data;
 * - clue inputs, clue values and buckets; eligibility (symbol, sectors, liquidity,
 *   volume, age, market-cap band); complete candles and no hourly move above 30%;
 * - entry and exit closes, returns and winners;
 * - in database mode: the commitment, the stored assets and receipts, and the lineage.
 *
 * Usage:
 *   npm run verify:rebuilt                     # every round with rebuilt_from set (DB_SCHEMA or public)
 *   npm run verify:rebuilt -- --plan plan.json # a rebuild dry-run plan, before insertion
 */
import { config } from 'dotenv';
config({ path: '.env.local' });

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';

const HOUR = 3_600_000;
const DAY = 86_400_000;
const TIE = 0.0001;
const MAX_HOURLY_MOVE = 0.3;
const MIN_LIQUIDITY = 2_000_000;
const MIN_VOLUME_1D = 100_000;
const MIN_AGE_DAYS = 30;
const EXCLUDED_SYMBOLS = new Set([
  'USDT', 'USDC', 'DAI', 'USDE', 'FDUSD', 'BUSD', 'TUSD', 'PYUSD', 'FRAX', 'LUSD', 'CRVUSD', 'USDS', 'USD1', 'USDY',
  'SYRUPUSDC', 'USDG', 'USDH', 'EURC', 'PAXG', 'XAUT', 'WETH', 'ETH', 'WBTC', 'BTC', 'CBBTC', 'ZBTC', 'TBTC', 'WSOL',
  'SOL', 'ZEC', 'HYPE', 'BNB', 'XRP', 'TRX', 'AVAX', 'LINK', 'UNI', 'AAVE', 'DOGE', 'SUI', 'APT', 'TON', 'ADA', 'DOT',
  'LTC', 'SPX', 'JITOSOL', 'MSOL', 'BSOL', 'JUPSOL', 'INF', 'BNSOL', 'HSOL', 'STSOL', 'DSOL', 'VSOL', 'JLP',
]);
const EXCLUDED_SECTORS = new Set(['Stablecoin', 'Tokenized Stocks', 'Yield Bearing', 'Liquid Staking', 'RWAs']);
const ALLOWED_SECTORS = new Set([
  'Memecoins', 'Artificial Intelligence', 'AI Agents', 'Decentralised Exchanges', 'GameFi', 'Scaling & Connectivity',
  'Perps, Options and Derivatives',
]);

let checks = 0;
let failures = 0;
function check(ok: boolean, message: string): void {
  checks++;
  if (!ok) {
    failures++;
    console.error(`FAIL: ${message}`);
  }
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
const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

interface Raw { endpoint: string; requestBody: any; requestId: string | null; responseSha256: string; body: string; status: number }
interface Receipt { endpoint: string; purpose: string; requestParams: any; responseSha256: string; requestId: string | null }
interface Asset {
  slot: string; token_symbol: string; token_address: string; sectors: string[];
  clue_inputs: Record<string, number>; clues: Record<string, { value: number; bucket: string }>;
  price: { entry_candle_start: string; entry_close: number; exit_candle_start: string; exit_close: number };
  return: number;
}
interface RoundLike { cutoff: string; resolution_time: string; winner_slot: string; eligibility_policy: any; assets: Asset[]; provenance: any }

const raw: Raw[] = readdirSync('.nansen-raw').map((f) => JSON.parse(readFileSync(join('.nansen-raw', f), 'utf8')));

function bucket(v: number, lo: number, hi: number, names: [string, string, string]): string {
  return v < lo ? names[0] : v > hi ? names[2] : names[1];
}

function verifyRound(label: string, round: RoundLike, receipts: Receipt[]): void {
  const cutoff = Date.parse(round.cutoff);
  const resolution = Date.parse(round.resolution_time);
  check(cutoff % DAY === 0, `${label}: cutoff ${round.cutoff} is not 00:00 UTC`);
  check(resolution - cutoff === 7 * DAY, `${label}: horizon is not 7 days`);
  const snapshotDate = new Date(cutoff - DAY).toISOString().slice(0, 10);

  // Receipts ↔ preserved bodies
  const bodies = new Map<string, Raw>();
  check(receipts.length === 5, `${label}: expected 5 receipts, got ${receipts.length}`);
  for (const r of receipts) {
    const m = raw.filter((x) => x.requestId !== null && x.requestId === r.requestId);
    check(m.length === 1, `${label}: request ${r.requestId} has ${m.length} preserved responses`);
    const e = m[0];
    if (!e) continue;
    check(sha256(e.body) === e.responseSha256, `${label}: preserved body ${r.requestId} does not re-hash`);
    check(e.responseSha256 === r.responseSha256, `${label}: receipt hash differs for ${r.requestId}`);
    check(e.endpoint === r.endpoint, `${label}: endpoint differs for ${r.requestId}`);
    check(canonical(e.requestBody) === canonical(r.requestParams), `${label}: request body differs for ${r.requestId}`);
    check(e.status === 200, `${label}: preserved status ${e.status} for ${r.requestId}`);
    bodies.set(r.requestId!, e);
  }
  const screeners = receipts.filter((r) => r.endpoint.endsWith('/token-screener/historical')).map((r) => bodies.get(r.requestId!)!).filter(Boolean);
  const d7 = screeners.find((s) => s.requestBody.timeframe_days === 7);
  const d1 = screeners.find((s) => s.requestBody.timeframe_days === 1);
  check(Boolean(d7 && d1), `${label}: both screener windows must be preserved`);
  if (!d7 || !d1) return;
  for (const s of [d7, d1]) check(s.requestBody.to_date === snapshotDate, `${label}: screener to_date ${s.requestBody.to_date} is not cutoff − 1 day (${snapshotDate})`);
  const rows7 = JSON.parse(d7.body).data as any[];
  const rows1 = JSON.parse(d1.body).data as any[];
  const band = d1.requestBody.filters?.market_cap_usd ?? {};

  const returns: Record<string, number> = {};
  const series: Array<{ closeAt: Map<number, number>; price: number; change: number | null }> = [];
  for (const a of round.assets) {
    const r1 = rows1.find((x) => x.token_address === a.token_address);
    const r7 = rows7.find((x) => x.token_address === a.token_address);
    check(Boolean(r1 && r7), `${label} ${a.token_symbol}: missing from a preserved screener window`);
    if (!r1 || !r7) continue;

    // Eligibility, independently
    const sym = String(r1.token_symbol).toUpperCase();
    const tags: string[] = r1.sectors ?? [];
    check(!EXCLUDED_SYMBOLS.has(sym), `${label} ${sym}: excluded symbol`);
    check(!tags.some((t) => EXCLUDED_SECTORS.has(t)), `${label} ${sym}: excluded sector tag (${tags.join(', ')})`);
    check(tags.some((t) => ALLOWED_SECTORS.has(t)), `${label} ${sym}: not positively classified (${tags.join(', ') || 'no tag'})`);
    check(canonical(a.sectors) === canonical(tags), `${label} ${sym}: stored sectors differ from the preserved row`);
    check(r1.liquidity >= MIN_LIQUIDITY, `${label} ${sym}: liquidity ${r1.liquidity} below floor`);
    check(r1.volume >= MIN_VOLUME_1D, `${label} ${sym}: 24h volume ${r1.volume} below $100K`);
    check(r1.token_age_days >= MIN_AGE_DAYS, `${label} ${sym}: token age below 30 days`);
    check(r1.market_cap_usd >= band.min && r1.market_cap_usd <= band.max, `${label} ${sym}: market cap outside the requested band`);

    // Clues, independently
    const inputs = {
      buy_volume_1d: r1.buy_volume, sell_volume_1d: r1.sell_volume, volume_1d: r1.volume, volume_7d: r7.volume,
      netflow_1d: r1.netflow, liquidity_usd: r1.liquidity, price_change_7d: r7.price_change,
    };
    for (const [k, v] of Object.entries(inputs)) check(a.clue_inputs[k] === v, `${label} ${sym}: clue input ${k} differs from the preserved row`);
    const bs = (r1.buy_volume - r1.sell_volume) / (r1.buy_volume + r1.sell_volume);
    const acc = r1.volume / (r7.volume / 7);
    const nf = r1.netflow / r1.liquidity;
    const mom = r7.price_change;
    const expect: Record<string, [number, string]> = {
      buy_sell_balance: [bs, bucket(bs, -0.1, 0.1, ['sell-heavy', 'balanced', 'buy-heavy'])],
      trading_acceleration: [acc, bucket(acc, 0.75, 1.25, ['slowing', 'steady', 'accelerating'])],
      netflow_over_liquidity: [nf, bucket(nf, -0.05, 0.05, ['outward', 'balanced', 'inward'])],
      recent_momentum: [mom, bucket(mom, -0.05, 0.05, ['falling', 'flat', 'rising'])],
    };
    for (const [k, [v, b]] of Object.entries(expect)) {
      check(Math.abs((a.clues[k]?.value ?? NaN) - v) < 1e-12, `${label} ${sym}: clue ${k} value differs`);
      check(a.clues[k]?.bucket === b, `${label} ${sym}: clue ${k} bucket ${a.clues[k]?.bucket} ≠ ${b}`);
    }

    // Candles
    const oReceipt = receipts.find((r) => r.endpoint.endsWith('/historical-token-ohlcv') && r.requestParams.token_address === a.token_address);
    const o = oReceipt ? bodies.get(oReceipt.requestId!) : undefined;
    check(Boolean(o), `${label} ${sym}: no preserved OHLCV`);
    if (!o) continue;
    const ob = JSON.parse(o.body);
    check(ob.truncated === false, `${label} ${sym}: OHLCV truncated`);
    const closeAt = new Map<number, number>(); // candle CLOSE time → close
    for (const c of ob.data) if (typeof c.close === 'number') closeAt.set(Date.parse(c.interval_start) + HOUR, c.close);
    const entry = closeAt.get(cutoff);
    const exit = closeAt.get(resolution);
    check(a.price.entry_candle_start === new Date(cutoff - HOUR).toISOString(), `${label} ${sym}: entry candle is not the one closing at the cutoff`);
    check(a.price.exit_candle_start === new Date(resolution - HOUR).toISOString(), `${label} ${sym}: exit candle is not the one closing at resolution`);
    check(entry === a.price.entry_close, `${label} ${sym}: entry close ${a.price.entry_close} ≠ preserved ${entry}`);
    check(exit === a.price.exit_close, `${label} ${sym}: exit close ${a.price.exit_close} ≠ preserved ${exit}`);
    let prev: number | null = null;
    let worst = 0;
    for (let t = cutoff; t <= resolution; t += HOUR) {
      const c = closeAt.get(t);
      check(typeof c === 'number' && c > 0, `${label} ${sym}: missing close at ${new Date(t).toISOString()}`);
      if (typeof c !== 'number') continue;
      if (prev !== null) worst = Math.max(worst, Math.abs(c / prev - 1));
      prev = c;
    }
    check(worst <= MAX_HOURLY_MOVE, `${label} ${sym}: hourly move ${(worst * 100).toFixed(1)}% above 30%`);
    if (typeof entry === 'number' && typeof exit === 'number') {
      const ret = exit / entry - 1;
      check(Math.abs(ret - a.return) < 1e-12, `${label} ${sym}: return ${a.return} ≠ recomputed ${ret}`);
      returns[a.slot] = ret;
    }

    series.push({ closeAt, price: r1.price_usd, change: r1.price_change });
    console.log(`  ${label} ${sym.padEnd(11)} tags=[${tags.join(', ')}] 24h vol $${Math.round(r1.volume).toLocaleString('en-US')}; worst hourly move ${(worst * 100).toFixed(1)}%`);
  }

  // Anchoring proof. Every row of one screener response shares one snapshot time, so it is
  // estimated jointly: the hour whose candle closes best explain the rows' price level and
  // 1-day change. Both estimates must fall strictly BEFORE the cutoff (the entry price).
  const fit = (err: (c: Map<number, number>, t: number, s: (typeof series)[number]) => number | null) => {
    let best = { t: 0, err: Infinity };
    let bestAfter = Infinity;
    let hoursBefore = 0;
    for (let t = cutoff - 47 * HOUR; t <= cutoff + DAY; t += HOUR) {
      const errs = series.map((s) => err(s.closeAt, t, s)).filter((e): e is number => e !== null);
      if (errs.length !== series.length || errs.length === 0) continue;
      const mean = errs.reduce((a, b) => a + b, 0) / errs.length;
      if (mean < best.err) best = { t, err: mean };
      if (t >= cutoff) bestAfter = Math.min(bestAfter, mean);
      else hoursBefore++;
    }
    // Evaluable only when the candles cover enough hours before the cutoff to place the
    // snapshot there at all; otherwise the fit can only land after the cutoff by construction.
    return { ...best, bestAfter, evaluable: hoursBefore >= 12 };
  };
  const priceFit = fit((c, t, s) => (typeof c.get(t) === 'number' ? Math.abs(c.get(t)! / s.price - 1) : null));
  const changeFit = fit((c, t, s) => {
    const now = c.get(t);
    const before = c.get(t - DAY);
    return typeof now === 'number' && typeof before === 'number' && typeof s.change === 'number' ? Math.abs(now / before - 1 - s.change) : null;
  });
  const h = (t: number) => `${t < cutoff ? '' : '+'}${((t - cutoff) / HOUR).toFixed(0)}h`;
  console.log(
    `  ${label}: clue snapshot (joint over ${series.length} tokens) — price fits best at cutoff${h(priceFit.t)} (mean err ${(priceFit.err * 100).toFixed(2)}%; best at/after cutoff ${(priceFit.bestAfter * 100).toFixed(2)}%), 1-day change at cutoff${h(changeFit.t)} (mean err ${(changeFit.err * 100).toFixed(2)}pp; best at/after cutoff ${(changeFit.bestAfter * 100).toFixed(2)}pp)`,
  );
  check(priceFit.evaluable, `${label}: too few candles before the cutoff to locate the clue snapshot`);
  check(priceFit.t < cutoff, `${label}: the clue snapshot's price level fits best at or after the cutoff (${h(priceFit.t)})`);
  if (changeFit.evaluable) {
    check(changeFit.t < cutoff, `${label}: the clue snapshot's 1-day change fits best at or after the cutoff (${h(changeFit.t)})`);
  } else {
    console.log(`  ${label}: 1-day change fit not evaluable (candles start less than 48h before the cutoff); leakage rests on to_date = cutoff − 1 day and the price-level fit`);
  }

  const max = Math.max(...Object.values(returns));
  const winners = Object.entries(returns).filter(([, r]) => max - r <= TIE).map(([s]) => s).sort();
  check(winners.join(',') === round.winner_slot, `${label}: winner ${round.winner_slot} ≠ recomputed ${winners.join(',')}`);
  console.log(
    `  ${label}: returns ${Object.entries(returns).map(([s, r]) => `${s} ${(r * 100).toFixed(4)}%`).join(', ')} → winner ${winners.join(',')}`,
  );
}

async function main() {
  const planPath = process.argv.includes('--plan') ? process.argv[process.argv.indexOf('--plan') + 1] : undefined;
  if (planPath) {
    const plan = JSON.parse(readFileSync(planPath, 'utf8')) as { round: RoundLike; receipts: Receipt[] };
    verifyRound(`plan ${plan.round.provenance?.rebuilt_from?.slice(0, 8)}`, plan.round, plan.receipts);
  } else {
    const schema = process.env.DB_SCHEMA;
    if (schema && !/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error('bad DB_SCHEMA');
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ...(schema ? { options: `-c search_path=${schema}` } : {}),
    });
    try {
      // Default: every rebuilt round. --round <id,id,…>: exactly those rounds (e.g. new Round Forge v4 candidates).
      const ids = process.argv.includes('--round') ? process.argv[process.argv.indexOf('--round') + 1]!.split(',') : null;
      if (ids && !ids.every((id) => /^[0-9a-f-]{36}$/i.test(id))) throw new Error('--round expects comma-separated uuids');
      const rounds = await pool.query(
        `SELECT r.*, a.eligibility_status AS ancestor_status FROM rounds r LEFT JOIN rounds a ON a.id = r.rebuilt_from
         WHERE CASE WHEN $1::uuid[] IS NULL THEN r.rebuilt_from IS NOT NULL ELSE r.id = ANY($1::uuid[]) END
         ORDER BY r.cutoff`,
        [ids],
      );
      if (rounds.rowCount === 0) console.log('No matching rounds found.');
      for (const r of rounds.rows) {
        const label = r.id.slice(0, 8);
        const m = r.initial_manifest;
        check(sha256(canonical({ manifest: m, nonce: r.initial_nonce })) === r.initial_commitment_hash, `${label}: commitment mismatch`);
        if (r.rebuilt_from) {
          check(m.provenance?.rebuilt_from === r.rebuilt_from, `${label}: manifest lineage differs from rebuilt_from`);
          check(r.ancestor_status !== 'approved', `${label}: ancestor ${r.rebuilt_from} is still approved`);
        }
        const assets = await pool.query(
          `SELECT slot, token_address, entry_price::text, exit_price::text, return_ratio::text FROM round_assets WHERE round_id = $1 ORDER BY slot`,
          [r.id],
        );
        for (const s of assets.rows) {
          const ma = m.assets.find((x: any) => x.slot === s.slot);
          check(Boolean(ma) && ma.token_address === s.token_address, `${label} ${s.slot}: stored asset differs from the manifest`);
          if (!ma) continue;
          check(Math.abs(Number(s.entry_price) / ma.entry_price - 1) < 1e-12, `${label} ${s.slot}: stored entry differs from the manifest`);
          check(Math.abs(Number(s.exit_price) / ma.exit_price - 1) < 1e-12, `${label} ${s.slot}: stored exit differs from the manifest`);
          check(Math.abs(Number(s.return_ratio) - ma.return_ratio) < 1e-12, `${label} ${s.slot}: stored return differs from the manifest`);
        }
        const rec = await pool.query(
          `SELECT endpoint, purpose, request_params AS "requestParams", response_sha256 AS "responseSha256", request_id AS "requestId"
           FROM source_receipts WHERE round_id = $1`,
          [r.id],
        );
        const round: RoundLike = {
          cutoff: new Date(r.cutoff).toISOString(),
          resolution_time: new Date(r.resolution_time).toISOString(),
          winner_slot: m.winner_slot,
          eligibility_policy: m.eligibility_policy,
          provenance: m.provenance,
          assets: m.assets.map((x: any) => ({
            slot: x.slot, token_symbol: x.token_symbol, token_address: x.token_address, sectors: x.sectors,
            clue_inputs: x.clue_inputs, clues: x.clues, return: x.return_ratio,
            price: { entry_candle_start: x.entry_candle_start, entry_close: x.entry_price, exit_candle_start: x.exit_candle_start, exit_close: x.exit_price },
          })),
        };
        console.log(
          r.rebuilt_from
            ? `Rebuilt round ${r.id} (from ${r.rebuilt_from}, eligibility ${r.eligibility_status}, ancestor ${r.ancestor_status})`
            : `Round ${r.id} (forge v${r.round_forge_version}, eligibility ${r.eligibility_status})`,
        );
        verifyRound(label, round, rec.rows);
      }
    } finally {
      await pool.end();
    }
  }
  console.log(`\n${checks} check(s) run, ${failures} failure(s).`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
