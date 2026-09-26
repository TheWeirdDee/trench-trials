'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * The Unmask decision window, counted against the SERVER clock: clockOffsetMs is
 * (server time − browser time) from the latest API response, so a wrong or skewed browser
 * clock can neither shorten nor extend the window the server enforces. The deadline is
 * the server's stored finalDeadlineAt; a refresh re-reads it, it never restarts.
 */
export function CountdownTimer({
  deadlineIso,
  totalSeconds,
  onExpire,
  clockOffsetMs = 0,
}: {
  deadlineIso: string;
  totalSeconds: number;
  onExpire?: () => void;
  clockOffsetMs?: number;
}) {
  const remainingNow = () => new Date(deadlineIso).getTime() - (Date.now() + clockOffsetMs);
  const [remainingMs, setRemainingMs] = useState(remainingNow);
  const expiredPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    expiredPollRef.current = null;
    const tick = () => {
      const remaining = new Date(deadlineIso).getTime() - (Date.now() + clockOffsetMs);
      setRemainingMs(remaining);
      if (remaining <= 0 && expiredPollRef.current === null) {
        onExpire?.();
        // Keep asking the server until it reports the recorded outcome.
        expiredPollRef.current = setInterval(() => onExpire?.(), 2000);
      }
    };
    tick();
    const id = setInterval(tick, 200);
    return () => {
      clearInterval(id);
      if (expiredPollRef.current !== null) clearInterval(expiredPollRef.current);
    };
  }, [deadlineIso, onExpire, clockOffsetMs]);

  const seconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const fraction = Math.min(1, Math.max(0, remainingMs / (totalSeconds * 1000)));
  const urgent = seconds <= 5;

  return (
    <div className="w-full rounded-card bg-raised p-4 sm:w-64" data-testid="countdown-timer">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[14px] font-semibold text-secondary">Decision window</span>
        <span
          role="timer"
          aria-live="polite"
          aria-atomic="true"
          className={`font-mono text-[28px] font-semibold tabular-nums ${urgent ? 'text-cream' : 'text-cream'}`}
        >
          {seconds}s<span className="sr-only"> left to keep or switch</span>
        </span>
      </div>
      <div className="mt-3 h-2 overflow-hidden rounded-full bg-raised-2" aria-hidden="true">
        <div
          className={`h-full origin-left rounded-full transition-[width] duration-200 ${urgent ? 'bg-burgundy-hover' : 'bg-cream'}`}
          style={{ width: `${fraction * 100}%` }}
        />
      </div>
    </div>
  );
}
