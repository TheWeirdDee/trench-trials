'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { BrandMark } from '@/components/brand/BrandMark';

interface NavItem {
  href: string;
  label: string;
  testId: string;
  match: (path: string) => boolean;
}

/** Application navigation. Daily and Live appear only when they genuinely exist. */
export function AppHeader({ daily, live }: { daily: boolean; live: boolean }) {
  const pathname = usePathname() ?? '';
  const items: NavItem[] = [
    { href: '/play', label: 'Play', testId: 'nav-play', match: (p) => p === '/play' || p.startsWith('/round') },
    ...(daily ? [{ href: '/daily', label: 'Daily', testId: 'nav-daily', match: (p: string) => p === '/daily' }] : []),
    ...(live ? [{ href: '/live', label: 'Live', testId: 'nav-live', match: (p: string) => p === '/live' }] : []),
    { href: '/history', label: 'History', testId: 'nav-history', match: (p) => p === '/history' },
    { href: '/docs', label: 'Docs', testId: 'nav-docs', match: (p) => p.startsWith('/docs') },
    { href: '/evidence', label: 'Evidence', testId: 'nav-evidence', match: (p) => p.startsWith('/evidence') },
  ];

  return (
    <header className="sticky top-0 z-40 bg-canvas/90 backdrop-blur-md" data-testid="app-header">
      <nav className="page flex h-16 items-center justify-between gap-4" aria-label="Game">
        <Link href="/" aria-label="Trench Trials home" className="flex shrink-0 items-center gap-2.5">
          <BrandMark size={28} />
          <span className="hidden text-[17px] font-extrabold tracking-[-0.03em] sm:inline">Trench Trials</span>
        </Link>
        <ul className="flex items-center gap-1 overflow-x-auto" data-testid="main-navigation">
          {items.map((item) => {
            const active = item.match(pathname);
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  data-testid={item.testId}
                  aria-current={active ? 'page' : undefined}
                  className={`inline-flex min-h-[44px] items-center rounded-control px-3 text-[15px] font-bold transition-colors sm:px-4 ${
                    active ? 'bg-raised-2 text-cream' : 'text-secondary hover:text-cream'
                  }`}
                >
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </header>
  );
}
