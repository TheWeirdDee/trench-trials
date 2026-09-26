/**
 * Records eligibility review decisions (docs/NANSEN-CONTRACT-AUDIT.md, Phase 4). A decision
 * changes only the round's eligibility status and appends a round_eligibility_events row:
 * rounds, assets, receipts, commitments, attempts and Daily rows are never deleted or
 * rewritten, so every decision is reversible by recording another one. Zero Nansen calls.
 *
 * Usage:
 *   npm run review:round -- --round <uuid> --status withdrawn --note "reason" --actor <name>
 *   npm run review:round -- --plan decisions.json --actor <name>          # [{ round, status, note }]
 * Dry run by default (prints the plan, writes nothing); add --confirm to write.
 */
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { readFileSync } from 'node:fs';
import { dbSchema, getPool, withTransaction } from '../src/lib/db';
import { ELIGIBILITY_POLICY_VERSION } from '../src/lib/domain/assetPolicy';
import { ELIGIBILITY_STATUSES, type EligibilityStatus } from '../src/lib/domain/eligibility';
import { setRoundEligibility } from '../src/lib/repo/eligibility';

interface Decision {
  round: string;
  status: EligibilityStatus;
  note: string;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0) return process.argv[i + 1];
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
}

function readDecisions(): Decision[] {
  const plan = arg('plan');
  const raw: unknown[] = plan
    ? (JSON.parse(readFileSync(plan, 'utf8')) as unknown[])
    : [{ round: arg('round'), status: arg('status'), note: arg('note') }];
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('No decisions given');
  const seen = new Set<string>();
  return raw.map((d, i) => {
    const { round, status, note } = (d ?? {}) as Partial<Decision>;
    if (!round || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(round)) {
      throw new Error(`Decision ${i + 1}: round must be a full uuid`);
    }
    if (!status || !ELIGIBILITY_STATUSES.includes(status)) {
      throw new Error(`Decision ${i + 1}: status must be one of ${ELIGIBILITY_STATUSES.join(', ')}`);
    }
    if (!note?.trim()) throw new Error(`Decision ${i + 1}: a note is required`);
    if (seen.has(round)) throw new Error(`Decision ${i + 1}: round ${round} appears twice`);
    seen.add(round);
    return { round, status, note: note.trim() };
  });
}

async function main() {
  const confirm = process.argv.includes('--confirm');
  const actor = arg('actor');
  if (!actor?.trim()) throw new Error('--actor <name> is required');
  const decisions = readDecisions();
  const pool = getPool();

  const rows = await pool.query<{ id: string; mode: string; status: string; eligibility_status: string; eligibility_policy_version: number | null; tokens: string }>(
    `SELECT r.id, r.mode, r.status, r.eligibility_status, r.eligibility_policy_version,
            (SELECT string_agg(ra.slot || ':' || ra.token_symbol, ' ' ORDER BY ra.slot) FROM round_assets ra WHERE ra.round_id = r.id) AS tokens
     FROM rounds r WHERE r.id = ANY($1::uuid[])`,
    [decisions.map((d) => d.round)],
  );
  const byId = new Map(rows.rows.map((r) => [r.id, r]));

  console.log(`Eligibility review plan (schema ${dbSchema() ?? 'public'}, policy v${ELIGIBILITY_POLICY_VERSION}, actor ${actor})`);
  for (const d of decisions) {
    const r = byId.get(d.round);
    if (!r) throw new Error(`Round ${d.round} not found; nothing written`);
    if (d.status === 'approved' && r.status === 'invalid') {
      throw new Error(`Round ${d.round} is invalid and cannot be approved; nothing written`);
    }
    const from = `${r.eligibility_status}${r.eligibility_policy_version ? ` (v${r.eligibility_policy_version})` : ''}`;
    console.log(`  ${d.round}  ${r.mode.padEnd(6)} ${r.status.padEnd(8)} ${from} → ${d.status}  [${r.tokens ?? ''}]  ${d.note}`);
  }

  if (!confirm) {
    console.log('\nDry run: nothing written. Re-run with --confirm to record these decisions.');
    return;
  }
  // All or nothing: a partial review is never left behind.
  await withTransaction(async (client) => {
    for (const d of decisions) await setRoundEligibility(client, d.round, { status: d.status, actor, note: d.note });
  });
  console.log(`\nRecorded ${decisions.length} decision(s).`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => getPool().end());
