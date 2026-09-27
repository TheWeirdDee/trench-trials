import Link from 'next/link';
import { Wordmark } from '@/components/brand/BrandMark';

export function SiteFooter() {
  return (
    <footer className="mt-24 bg-raised" data-testid="site-footer">
      <div className="page grid gap-10 py-14 md:grid-cols-[1.2fr_1fr]">
        <div className="space-y-5">
          <Wordmark />
          <p className="max-w-md text-[15px] leading-relaxed text-secondary">
            Decision-bias training for crypto traders. Nansen selects the tokens, supplies the blind clues and decides
            the outcome. Not financial advice: rounds use past market data to measure decisions.
          </p>
          <a
            href="https://www.nansen.ai/"
            target="_blank"
            rel="noopener noreferrer"
            className="link-quiet inline-flex text-[15px]"
          >
            Powered by Nansen API
          </a>
        </div>
        <nav aria-label="Footer" className="grid grid-cols-2 gap-x-8 gap-y-3 text-[15px] sm:grid-cols-3 md:justify-self-end">
          <Link href="/play" className="font-semibold text-secondary hover:text-cream">
            Play
          </Link>
          <Link href="/docs#how-it-works" className="font-semibold text-secondary hover:text-cream">
            How it works
          </Link>
          <Link href="/docs" className="font-semibold text-secondary hover:text-cream">
            Docs
          </Link>
          <Link href="/evidence" className="font-semibold text-secondary hover:text-cream" data-testid="footer-evidence">
            Evidence
          </Link>
          <Link href="/history" className="font-semibold text-secondary hover:text-cream">
            History
          </Link>
          <Link href="/docs#faq" className="font-semibold text-secondary hover:text-cream">
            FAQ
          </Link>
          <a
            href="https://github.com/TheWeirdDee/trench-trials"
            target="_blank"
            rel="noopener noreferrer"
            className="font-semibold text-secondary hover:text-cream"
          >
            GitHub
          </a>
        </nav>
      </div>
    </footer>
  );
}
