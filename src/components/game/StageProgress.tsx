const STAGES = ['Blind Pick', 'Unmask', 'Verdict'] as const;

/** Where the player is in a round. `current` is 1-based. */
export function StageProgress({ current }: { current: 1 | 2 | 3 }) {
  return (
    <ol className="flex items-center gap-2" aria-label="Round progress" data-testid="stage-progress">
      {STAGES.map((stage, i) => {
        const n = i + 1;
        const state = n < current ? 'done' : n === current ? 'current' : 'next';
        return (
          <li key={stage} className="flex items-center gap-2" aria-current={state === 'current' ? 'step' : undefined}>
            <span
              className={`rounded-full px-3 py-1.5 text-[14px] font-bold ${
                state === 'current'
                  ? 'bg-burgundy-strong text-cream'
                  : state === 'done'
                    ? 'bg-raised-2 text-cream'
                    : 'bg-raised text-subtle'
              }`}
            >
              {stage}
            </span>
            {n < STAGES.length && <span className="h-px w-4 bg-line sm:w-8" aria-hidden="true" />}
          </li>
        );
      })}
    </ol>
  );
}
