import Link from 'next/link';
import { BrandMark } from '@/components/brand/BrandMark';
import { Faq } from '@/components/site/Faq';
import { HeroPreview, HistoryPreview, StagePreview } from '@/components/site/Previews';

const PIPELINE = ['Candidate selection', 'Blind clues', 'Outcome prices', 'Verdict'];

export default function LandingPage() {
  return (
    <>
      {/* B. Hero */}
      <section className="page pb-20 pt-10 md:pb-28 md:pt-14">
        <div className="animate-rise-in">
          <p className="eyebrow">A blind market game powered by Nansen</p>
          <h1 className="type-hero mt-5 max-w-[15ch] lg:max-w-none">
            Can you read the market before the name changes your mind?
          </h1>
        </div>
        <div className="mt-10 grid items-start gap-10 md:mt-12 md:grid-cols-[1fr_1.05fr] md:gap-14">
          <div className="animate-rise-in md:pt-2">
            <p className="type-lead max-w-[34rem]">
              Compare three real tokens with their identities hidden. Lock your read. Reveal the tickers. Then see what
              recognition cost you.
            </p>
            <div className="mt-9 flex flex-col gap-3 sm:flex-row">
              <Link href="/play" className="btn-primary" data-testid="start-button">
                Play a blind round
              </Link>
              <Link href="#how-it-works" className="btn-quiet">
                See how it works
              </Link>
            </div>
          </div>
          <HeroPreview />
        </div>
      </section>

      {/* C. Problem statement */}
      <section className="page" aria-labelledby="problem-heading">
        <div className="rounded-panel bg-burgundy px-6 py-12 sm:px-12 sm:py-16 md:px-16 md:py-20">
          <div className="grid gap-10 md:grid-cols-[1.3fr_1fr] md:items-end">
            <div>
              <h2 id="problem-heading" className="type-section">
                Tickers change decisions.
              </h2>
              <p className="type-lead mt-6 max-w-xl text-cream/85">
                A familiar name can overpower a stronger signal. Trench Trials records your choice before and after the
                reveal, then measures the difference.
              </p>
            </div>
            <ul className="grid grid-cols-3 gap-4">
              {[
                ['3', 'real tokens'],
                ['2', 'decisions'],
                ['1', 'verified verdict'],
              ].map(([n, label]) => (
                <li key={label} className="rounded-card bg-canvas/35 p-4 sm:p-5">
                  <span className="block text-[44px] font-extrabold leading-none tracking-[-0.05em] sm:text-[56px]">
                    {n}
                  </span>
                  <span className="mt-2 block text-[14px] font-semibold text-cream/85 sm:text-[15px]">{label}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      {/* D. How it works */}
      <section id="how-it-works" className="page pt-24 md:pt-32" aria-labelledby="how-heading">
        <h2 id="how-heading" className="type-section max-w-3xl">
          Read. Reveal. Reckon.
        </h2>
        <ol className="mt-10 grid gap-6 md:grid-cols-3 md:gap-8">
          {[
            ['Read', 'Compare real point-in-time signals while identities and future prices stay hidden.'],
            ['Reveal', 'See the token names. The outcome remains sealed while you keep or switch.'],
            ['Reckon', 'Open the verdict and measure what recognition changed.'],
          ].map(([title, copy], i) => (
            <li key={title} className="relative">
              <div className="flex items-center gap-3">
                <span className="grid h-9 w-9 place-items-center rounded-full bg-burgundy-strong text-[15px] font-extrabold">
                  {i + 1}
                </span>
                <span className="h-px flex-1 bg-line md:block" aria-hidden="true" />
              </div>
              <h3 className="mt-5 text-[26px] font-extrabold tracking-[-0.03em]">{title}</h3>
              <p className="type-body mt-2 max-w-sm">{copy}</p>
            </li>
          ))}
        </ol>
        <div className="mt-10">
          <StagePreview />
        </div>
      </section>

      {/* E. Ticker Tax */}
      <section className="page pt-24 md:pt-32" aria-labelledby="tax-heading">
        <div className="grid gap-6 md:grid-cols-[0.9fr_1.1fr] md:items-stretch">
          <div className="flex flex-col justify-between gap-10 rounded-panel bg-burgundy-surface p-8 sm:p-10">
            <BrandMark size={56} />
            <div>
              <p className="eyebrow text-cream/70">Ticker Tax</p>
              <p className="mt-3 font-mono text-[15px] leading-relaxed text-cream sm:text-[17px]">
                blind-choice return − final-choice return
              </p>
              <p className="mt-3 text-[15px] text-cream/75">Keeping your blind pick costs exactly 0.0 pp.</p>
            </div>
          </div>
          <div className="flex flex-col justify-center rounded-panel bg-raised p-8 sm:p-12">
            <h2 id="tax-heading" className="type-section">
              Recognition has a price.
            </h2>
            <p className="type-lead mt-6 max-w-xl">
              Ticker Tax is the return gained or lost after the names appear. It remains inconclusive until you have
              made enough real decisions.
            </p>
          </div>
        </div>
      </section>

      {/* F. Nansen dependency */}
      <section id="nansen" className="page pt-24 md:pt-32" aria-labelledby="nansen-heading">
        <div className="grid gap-10 md:grid-cols-[1fr_1fr] md:items-end">
          <h2 id="nansen-heading" className="type-section">
            No Nansen data, no round.
          </h2>
          <p className="type-lead max-w-xl">
            Nansen determines which tokens qualify, what the player can see at the cutoff, and how the outcome resolves.
            If the required data cannot be verified, the round does not score.
          </p>
        </div>
        <ol className="mt-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label="Round pipeline">
          {PIPELINE.map((step, i) => (
            <li key={step} className="flex items-center gap-3 rounded-card bg-raised px-5 py-5">
              <span className="font-mono text-[14px] text-subtle">0{i + 1}</span>
              <span className="text-[17px] font-bold">{step}</span>
              {i < PIPELINE.length - 1 && (
                <span className="ml-auto hidden text-subtle lg:inline" aria-hidden="true">
                  →
                </span>
              )}
            </li>
          ))}
        </ol>
      </section>

      {/* G. History */}
      <section className="page pt-24 md:pt-32" aria-labelledby="history-heading">
        <div className="grid gap-8 md:grid-cols-[1.1fr_0.9fr] md:items-center">
          <div>
            <h2 id="history-heading" className="type-section">
              Your read leaves a record.
            </h2>
            <p className="type-lead mt-6 max-w-xl">
              Play without an account. Your completed trials are saved in this browser and appear in History.
            </p>
            <Link href="/history" className="link-quiet mt-6 inline-flex text-[17px]">
              Open History
            </Link>
          </div>
          <HistoryPreview />
        </div>
      </section>

      {/* H. FAQ */}
      <section id="faq" className="page pt-24 md:pt-32" aria-labelledby="faq-heading">
        <div className="grid gap-10 md:grid-cols-[0.8fr_1.2fr]">
          <h2 id="faq-heading" className="type-section">
            Questions, answered.
          </h2>
          <Faq />
        </div>
      </section>

      {/* I. Final CTA */}
      <section className="page pt-24 md:pt-32">
        <div className="flex flex-col items-start gap-8 rounded-panel bg-burgundy px-6 py-14 sm:px-12 md:flex-row md:items-center md:justify-between md:px-16">
          <div className="max-w-2xl">
            <h2 className="type-section">Make the call before the ticker does.</h2>
            <p className="type-lead mt-5 text-cream/85">
              No wallet, no signup. Press start, play one verified round as a guest, and your result is saved to
              History in this browser.
            </p>
          </div>
          <Link href="/play" className="btn-light shrink-0">
            Start a verified trial
          </Link>
        </div>
      </section>
    </>
  );
}
