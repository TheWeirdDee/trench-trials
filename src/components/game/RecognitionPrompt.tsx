'use client';

import { useState } from 'react';
import type { AttemptMeta, Slot } from '@/lib/api/types';

const ALL_SLOTS: Slot[] = ['A', 'B', 'C'];

/** Optional, post-verdict, self-reported context. Never changes the score or verdict. */
export function RecognitionPrompt({ roundId, attempt }: { roundId: string; attempt: AttemptMeta }) {
  const [selected, setSelected] = useState<Set<Slot>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ recognizedSlots: Slot[] | null; skipped: boolean } | null>(
    attempt.recognitionSubmitted ? { recognizedSlots: attempt.recognitionSlots, skipped: attempt.recognitionSkipped } : null,
  );
  const [error, setError] = useState<string | null>(null);

  async function submit(body: { recognizedSlots?: Slot[]; skipped?: boolean }) {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/rounds/${roundId}/recognition`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (res.ok) setResult({ recognizedSlots: json.recognizedSlots, skipped: json.skipped });
      else setError('Could not save that. Try again.');
    } catch {
      setError('Could not reach the server. Try again.');
    } finally {
      setSubmitting(false);
    }
  }

  function toggle(slot: Slot) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(slot)) next.delete(slot);
      else next.add(slot);
      return next;
    });
  }

  if (result) {
    const label = result.skipped
      ? 'Skipped'
      : result.recognizedSlots && result.recognizedSlots.length > 0
        ? `Recognized: ${result.recognizedSlots.join(', ')}`
        : 'None recognized';
    return (
      <div className="rounded-card bg-raised p-5 text-[15px]" data-testid="recognition-recorded">
        <p className="font-bold text-cream">Recognition noted — {label}.</p>
        <p className="mt-1 text-secondary">Self-reported context. It does not affect your score or verdict.</p>
      </div>
    );
  }

  return (
    <section className="rounded-card bg-raised p-5 sm:p-6" data-testid="recognition-prompt" aria-labelledby="recognition-heading">
      <h2 id="recognition-heading" className="text-[18px] font-extrabold tracking-[-0.02em]">
        Did you recognize any of these tokens before this round?
      </h2>
      <p className="mt-1 text-[15px] text-secondary">Optional. Self-reported, and never changes your score or verdict.</p>
      <div className="mt-4 flex flex-wrap gap-2">
        {ALL_SLOTS.map((slot) => (
          <button
            key={slot}
            type="button"
            disabled={submitting}
            onClick={() => toggle(slot)}
            aria-pressed={selected.has(slot)}
            data-testid={`recognition-slot-${slot}`}
            className={`min-h-[44px] rounded-control px-5 text-[15px] font-bold transition-colors duration-200 ${
              selected.has(slot) ? 'bg-burgundy-strong text-cream' : 'bg-raised-2 text-secondary hover:text-cream'
            }`}
          >
            Slot {slot}
          </button>
        ))}
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={submitting}
          onClick={() => submit({ recognizedSlots: Array.from(selected) })}
          data-testid="recognition-submit"
          className="btn-light min-h-[44px] text-[15px]"
        >
          {submitting ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          disabled={submitting}
          onClick={() => submit({ skipped: true })}
          data-testid="recognition-skip"
          className="btn-quiet min-h-[44px] text-[15px]"
        >
          Skip
        </button>
      </div>
      {error && (
        <p className="mt-3 text-[15px] font-semibold text-loss" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
