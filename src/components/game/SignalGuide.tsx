import Link from 'next/link';
import { CLUE_META, CLUE_ORDER } from '@/components/clueDisplay';

/**
 * One shared definition of the four signals, below the candidates, instead of a copy on
 * every card. Native <details>: keyboard and screen-reader friendly without script.
 */
export function SignalGuide() {
  return (
    <details className="group mt-6 rounded-card bg-raised" data-testid="signal-guide">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 text-[16px] font-bold [&::-webkit-details-marker]:hidden">
        Signal guide
        <span className="text-secondary transition-transform duration-200 group-open:rotate-45" aria-hidden="true">
          +
        </span>
      </summary>
      <div className="px-5 pb-5">
        <dl className="grid gap-3 text-[14px] leading-relaxed sm:grid-cols-2">
          {CLUE_ORDER.map((key) => (
            <div key={key} className="rounded-control bg-raised-2 p-4">
              <dt className="font-bold text-cream">{CLUE_META[key].title}</dt>
              <dd className="mt-1 text-secondary">{CLUE_META[key].hint}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-4 text-[14px] text-secondary">
          All four come from Nansen’s historical token screener, read before the cutoff and frozen before play.{' '}
          <Link href="/evidence#clues" className="link-quiet">
            How each signal is built
          </Link>
        </p>
      </div>
    </details>
  );
}
