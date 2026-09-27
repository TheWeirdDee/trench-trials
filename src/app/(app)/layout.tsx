import Link from 'next/link';
import { AppHeader } from '@/components/app/AppHeader';
import { getModeAvailability } from '@/lib/repo/availability';

// Navigation reflects live state (is a Daily assigned, is Live valid), so render per request.
export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const availability = await getModeAvailability();
  return (
    <>
      <AppHeader daily={availability.daily} live={availability.live} />
      <main className="min-h-[calc(100vh-64px)]">{children}</main>
      <footer className="page flex flex-col gap-3 py-10 text-[14px] text-subtle sm:flex-row sm:items-center sm:justify-between">
        <a href="https://www.nansen.ai/" target="_blank" rel="noopener noreferrer" className="link-quiet">
          Powered by Nansen API
        </a>
        <p>Past market data, used to measure decisions. Not financial advice.</p>
        <Link href="/evidence" className="font-semibold text-secondary hover:text-cream">
          See the Nansen evidence
        </Link>
      </footer>
    </>
  );
}
