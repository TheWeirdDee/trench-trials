import Link from 'next/link';
import type { Provenance, RoundMeta, Slot, VerdictData } from '@/lib/api/types';
import { NextSteps } from './NextSteps';
import { VerificationDetails, formatUtc } from './VerificationDetails';

function pct(n: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}
function pp(n: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(1)} pp`;
}

export function verdictCopy(v: VerdictData): { headline: string; detail: string } {
  const symbol = (slot: Slot) => v.assets.find((a) => a.slot === slot)?.tokenSymbol ?? `Slot ${slot}`;
  if (v.finalActionType === 'timeout') {
    return {
      headline: `Time ran out. Your blind choice was retained: Slot ${v.blindSlot}.`,
      detail: `${symbol(v.blindSlot)} returned ${pct(v.blindReturnPct)}. The decision window closed before a final choice, so your blind pick stands as a timeout — not an explicit keep. Switch impact: 0.0 pp.`,
    };
  }
  if (v.finalActionType === 'stick') {
    return {
      headline: `You kept your blind choice: Slot ${v.blindSlot}.`,
      detail: `${symbol(v.blindSlot)} returned ${pct(v.blindReturnPct)}. Switch impact: 0.0 pp — keeping costs nothing, whatever the outcome.`,
    };
  }
  const outcome = v.switchOutcome === 'helped' ? 'helped' : v.switchOutcome === 'hurt' ? 'hurt' : 'did not change';
  return {
    headline: `You switched from Slot ${v.blindSlot} to Slot ${v.finalSlot}.`,
    detail: `${symbol(v.blindSlot)} returned ${pct(v.blindReturnPct)}; ${symbol(v.finalSlot)} returned ${pct(
      v.finalReturnPct,
    )}. Your switch ${outcome} your return: ${v.switchImpactPp >= 0 ? '+' : ''}${v.switchImpactPp.toFixed(1)} percentage points.`,
  };
}

export function VerdictView({
  verdict,
  round,
  provenance,
  isLive,
  context,
  children,
}: {
  verdict: VerdictData;
  round: RoundMeta;
  provenance?: Provenance;
  isLive: boolean;
  /** Where the round was played from; decides the next-step actions. */
  context: 'replay' | 'daily' | 'live';
  children?: React.ReactNode;
}) {
  const { headline, detail } = verdictCopy(verdict);
  const maxAbs = Math.max(...verdict.assets.map((a) => Math.abs(a.returnPct)), 1);
  const taxContribution =
    verdict.finalActionType === 'timeout' ? 'Not counted (timeout)' : pp(verdict.finalActionType === 'switch' ? verdict.tickerTaxPp : 0);

  return (
    <div className="grid gap-8" data-testid="verdict-banner">
      <section className="rounded-panel bg-burgundy-surface p-6 sm:p-10">
        <div className="flex flex-wrap items-center gap-2">
          <span className="eyebrow text-cream/80">{isLive ? 'Live round resolved' : 'Verdict'}</span>
          <Link
            href="/evidence"
            className="rounded-full bg-canvas/40 px-3 py-1 text-[14px] font-bold text-cream/85 hover:text-cream"
            data-testid="verified-badge"
          >
            Verified ✓
          </Link>
          <span
            className={`rounded-full px-3 py-1 text-[14px] font-bold ${
              verdict.finalWasWinner ? 'bg-gain/15 text-gain' : 'bg-canvas/50 text-cream/85'
            }`}
            data-testid="verdict-points"
          >
            {verdict.finalWasWinner ? `Winning pick · +${verdict.pointsAwarded} points` : 'Not the winner · 0 points'}
          </span>
        </div>
        <h1 className="type-title mt-4 max-w-4xl" data-testid="verdict-headline">
          {headline}
        </h1>
        <p className="mt-4 max-w-3xl text-[17px] leading-relaxed text-cream/85" data-testid="verdict-detail">
          {detail}
        </p>

        <dl className="mt-8 grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[
            ['Blind choice', `Slot ${verdict.blindSlot}`, pct(verdict.blindReturnPct)],
            ['Final choice', `Slot ${verdict.finalSlot}`, pct(verdict.finalReturnPct)],
            ['Switch impact', pp(verdict.switchImpactPp), verdict.finalActionType === 'switch' ? 'After the reveal' : 'No switch'],
            ['Ticker Tax contribution', taxContribution, 'Blind return − final return'],
          ].map(([label, value, note]) => (
            <div key={label} className="rounded-card bg-canvas/45 p-4">
              <dt className="text-[14px] font-semibold text-cream/75">{label}</dt>
              <dd className="mt-1 text-[22px] font-extrabold tracking-[-0.02em]">{value}</dd>
              <dd className="text-[14px] text-cream/65">{note}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section aria-labelledby="returns-heading" className="rounded-panel bg-raised p-6 sm:p-8">
        <h2 id="returns-heading" className="text-[20px] font-extrabold tracking-[-0.02em]">
          What each token actually returned
        </h2>
        <ul className="mt-5 grid gap-3">
          {verdict.assets.map((a) => {
            const winner = verdict.winningSlots.includes(a.slot);
            return (
              <li key={a.slot} className="grid grid-cols-[88px_1fr] items-center gap-x-4 gap-y-1 sm:grid-cols-[140px_1fr_190px]">
                <span className="text-[16px] font-bold">
                  {a.slot} · {a.tokenSymbol}
                </span>
                <span className="flex h-3 items-center overflow-hidden rounded-full bg-raised-2" aria-hidden="true">
                  <span
                    className={`h-full origin-left animate-grow-x rounded-full ${a.returnPct >= 0 ? 'bg-gain' : 'bg-loss'}`}
                    style={{ width: `${(Math.abs(a.returnPct) / maxAbs) * 100}%` }}
                  />
                </span>
                <span className="col-span-2 flex items-center gap-2 sm:col-span-1 sm:justify-end">
                  <span className={`font-mono text-[16px] font-semibold ${a.returnPct >= 0 ? 'text-gain' : 'text-loss'}`}>
                    {pct(a.returnPct)}
                  </span>
                  {winner && <span className="rounded-full bg-gain/15 px-2 py-0.5 text-[14px] font-bold text-gain">Winner</span>}
                </span>
              </li>
            );
          })}
        </ul>
      </section>

      <NextSteps context={context} />

      {children}

      <VerificationDetails
        provenance={provenance}
        rows={[
          ['Round', round.id],
          ['Chain', round.chain],
          ['Exact cutoff', formatUtc(round.exactCutoff)],
          ['Outcome measured at', formatUtc(round.resolutionTime)],
          ['Price policy', isLive ? '5-minute candle open at each boundary' : 'Hourly candle close at each boundary'],
          ['Winner rule', 'Highest return; ties within 0.01 pp share the win'],
        ]}
      />
    </div>
  );
}
