'use client';

import type { ClueView, Slot } from '@/lib/api/types';
import { bucketLabel, bucketLevel, CLUE_META, CLUE_ORDER } from '@/components/clueDisplay';

export interface CandidateCardProps {
  slot: Slot;
  clues: ClueView;
  /** Present once identities are revealed (Unmask and later). */
  tokenSymbol?: string;
  /** Present only at Verdict. */
  returnPct?: number;
  isWinner?: boolean;
  isBlindSlot?: boolean;
  isFinalSlot?: boolean;
  /** Final choice already locked (Verdict / pending): marks the pick as kept or switched-to. */
  decided?: boolean;
  selected?: boolean;
  /** When set, the card is a selectable control. */
  onSelect?: () => void;
  disabled?: boolean;
  revealed?: boolean;
}

function SignalMeter({ bucket }: { bucket: string }) {
  const level = bucketLevel(bucket);
  return (
    <span className="flex items-center gap-1" aria-hidden="true">
      {[1, 2, 3].map((n) => (
        <span
          key={n}
          className={`h-2 w-6 rounded-full transition-colors duration-200 ${n <= level ? 'bg-cream' : 'bg-cream/15'}`}
        />
      ))}
    </span>
  );
}

function Badges({ isBlindSlot, isFinalSlot, decided, isWinner }: Partial<CandidateCardProps>) {
  const badges: Array<{ label: string; tone: 'burgundy' | 'quiet' | 'gain' }> = [];
  if (isWinner) badges.push({ label: 'Winner', tone: 'gain' });
  if (decided && isBlindSlot && isFinalSlot) badges.push({ label: 'Your pick · kept', tone: 'burgundy' });
  else {
    if (isBlindSlot) badges.push({ label: 'Your blind pick', tone: decided ? 'quiet' : 'burgundy' });
    if (decided && isFinalSlot) badges.push({ label: 'Your final pick', tone: 'burgundy' });
  }
  if (badges.length === 0) return null;
  return (
    <span className="flex flex-wrap gap-1.5">
      {badges.map((b) => (
        <span
          key={b.label}
          className={`rounded-full px-2.5 py-1 text-[14px] font-bold ${
            b.tone === 'burgundy'
              ? 'bg-burgundy-strong text-cream'
              : b.tone === 'gain'
                ? 'bg-gain/15 text-gain'
                : 'bg-raised-2 text-secondary'
          }`}
        >
          {b.label}
        </span>
      ))}
    </span>
  );
}

/**
 * One candidate. The signal definitions live once, in the shared SignalGuide below the
 * candidates, not on every card.
 */
export function CandidateCard(props: CandidateCardProps) {
  const { slot, clues, tokenSymbol, returnPct, selected, onSelect, disabled, revealed } = props;
  const interactive = typeof onSelect === 'function';

  const body = (
    <>
      <span className="flex items-start justify-between gap-3">
        <span className="min-w-0">
          <span className="block text-[14px] font-bold text-secondary">Slot {slot}</span>
          {tokenSymbol ? (
            <span
              className={`mt-0.5 block truncate text-[28px] font-extrabold leading-tight tracking-[-0.035em] ${
                revealed ? 'animate-reveal-mask' : ''
              }`}
            >
              {tokenSymbol}
            </span>
          ) : (
            <span className="mt-1.5 flex h-[35px] items-center gap-3">
              <span className="h-6 w-24 rounded-md bg-cream/10" aria-hidden="true" />
              <span className="text-[14px] font-semibold text-subtle">Name hidden</span>
            </span>
          )}
        </span>
        {typeof returnPct === 'number' ? (
          <span className="text-right">
            <span className="block text-[14px] font-semibold text-subtle">Actual return</span>
            <span
              className={`block font-mono text-[22px] font-semibold tabular-nums ${returnPct >= 0 ? 'text-gain' : 'text-loss'}`}
              data-testid={`slot-return-${slot}`}
            >
              {returnPct >= 0 ? '+' : ''}
              {returnPct.toFixed(2)}%
            </span>
          </span>
        ) : selected ? (
          <span className="rounded-full bg-cream px-2.5 py-1 text-[14px] font-bold text-canvas">Selected</span>
        ) : null}
      </span>

      <span className="mt-3 block">
        <Badges {...props} />
      </span>

      <span className="mt-4 block divide-y divide-line/70">
        {CLUE_ORDER.map((key) => (
          <span
            key={key}
            className="flex items-center justify-between gap-3 py-2.5 md:flex-col md:items-stretch md:gap-1 xl:flex-row xl:items-center xl:gap-3"
          >
            {/* Three narrow columns (768–1279px) stack label over value instead of wrapping mid-phrase. */}
            <span className="whitespace-nowrap text-[14px] text-secondary">{CLUE_META[key].title}</span>
            <span className="flex items-center justify-end gap-3 md:justify-between xl:justify-end">
              <span className="whitespace-nowrap text-right text-[14px] font-bold text-cream">{bucketLabel(clues[key])}</span>
              <SignalMeter bucket={clues[key]} />
            </span>
          </span>
        ))}
      </span>
    </>
  );

  const frame = `relative flex h-full flex-col rounded-card p-5 text-left transition-[background-color,box-shadow,transform] duration-200 ease-reveal ${
    selected
      ? 'bg-burgundy-surface shadow-[inset_0_0_0_2px_#941642]'
      : props.isWinner
        ? 'bg-raised shadow-[inset_0_0_0_1px_rgba(109,187,143,0.45)]'
        : 'bg-raised'
  }`;

  return (
    <article className="flex flex-col gap-2" aria-label={`Slot ${slot}${tokenSymbol ? `, ${tokenSymbol}` : ''}`}>
      {interactive ? (
        <button
          type="button"
          data-testid={`slot-card-${slot}`}
          aria-pressed={Boolean(selected)}
          disabled={disabled}
          onClick={onSelect}
          className={`${frame} w-full hover:bg-raised-2 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60 ${
            selected ? 'hover:bg-burgundy-surface' : ''
          }`}
        >
          {body}
        </button>
      ) : (
        <div data-testid={`slot-card-${slot}`} className={frame}>
          {body}
        </div>
      )}
    </article>
  );
}
