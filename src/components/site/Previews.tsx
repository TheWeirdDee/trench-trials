import { BrandMark } from '@/components/brand/BrandMark';

/*
 * Structural product previews for the landing page. They show the real shapes of the
 * game — three slots, four signals, a sealed outcome — and deliberately no values: every
 * number a player sees in the game comes from a verified Nansen round.
 */

const SIGNALS = ['Buy / sell balance', 'Trading pace', 'Netflow / liquidity', '7-day momentum'];

function HiddenName() {
  return (
    <span className="inline-flex items-center gap-2 text-[14px] font-semibold text-secondary">
      <span className="h-2.5 w-16 rounded-full bg-cream/15" aria-hidden="true" />
      Name hidden
    </span>
  );
}

function SignalRow({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <span className="text-[14px] text-secondary">{label}</span>
      <span className="flex gap-1" aria-hidden="true">
        <span className="h-2 w-5 rounded-full bg-cream/25" />
        <span className="h-2 w-5 rounded-full bg-cream/25" />
        <span className="h-2 w-5 rounded-full bg-cream/10" />
      </span>
    </div>
  );
}

/** Hero: the Blind Pick mechanic on a burgundy panel. */
export function HeroPreview() {
  return (
    <div className="relative overflow-hidden rounded-panel bg-burgundy p-5 sm:p-8" data-testid="hero-preview">
      <div className="mb-5 flex items-center justify-between">
        <span className="eyebrow text-cream/80">Blind Pick</span>
        <BrandMark size={34} />
      </div>
      <ul className="grid gap-3">
        {(['A', 'B', 'C'] as const).map((slot, i) => (
          <li
            key={slot}
            className={`rounded-card p-4 sm:p-5 ${i === 1 ? 'bg-canvas ring-2 ring-cream/80' : 'bg-canvas/70'}`}
          >
            <div className="flex items-center justify-between">
              <span className="text-[22px] font-extrabold tracking-[-0.03em]">Slot {slot}</span>
              {i === 1 ? (
                <span className="rounded-full bg-cream px-3 py-1 text-[14px] font-bold text-canvas">Your read</span>
              ) : (
                <HiddenName />
              )}
            </div>
            {i === 1 && (
              <div className="mt-2 border-t border-line/70 pt-2">
                {SIGNALS.map((s) => (
                  <SignalRow key={s} label={s} />
                ))}
              </div>
            )}
          </li>
        ))}
      </ul>
      <p className="mt-5 text-[14px] leading-relaxed text-cream/80">
        Names, prices and the outcome stay sealed until you lock your read.
      </p>
    </div>
  );
}

/** How it works: one connected three-stage strip. */
export function StagePreview() {
  return (
    <div className="grid gap-4 md:grid-cols-3" data-testid="stage-preview">
      <div className="rounded-card bg-raised p-5">
        <div className="flex items-center justify-between">
          <span className="text-[18px] font-extrabold">Slot B</span>
          <HiddenName />
        </div>
        <div className="mt-3">
          {SIGNALS.slice(0, 3).map((s) => (
            <SignalRow key={s} label={s} />
          ))}
        </div>
      </div>
      <div className="rounded-card bg-raised p-5">
        <div className="flex items-center justify-between">
          <span className="text-[18px] font-extrabold">Slot B</span>
          <span className="rounded-full bg-burgundy-strong px-3 py-1 text-[14px] font-bold">Name revealed</span>
        </div>
        <div className="mt-4 flex items-center gap-3 rounded-control bg-raised-2 px-4 py-3">
          <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true" className="text-secondary">
            <rect x="4" y="9" width="12" height="8" rx="2" fill="currentColor" />
            <path d="M7 9V7a3 3 0 016 0v2" stroke="currentColor" strokeWidth="2" fill="none" />
          </svg>
          <span className="text-[14px] font-semibold text-secondary">Outcome still sealed · Keep or switch</span>
        </div>
      </div>
      <div className="rounded-card bg-raised p-5">
        <span className="text-[18px] font-extrabold">Verdict</span>
        <dl className="mt-3 grid gap-2 text-[14px]">
          {['Blind choice → Final choice', 'Actual return of all three', 'Switch impact', 'Ticker Tax contribution'].map(
            (row) => (
              <div key={row} className="flex items-center justify-between gap-3 rounded-control bg-raised-2 px-4 py-2.5">
                <dt className="text-secondary">{row}</dt>
                <dd className="text-subtle">
                  <span aria-hidden="true">▪▪▪</span>
                  <span className="sr-only">Revealed at the verdict</span>
                </dd>
              </div>
            ),
          )}
        </dl>
      </div>
    </div>
  );
}

/** History: the structure of a guest's record. */
export function HistoryPreview() {
  return (
    <div className="rounded-panel bg-raised p-6 sm:p-8" data-testid="history-preview">
      <p className="eyebrow">Guest history · Saved on this browser</p>
      <ul className="mt-5 grid gap-3">
        {['Blind choice', 'Final choice', 'Winner', 'Switch impact'].map((row) => (
          <li key={row} className="flex items-center justify-between rounded-control bg-raised-2 px-4 py-3 text-[15px]">
            <span className="text-secondary">{row}</span>
            <span className="h-2.5 w-20 rounded-full bg-cream/10" aria-hidden="true" />
          </li>
        ))}
      </ul>
    </div>
  );
}
