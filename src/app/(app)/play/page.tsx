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
  { title: 'Read the signals', body: 'Three real tokens, four Nansen signals each. No names.' },
  { title: 'Reveal the names', body: 'Lock a blind pick, then see the tickers and decide again.' },
  { title: 'See what changed', body: 'The real outcome shows whether the names helped or hurt.' },
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
          Your choices and results will be saved in this browser. No wallet or signup is required.
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

type PlayState =
  | { kind: 'checking' }
  | { kind: 'onboarding' }
  | { kind: 'finding' }
  | { kind: 'exhausted'; message: string; noneApproved?: boolean }
  | { kind: 'error' };

export default function PlayPage() {
  const router = useRouter();
  const [state, setState] = useState<PlayState>({ kind: 'checking' });

  const findNext = useCallback(async () => {
    setState({ kind: 'finding' });
    try {
      const res = await fetch('/api/rounds/next', { credentials: 'include' });
      const body: { available: boolean; roundId?: string; message?: string; reason?: string } = await res.json();
      if (body.available && body.roundId) {
        router.replace(`/round/${body.roundId}`);
        return;
      }
      setState({
        kind: 'exhausted',
        noneApproved: body.reason === 'none_approved',
        message: body.message ?? 'You have completed every available verified round.',
      });
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

  if (state.kind === 'exhausted') {
    return (
      <div className="page py-16 sm:py-24" data-testid="replay-exhausted">
        <div className="max-w-3xl">
          <p className="eyebrow">Verified rounds</p>
          <h1 className="type-section mt-4">
            {state.noneApproved ? 'No verified round is open for play.' : 'You have played every verified round.'}
          </h1>
          <p className="type-lead mt-6">
            {state.message} New rounds appear only after they are built from real Nansen data and verified — none are
            generated to fill the gap.
          </p>
          <div className="mt-10 flex flex-col gap-3 sm:flex-row">
            <Link href="/history" className="btn-primary">
              See your History
            </Link>
            <Link href="/docs" className="btn-quiet">
              How rounds are verified
            </Link>
          </div>
        </div>
      </div>
    );
  }

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
        Finding your next verified round…
      </p>
    </div>
  );
}
