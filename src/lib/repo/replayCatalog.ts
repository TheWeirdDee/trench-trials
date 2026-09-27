import { getPool, withTransaction } from '../db';
import { playerFacingSql } from '../domain/eligibility';
import type { GeneratedReplayRound } from '../services/replayForge';
import { insertVerifiedRound } from './verifiedRoundImport';

export interface CatalogEntry {
  cutoff: string;
  tokenAddresses: string[];
}

export interface ActiveCatalogEntry extends CatalogEntry {
  roundId: string;
  /** Player-facing now (approved under the current policy); otherwise a pending candidate. */
  approved: boolean;
}

/**
 * The token inventory players can actually receive, which is what token reuse and
 * near-duplicates are judged against: approved player-facing rounds, plus pending
 * candidates from the current Round Forge version. Withdrawn, invalid, under-investigation
 * and audit-only rounds can never be served, so they are excluded.
 */
export async function listActiveCatalog(forgeVersion: number): Promise<ActiveCatalogEntry[]> {
  const res = await getPool().query<{ id: string; cutoff: Date; addresses: string[]; approved: boolean }>(
    `SELECT r.id, r.cutoff, array_agg(ra.token_address ORDER BY ra.slot) AS addresses, ${playerFacingSql('r')} AS approved
     FROM rounds r JOIN round_assets ra ON ra.round_id = r.id
     WHERE r.mode IN ('replay', 'daily') AND r.status IN ('ready', 'resolved')
       AND (${playerFacingSql('r')} OR (r.eligibility_status = 'pending_review' AND r.round_forge_version = $1))
     GROUP BY r.id, r.cutoff`,
    [forgeVersion],
  );
  return res.rows.map((r) => ({ roundId: r.id, cutoff: r.cutoff.toISOString(), tokenAddresses: r.addresses, approved: r.approved }));
}

/**
 * Cutoff dates a generation run already spent requests on (api_call_log purpose
 * `replay_generate:<date>`), including dates whose round was rejected. Planning skips
 * them so a resumed run never re-buys the same data.
 */
export async function listAttemptedGenerationDates(): Promise<string[]> {
  const res = await getPool().query<{ day: string }>(
    `SELECT DISTINCT substring(purpose from 'replay_generate:([0-9]{4}-[0-9]{2}-[0-9]{2})') AS day
     FROM api_call_log WHERE purpose LIKE 'replay_generate:%'`,
  );
  return res.rows.map((r) => r.day).filter(Boolean);
}

/**
 * Stores a generated round, its assets and one receipt per Nansen response in one
 * transaction. Refuses a round whose cutoff and token set already exist, so a manifest
 * is never duplicated. Any failure rolls everything back — a round without its
 * provenance is never stored.
 */
export async function persistGeneratedReplayRound(
  generated: GeneratedReplayRound,
): Promise<{ roundId: string; commitmentHash: string }> {
  return withTransaction(async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('trench_trials.replay_catalog'))`);
    const addresses = generated.round.assets.map((a) => a.token_address).sort();
    const dup = await client.query(
      `SELECT r.id FROM rounds r JOIN round_assets ra ON ra.round_id = r.id
       WHERE r.cutoff = $1 AND r.mode IN ('replay', 'daily')
       GROUP BY r.id HAVING array_agg(ra.token_address ORDER BY ra.token_address) = $2::text[]`,
      [generated.round.cutoff, addresses],
    );
    if (dup.rowCount) throw new Error(`A round with cutoff ${generated.round.cutoff} and these tokens already exists`);
    return insertVerifiedRound(client, generated.round, { receipts: generated.receipts });
  });
}
