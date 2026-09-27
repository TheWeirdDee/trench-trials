import { getPool } from '../db';
import { ELIGIBILITY_POLICY_VERSION } from '../domain/assetPolicy';
import { computeCommitment } from '../domain/commitment';
import { playerFacingSql } from '../domain/eligibility';

export interface ReceiptEvidence {
  purpose: string | null;
  endpoint: string;
  requestId: string | null;
  responseSha256: string;
  retrievedAt: string;
}

export interface RoundEvidence {
  id: string;
  cutoff: string;
  tokens: string[];
  policyVersion: number | null;
  commitmentHash: string;
  rebuiltFrom: string | null;
  receipts: ReceiptEvidence[];
  /** Recomputed on this request, server-side; nothing sealed is revealed. */
  checks: { provenance: boolean; commitment: boolean; calculation: boolean; eligibility: boolean };
}

export interface UsageEvidence {
  loggedCalls: number;
  successfulCalls: number;
  creditsUsed: number;
  creditsRemaining: number | null;
  firstCallAt: string | null;
  lastCallAt: string | null;
}

/**
 * Public evidence for every playable round and for Nansen usage. Read-only. Exposes only
 * what is safe before play: request IDs, response hashes, commitment hashes and times —
 * never request bodies (they name tokens), raw responses, guest data or credentials.
 */
export async function getEvidence(): Promise<{ rounds: RoundEvidence[]; usage: UsageEvidence }> {
  const pool = getPool();
  const [rounds, usage] = await Promise.all([
    pool.query<{
      id: string;
      cutoff: Date;
      initial_manifest: unknown;
      initial_nonce: string;
      initial_commitment_hash: string;
      eligibility_policy_version: number | null;
      rebuilt_from: string | null;
      assets: Array<{ symbol: string; entry: string; exit: string; ret: string }>;
      receipts: Array<{ purpose: string | null; endpoint: string; request_id: string | null; response_sha256: string; retrieved_at: string }>;
    }>(
      `SELECT r.id, r.cutoff, r.initial_manifest, r.initial_nonce, r.initial_commitment_hash,
              r.eligibility_policy_version, r.rebuilt_from,
              COALESCE((SELECT json_agg(json_build_object('symbol', ra.token_symbol, 'entry', ra.entry_price::text,
                          'exit', ra.exit_price::text, 'ret', ra.return_ratio::text) ORDER BY ra.slot)
                        FROM round_assets ra WHERE ra.round_id = r.id), '[]'::json) AS assets,
              COALESCE((SELECT json_agg(json_build_object('purpose', sr.purpose, 'endpoint', sr.endpoint,
                          'request_id', sr.request_id, 'response_sha256', sr.response_sha256, 'retrieved_at', sr.retrieved_at)
                          ORDER BY sr.retrieved_at, sr.purpose)
                        FROM source_receipts sr WHERE sr.round_id = r.id), '[]'::json) AS receipts
       FROM rounds r
       WHERE r.mode = 'replay' AND r.status IN ('ready', 'resolved') AND ${playerFacingSql('r')}
       ORDER BY r.cutoff`,
    ),
    pool.query<{
      logged: number;
      successful: number;
      credits: number;
      remaining: number | null;
      first_at: Date | null;
      last_at: Date | null;
    }>(
      `SELECT count(*)::int AS logged,
              count(*) FILTER (WHERE is_success)::int AS successful,
              COALESCE(sum(credits_used), 0)::int AS credits,
              (SELECT credits_remaining FROM api_call_log WHERE credits_remaining IS NOT NULL
                 ORDER BY request_timestamp DESC LIMIT 1) AS remaining,
              min(request_timestamp) AS first_at,
              max(request_timestamp) AS last_at
       FROM api_call_log`,
    ),
  ]);

  const evidence: RoundEvidence[] = rounds.rows.map((r) => {
    const receipts = r.receipts.map((x) => ({
      purpose: x.purpose,
      endpoint: x.endpoint,
      requestId: x.request_id,
      responseSha256: x.response_sha256,
      retrievedAt: new Date(x.retrieved_at).toISOString(),
    }));
    const calculation =
      r.assets.length === 3 &&
      r.assets.every((a) => {
        const entry = Number(a.entry);
        const exit = Number(a.exit);
        return entry > 0 && exit > 0 && Math.abs(exit / entry - 1 - Number(a.ret)) < 1e-9;
      });
    return {
      id: r.id,
      cutoff: new Date(r.cutoff).toISOString(),
      tokens: r.assets.map((a) => a.symbol),
      policyVersion: r.eligibility_policy_version,
      commitmentHash: r.initial_commitment_hash,
      rebuiltFrom: r.rebuilt_from,
      receipts,
      checks: {
        provenance: receipts.length > 0 && receipts.every((x) => Boolean(x.requestId) && /^[0-9a-f]{64}$/.test(x.responseSha256)),
        commitment: computeCommitment(r.initial_manifest, r.initial_nonce) === r.initial_commitment_hash,
        calculation,
        eligibility: r.eligibility_policy_version === ELIGIBILITY_POLICY_VERSION,
      },
    };
  });

  const u = usage.rows[0]!;
  return {
    rounds: evidence,
    usage: {
      loggedCalls: u.logged,
      successfulCalls: u.successful,
      creditsUsed: u.credits,
      creditsRemaining: u.remaining,
      firstCallAt: u.first_at ? new Date(u.first_at).toISOString() : null,
      lastCallAt: u.last_at ? new Date(u.last_at).toISOString() : null,
    },
  };
}
