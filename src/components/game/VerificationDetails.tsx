import type { Provenance } from '@/lib/api/types';
import { CommitmentCheck } from './CommitmentCheck';

function utc(iso: string | null | undefined): string {
  if (!iso) return '—';
  return `${new Date(iso).toISOString().replace('T', ' ').slice(0, 19)} UTC`;
}

type Receipt = Provenance['sourceReceipts'][number];

/** One entry per distinct Nansen response: a single response often backs several candidates. */
function groupReceipts(receipts: Receipt[]): Array<{ receipt: Receipt; uses: number }> {
  const groups = new Map<string, { receipt: Receipt; uses: number }>();
  for (const r of receipts) {
    const key = `${r.endpoint}|${r.responseSha256}`;
    const g = groups.get(key);
    if (g) g.uses += 1;
    else groups.set(key, { receipt: r, uses: 1 });
  }
  return [...groups.values()];
}

/**
 * The four separate things "verified" covers. Each is a distinct check: data provenance
 * does not imply a round is a fair comparison, and eligibility is a reviewed decision.
 */
const VERIFICATION_CHECKS: Array<[string, string]> = [
  ['Provenance', 'Every input traces to a Nansen response listed below, by SHA-256 and request ID, sealed in the commitment before play.'],
  ['Calculation', 'Each return is exit close ÷ entry close − 1 on the committed candles, reproducible from the revealed manifest.'],
  ['Eligibility', 'Offered for play only after approval under the current eligibility policy: freely traded tokens, liquidity and volume floors, complete candles, no near-duplicate rounds.'],
  ['Availability', 'Shown to players only while approved. A later withdrawal removes the round from play and from scoring; nothing is deleted.'],
];

/** Collapsed verification: exact times, the commitment, and the Nansen responses the round used. */
export function VerificationDetails({
  rows,
  provenance,
  summary = 'Verification details',
}: {
  rows: Array<[string, string | null | undefined]>;
  provenance?: Provenance;
  summary?: string;
}) {
  return (
    <details className="group rounded-card bg-raised" data-testid="verification-details">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 text-[16px] font-bold [&::-webkit-details-marker]:hidden">
        {summary}
        <span className="text-secondary transition-transform duration-200 group-open:rotate-45" aria-hidden="true">
          +
        </span>
      </summary>
      <div className="grid gap-5 px-5 pb-6">
        <dl className="grid gap-2 sm:grid-cols-2">
          {rows.map(([label, value]) => (
            <div key={label} className="rounded-control bg-raised-2 px-4 py-3">
              <dt className="text-[14px] font-semibold text-subtle">{label}</dt>
              <dd className="mono-value mt-1 break-all text-cream">{value ?? '—'}</dd>
            </div>
          ))}
        </dl>
        {provenance && (
          <div>
            <p className="text-[14px] font-semibold text-secondary">What “verified” means for this round</p>
            <ul className="mt-2 grid gap-2 text-[14px] text-secondary" data-testid="verification-checks">
              {VERIFICATION_CHECKS.map(([name, text]) => (
                <li key={name} className="rounded-control bg-raised-2 px-4 py-3">
                  <span className="font-bold text-cream">{name}.</span> {text}
                </li>
              ))}
            </ul>
          </div>
        )}
        {provenance && (
          <div>
            {provenance.commitments && provenance.commitments.length > 0 ? (
              <div className="grid gap-3">
                {provenance.commitments.map((c) => (
                  <CommitmentCheck key={c.kind} reveal={c} />
                ))}
              </div>
            ) : (
              <>
                <p className="text-[14px] font-semibold text-secondary">
                  Commitment hash — sealed before any outcome was known. Its contents are revealed only at a verdict.
                </p>
                <p className="mono-value mt-1 break-all text-cream">{provenance.commitmentHash}</p>
              </>
            )}
            <p className="mt-4 text-[14px] font-semibold text-secondary">
              Nansen responses this round was built from ({groupReceipts(provenance.sourceReceipts).length})
            </p>
            <ul className="mt-2 grid gap-2">
              {groupReceipts(provenance.sourceReceipts).map(({ receipt: r, uses }) => (
                <li key={`${r.endpoint}-${r.responseSha256}`} className="rounded-control bg-raised-2 px-4 py-3">
                  <span className="text-[14px] font-bold text-cream">
                    {r.endpoint}
                    {uses > 1 && <span className="font-semibold text-secondary"> · used for {uses} records</span>}
                  </span>
                  <span className="mono-value block break-all">sha256 {r.responseSha256}</span>
                  <span className="mono-value block">
                    {utc(r.retrievedAt)}
                    {r.requestId ? ` · request ${r.requestId}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </details>
  );
}

export { utc as formatUtc };
