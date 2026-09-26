'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Wordmark } from '@/components/brand/BrandMark';

const LINKS = [
  { href: '/#how-it-works', label: 'How it works' },
  { href: '/#nansen', label: 'Why Nansen' },
  { href: '/#faq', label: 'FAQ' },
  { href: '/docs', label: 'Docs' },
];

/** Public site navigation. Daily and Live are not promised here. */
export function SiteHeader() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <header className="sticky top-0 z-40 bg-canvas/85 backdrop-blur-md" data-testid="site-header">
      <nav className="page flex h-[72px] items-center justify-between gap-6" aria-label="Primary">
        <Link href="/" aria-label="Trench Trials home" className="shrink-0">
          <Wordmark />
        </Link>

        <ul className="hidden items-center gap-8 md:flex">
          {LINKS.map((l) => (
            <li key={l.href}>
              <Link href={l.href} className="text-[15px] font-semibold text-secondary transition-colors hover:text-cream">
                {l.label}
              </Link>
            </li>
          ))}
        </ul>

        <div className="flex items-center gap-2">
          <Link href="/play" className="btn-primary min-h-[44px] px-5 text-[15px]" data-testid="nav-play">
            Play
          </Link>
          <button
            type="button"
            className="btn-quiet min-h-[44px] w-11 px-0 md:hidden"
            aria-expanded={open}
            aria-controls="site-menu"
            aria-label={open ? 'Close menu' : 'Open menu'}
            onClick={() => setOpen((v) => !v)}
          >
            <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
              {open ? (
                <path d="M5 5l10 10M15 5L5 15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              ) : (
                <path d="M3 6h14M3 10h14M3 14h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              )}
            </svg>
          </button>
        </div>
      </nav>

      {open && (
        <div id="site-menu" className="page pb-5 md:hidden">
          <ul className="surface grid gap-1 p-2">
            {LINKS.map((l) => (
              <li key={l.href}>
                <Link
                  href={l.href}
                  onClick={() => setOpen(false)}
                  className="block rounded-control px-4 py-3 text-[17px] font-semibold text-cream hover:bg-raised-2"
                >
                  {l.label}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </header>
  );
}
