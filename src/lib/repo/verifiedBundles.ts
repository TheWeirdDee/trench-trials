import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ImportOptions, VerifiedRound } from './verifiedRoundImport';

/**
 * Verified round bundles (scripts/export-verified-bundle.ts): every approved round, frozen
 * as redistribution-safe Nansen-derived evidence (derived manifest, request IDs, response
 * hashes; never raw bodies), so a fresh clone can play the full catalog without a Nansen
 * key (npm run setup:demo). No bundled data is synthetic.
 */
export const VERIFIED_BUNDLE_DIR = join('data', 'verified-rounds');
/** Leak-free offline rebuilds and Round Forge v4 rounds. `round-001.json` is audit evidence, not a bundle. */
export const VERIFIED_BUNDLE_FILE = /^(rebuild|forge-v4)-.*\.json$/;
export const VERIFIED_BUNDLE_FORMAT = 'trench-trials.verified-round-bundle/1';

export interface VerifiedBundle {
  format: string;
  round: VerifiedRound;
  receipts: NonNullable<ImportOptions['receipts']>;
}

/** Loads and validates every bundle; throws on the first malformed one. */
export function loadVerifiedBundles(dir: string = VERIFIED_BUNDLE_DIR): Array<{ file: string; bundle: VerifiedBundle }> {
  const files = readdirSync(dir).filter((f) => VERIFIED_BUNDLE_FILE.test(f)).sort();
  if (files.length === 0) throw new Error(`no bundles found in ${dir}`);
  return files.map((file) => {
    const bundle = JSON.parse(readFileSync(join(dir, file), 'utf8')) as VerifiedBundle;
    if (bundle.format !== VERIFIED_BUNDLE_FORMAT) throw new Error(`${file}: unknown bundle format`);
    if (!bundle.round?.round_id || bundle.round.assets?.length !== 3) throw new Error(`${file}: malformed round`);
    if (!Array.isArray(bundle.receipts) || bundle.receipts.length === 0) throw new Error(`${file}: no receipts`);
    for (const r of bundle.receipts) {
      if (!r.requestId || !/^[0-9a-f]{64}$/.test(r.responseSha256)) throw new Error(`${file}: a receipt lacks a request ID or SHA-256`);
    }
    return { file, bundle };
  });
}
