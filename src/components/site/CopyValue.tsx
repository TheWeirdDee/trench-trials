'use client';

import { useState } from 'react';

/** A shortened identifier with a control that copies the full value. */
export function CopyValue({ value, label, keep = 10 }: { value: string; label: string; keep?: number }) {
  const [copied, setCopied] = useState(false);
  const short = value.length > keep * 2 + 1 ? `${value.slice(0, keep)}…${value.slice(-6)}` : value;
  return (
    <span className="inline-flex items-center gap-2">
      <code className="mono-value break-all text-[14px] text-cream" title={value}>
        {short}
      </code>
      <button
        type="button"
        className="rounded-control px-2 py-1 text-[14px] font-semibold text-secondary underline decoration-line underline-offset-4 hover:text-cream"
        aria-label={`Copy ${label}`}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          } catch {
            setCopied(false);
          }
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </span>
  );
}
