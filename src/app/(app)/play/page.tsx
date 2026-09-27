'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';

const ONBOARDED_KEY = 'tt.onboarded.v1';

function readOnboarded(): boolean {
  try {
    return window.localStorage.getItem(ONBOARDED_KEY) === '1';
  } catch {
    return false;
  }
}

function markOnboarded() {
  try {
    window.localStorage.setItem(ONBOARDED_KEY, '1');
  } catch {
    // Storage unavailable (private mode): the sheet simply shows again next time.
  }
}

const STEPS = [
  {
    title: 'Blind pick',
    body: 'Three real tokens, four Nansen signals each. Names, dates and prices are hidden. Lock the one you think returns the most.',
  },
  {
    title: 'Unmask',
    body: 'The names appear while the future stays hidden. Stick with your pick or switch, once, before the timer ends.',
  },
  {
    title: 'Verdict',
    body: 'The real outcome shows what recognition gained or cost you. That difference is your Ticker Tax.',
  },
];

function OnboardingSheet({ onStart }: { onStart: () => void }) {
  const startRef = useRef<HTMLButtonElement>(null);
  useEffect(() => startRef.current?.focus(), []);
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-canvas/80 backdrop-blur-sm sm:items-center">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="onboarding-heading"
        className="w-full max-w-xl animate-rise-in rounded-t-panel bg-raised p-6 pb-8 sm:rounded-panel sm:p-10"
        data-testid="onboarding-sheet"
      >
        <h1 id="onboarding-heading" className="text-[clamp(32px,5vw,44px)] font-extrabold leading-[1.02] tracking-[-0.035em]">
          Play as a guest.
        </h1>
        <p className="type-body mt-4">
          No wallet or signup. Your trial history is saved to this browser as an anonymous profile.
        </p>
        <ol className="mt-8 grid gap-3">
          {STEPS.map((step, i) => (
            <li key={step.title} className="flex gap-4 rounded-card bg-raised-2 p-4">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-burgundy-strong text-[15px] font-extrabold">
                {i + 1}
              </span>
              <span>
                <span className="block text-[17px] font-extrabold">{step.title}</span>
                <span className="block text-[15px] text-secondary">{step.body}</span>
              </span>
            </li>
          ))}
        </ol>
        <p className="mt-5 text-[15px] text-secondary">
          Replay gives you a new round each time. The Daily is one measured attempt per UTC day, the same for everyone.
        </p>
        <div className="mt-8 flex flex-col gap-4 sm:flex-row sm:items-center">
          <button ref={startRef} type="button" onClick={onStart} className="btn-primary" data-testid="onboarding-start">
            Start the trial
          </button>
          <Link href="/docs#how-it-works" className="link-quiet text-center text-[16px]">
            How the game works
          </Link>
        </div>
      </div>
    </div>
  );
}

interface Progress {
  catalogSize: number;
  completedCount: number;
  daily: { available: boolean; completed: boolean; resetAtUtc: string; nextScheduled: boolean };
}

interface NextBody {
  available: boolean;
  roundId?: string;
  reason?: 'all_played' | 'daily_only' | 'none_approved';
  progress?: Progress;
}

type PlayState =
  | { kind: 'checking' }
  | { kind: 'onboarding' }
  | { kind: 'finding' }
  | { kind: 'exhausted'; body: NextBody }
  | { kind: 'error' };

function untilLabel(targetIso: string): string {
  const ms = Math.max(0, Date.parse(targetIso) - Date.now());
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

/** An empty Replay queue, explained honestly: what the guest has done and what comes next. */
function Exhausted({ body }: { body: NextBody }) {
  const progress = body.progress;
  const daily = progress?.daily;
  const dailyWaiting = Boolean(daily?.available && !daily.completed);
  const nextDaily = daily?.nextScheduled
    ? `The next Daily opens in ${untilLabel(daily.resetAtUtc)} (00:00 UTC).`
    : 'The next Daily has not been scheduled yet.';

  let heading: string;
  let lead: string;
  if (body.reason === 'none_approved') {
    heading = 'No round is open for play right now.';
    lead = 'New rounds appear once they are built from Nansen data and pass review.';
  } else if (body.reason === 'daily_only' && dailyWaiting) {
    heading = 'Your next round is today’s Daily.';
    lead = 'The remaining round is today’s Daily: one measured attempt, the same for everyone.';
  } else {
    heading = 'You’ve completed the current Replay catalog.';
    lead = progress
      ? `You’ve played ${progress.completedCount} of ${progress.catalogSize} round${progress.catalogSize === 1 ? '' : 's'}.`
      : 'You’ve played every round available to you.';
  }

  return (
    <div className="page py-16 sm:py-24" data-testid="replay-exhausted">
      <div className="max-w-3xl">
        <p className="eyebrow">Replay</p>
        <h1 className="type-section mt-4" data-testid="exhausted-heading">
          {heading}
        </h1>
        <p className="type-lead mt-6">{lead}</p>
        {daily && body.reason !== 'none_approved' && (
          <p className="type-body mt-4" data-testid="exhausted-daily">
            {dailyWaiting ? 'Today’s Daily is waiting for you.' : daily.available ? `Today’s Daily is done. ${nextDaily}` : nextDaily}
          </p>
        )}
        <div className="mt-10 flex flex-col gap-3 sm:flex-row">
          {dailyWaiting && (
            <Link href="/daily" className="btn-primary" data-testid="exhausted-daily-cta">
              Play today’s Daily
            </Link>
          )}
          <Link href="/history" className={dailyWaiting ? 'btn-quiet' : 'btn-primary'}>
            View History
          </Link>
          <Link href="/evidence" className="btn-quiet">
            See the evidence
          </Link>
          <Link href="/" className="btn-quiet">
            Home
          </Link>
        </div>
      </div>
    </div>
  );
}

export default function PlayPage() {
  const router = useRouter();
  const [state, setState] = useState<PlayState>({ kind: 'checking' });

  const findNext = useCallback(async () => {
    setState({ kind: 'finding' });
    try {
      const res = await fetch('/api/rounds/next', { credentials: 'include' });
      const body: NextBody = await res.json();
      if (body.available && body.roundId) {
        router.replace(`/round/${body.roundId}`);
        return;
      }
      setState({ kind: 'exhausted', body });
    } catch {
      setState({ kind: 'error' });
    }
  }, [router]);

  useEffect(() => {
    if (readOnboarded()) findNext();
    else setState({ kind: 'onboarding' });
  }, [findNext]);

  if (state.kind === 'onboarding') {
    return (
      <>
        <div className="page py-16" aria-hidden="true" />
        <OnboardingSheet
          onStart={() => {
            markOnboarded();
            findNext();
          }}
        />
      </>
    );
  }

  if (state.kind === 'exhausted') return <Exhausted body={state.body} />;

  if (state.kind === 'error') {
    return (
      <div className="page py-16">
        <div className="max-w-2xl rounded-panel bg-raised p-8 sm:p-10" role="alert">
          <h1 className="type-title">The next round could not be loaded.</h1>
          <p className="type-body mt-4">The server could not be reached. Try again in a moment.</p>
          <button type="button" onClick={() => findNext()} className="btn-primary mt-8">
            Try again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="page py-16">
      <p className="text-[16px] text-secondary" role="status">
        Finding your next round…
      </p>
    </div>
  );
}
