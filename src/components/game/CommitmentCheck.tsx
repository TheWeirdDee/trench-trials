'use client';

import { useState } from 'react';
import { canonicalize } from '@/lib/domain/canonical';
import type { CommitmentReveal } from '@/lib/api/types';

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

const LABEL: Record<CommitmentReveal['kind'], string> = {
  initial: 'Round commitment — sealed before the round opened',
  resolution: 'Resolution commitment — sealed when the outcome was recorded',
};

/** Recomputes a revealed commitment in the browser: SHA-256 of canonical JSON { manifest, nonce }. */
export function CommitmentCheck({ reveal }: { reveal: CommitmentReveal }) {
  const [state, setState] = useState<'idle' | 'checking' | 'match' | 'mismatch' | 'unsupported'>('idle');

  async function check() {
    if (typeof crypto === 'undefined' || !crypto.subtle) {
      setState('unsupported');
      return;
    }
    setState('checking');
    try {
      const recomputed = await sha256Hex(canonicalize({ manifest: reveal.manifest, nonce: reveal.nonce }));
      setState(recomputed === reveal.hash ? 'match' : 'mismatch');
    } catch {
      setState('unsupported');
    }
  }

  return (
    <div className="rounded-control bg-raised-2 p-4" data-testid={`commitment-${reveal.kind}`}>
      <p className="text-[14px] font-bold text-cream">{LABEL[reveal.kind]}</p>
      <p className="mt-2 text-[14px] font-semibold text-subtle">SHA-256</p>
      <p className="mono-value break-all text-cream">{reveal.hash}</p>
      <p className="mt-2 text-[14px] font-semibold text-subtle">Secret nonce, revealed now</p>
      <p className="mono-value break-all">{reveal.nonce}</p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={check}
          disabled={state === 'checking'}
          className="btn-quiet min-h-[44px] text-[15px]"
          data-testid={`commitment-check-${reveal.kind}`}
        >
          {state === 'checking' ? 'Recomputing…' : 'Recompute in this browser'}
        </button>
        <span role="status" className="text-[15px] font-semibold" data-testid={`commitment-result-${reveal.kind}`}>
          {state === 'match' && <span className="text-gain">Match — unchanged since it was sealed.</span>}
          {state === 'mismatch' && <span className="text-loss">Mismatch — this manifest does not match its commitment.</span>}
          {state === 'unsupported' && (
            <span className="text-secondary">This browser cannot compute SHA-256 here. Run npm run verify instead.</span>
          )}
        </span>
      </div>
      <details className="mt-3">
        <summary className="cursor-pointer text-[14px] font-semibold text-secondary hover:text-cream">
          View the committed manifest
        </summary>
        <pre className="mt-2 max-h-72 overflow-auto rounded-control bg-canvas p-3 font-mono text-[14px] leading-relaxed text-secondary">
          {JSON.stringify(reveal.manifest, null, 2)}
        </pre>
      </details>
    </div>
  );
}
