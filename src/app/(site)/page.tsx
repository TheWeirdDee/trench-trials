import Link from 'next/link';
import { BrandMark } from '@/components/brand/BrandMark';
import { Faq, LANDING_QUESTIONS } from '@/components/site/Faq';
import { HeroPreview, HistoryPreview, StagePreview } from '@/components/site/Previews';

/** Each stage links to its proof on the Evidence page. */
const PIPELINE: Array<[string, string]> = [
  ['Nansen screener', 'screener'],
  ['Eligibility', 'eligibility'],
  ['Blind clues', 'clues'],
  ['Commitment', 'commitment'],
  ['Player choices', 'choices'],
  ['Nansen OHLCV', 'ohlcv'],
  ['Verdict', 'verdict'],
  ['Ticker Tax', 'ticker-tax'],
];

const STEPS: Array<[string, string]> = [
  ['Read the signals', 'Compare three anonymous assets using point-in-time Nansen data.'],
  ['Meet the names', 'See the tickers while the future remains hidden, then stick or switch.'],
  ['Measure the bias', 'Reveal the outcome and calculate what recognition gained or cost.'],
];

const COMPARISON: Array<[string, string]> = [
  ['Existing dashboards', 'Show more information.'],
  ['Prediction games', 'Score the final guess.'],
  ['Trench Trials', 'Measures what revealing the identity changed.'],
];

export default function LandingPage() {
  return (
    <>
      {/* Hero: who it is for, the bias, the two-stage decision, Nansen as the evidence */}
      <section className="page pb-20 pt-10 md:pb-28 md:pt-14">
        <div className="animate-rise-in">
          <p className="eyebrow" data-testid="hero-eyebrow">
            Decision-bias training for crypto traders
          </p>
          <h1 className="type-hero mt-5 max-w-[15ch] lg:max-w-none">
            Can you read the market before the ticker changes your mind?
          </h1>
        </div>
        <div className="mt-10 grid items-start gap-10 md:mt-12 md:grid-cols-[1fr_1.05fr] md:gap-14">
          <div className="animate-rise-in md:pt-2">
            <p className="type-lead max-w-[34rem]">
              Trench Trials blinds token identities, asks you to choose using Nansen onchain signals, then reveals the
              names and measures exactly what recognition gained — or cost — you.
            </p>
            <div className="mt-9 flex flex-col gap-3 sm:flex-row">
              <Link href="/play" className="btn-primary" data-testid="start-button">
                Start a blind trial
              </Link>
              <Link href="/evidence" className="btn-quiet" data-testid="hero-evidence">
                See the Nansen evidence
              </Link>
            </div>
            <p className="mt-6 text-[15px] font-semibold text-secondary" data-testid="trust-line">
              Real Nansen data · Frozen before play · Hash-verified outcomes
            </p>
          </div>
          <HeroPreview />
        </div>
      </section>

      {/* The problem, the user and the outcome */}
      <section className="page" aria-labelledby="problem-heading">
        <div className="rounded-panel bg-burgundy px-6 py-12 sm:px-12 sm:py-16 md:px-16 md:py-20">
          <h2 id="problem-heading" className="type-section max-w-4xl">
            The problem isn’t a lack of data. It’s knowing whether you followed it.
          </h2>
          <p className="type-lead mt-6 max-w-3xl text-cream/85">
            Crypto traders have more dashboards than ever, but familiar tickers and narratives still distort decisions.
            Ordinary backtests record only the final call. Trench Trials records the choice before and after identity is
            revealed and prices the difference.
          </p>
          <dl className="mt-10 grid gap-4 md:grid-cols-2">
            <div className="rounded-card bg-canvas/35 p-5 sm:p-6">
              <dt className="eyebrow text-cream/70">Built for</dt>
              <dd className="mt-2 text-[18px] font-bold leading-snug">
                Individual crypto traders and analysts who want to test whether they follow market signals or familiar
                narratives.
              </dd>
            </div>
            <div className="rounded-card bg-canvas/35 p-5 sm:p-6">
              <dt className="eyebrow text-cream/70">The outcome</dt>
              <dd className="mt-2 text-[18px] font-bold leading-snug">
                Measure and reduce narrative bias through repeated blinded decisions.
              </dd>
            </div>
          </dl>
        </div>
      </section>

      {/* How it works */}
      <section id="how-it-works" className="page pt-24 md:pt-32" aria-labelledby="how-heading">
        <h2 id="how-heading" className="type-section max-w-3xl">
          One market read. Two decisions. One measurement.
        </h2>
        <ol className="mt-10 grid gap-6 md:grid-cols-3 md:gap-8">
          {STEPS.map(([title, copy], i) => (
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

      {/* Why it is different */}
      <section className="page pt-24 md:pt-32" aria-labelledby="different-heading">
        <h2 id="different-heading" className="type-section max-w-4xl">
          Prediction games measure whether you were right. Trench Trials measures whether the ticker changed your mind.
        </h2>
        <ul className="mt-10 grid gap-4 md:grid-cols-3" aria-label="How it compares">
          {COMPARISON.map(([name, what], i) => (
            <li
              key={name}
              className={`rounded-card p-6 ${i === COMPARISON.length - 1 ? 'bg-burgundy-surface' : 'bg-raised'}`}
            >
              <p className="text-[15px] font-bold text-secondary">{name}</p>
              <p className="mt-2 text-[20px] font-extrabold leading-snug tracking-[-0.02em]">{what}</p>
            </li>
          ))}
        </ul>
      </section>

      {/* Ticker Tax */}
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
              Ticker Tax is the return gained or lost after the names appear. After five explicit decisions it becomes
              your personal measure of narrative bias.
            </p>
          </div>
        </div>
      </section>

      {/* Why Nansen is load-bearing */}
      <section id="nansen" className="page pt-24 md:pt-32" aria-labelledby="nansen-heading">
        <div className="grid gap-10 md:grid-cols-[1fr_1fr] md:items-end">
          <h2 id="nansen-heading" className="type-section">
            Nansen is the evidence.
          </h2>
          <p className="type-lead max-w-xl">
            Nansen selects the eligible tokens, supplies every blind clue and provides the price candles that determine
            the verdict. Remove Nansen and no new round can be created.
          </p>
        </div>
        <ol className="mt-10 flex flex-wrap items-center gap-2" aria-label="Round pipeline" data-testid="pipeline">
          {PIPELINE.map(([step, anchor], i) => (
            <li key={step} className="flex items-center gap-2">
              <Link
                href={`/evidence#${anchor}`}
                className="rounded-full bg-raised px-4 py-2.5 text-[15px] font-bold transition-colors hover:bg-raised-2"
              >
                {step}
              </Link>
              {i < PIPELINE.length - 1 && (
                <span className="text-subtle" aria-hidden="true">
                  →
                </span>
              )}
            </li>
          ))}
        </ol>
        <p className="type-body mt-8 max-w-3xl">
          Existing rounds remain playable during an API outage because their authenticated Nansen inputs are frozen and
          hash-sealed before play. New Replay, Daily and Live rounds cannot be produced without Nansen, and no alternate
          source is substituted.
        </p>
        <Link href="/evidence" className="link-quiet mt-4 inline-flex text-[17px]">
          See the evidence
        </Link>
      </section>

      {/* History and the shared Daily */}
      <section className="page pt-24 md:pt-32" aria-labelledby="history-heading">
        <div className="grid gap-8 md:grid-cols-[1.1fr_0.9fr] md:items-center">
          <div>
            <h2 id="history-heading" className="type-section">
              Your read leaves a record.
            </h2>
            <p className="type-lead mt-6 max-w-xl">
              Every trial adds to your History and your Ticker Tax. A shared Daily Trial gives trading communities a
              common decision-bias calibration exercise.
            </p>
            <p className="type-body mt-4 max-w-xl">
              No account: your History is saved to this browser as an anonymous profile.
            </p>
            <Link href="/history" className="link-quiet mt-6 inline-flex text-[17px]">
              Open History
            </Link>
          </div>
          <HistoryPreview />
        </div>
      </section>

      {/* FAQ */}
      <section id="faq" className="page pt-24 md:pt-32" aria-labelledby="faq-heading">
        <div className="grid gap-10 md:grid-cols-[0.8fr_1.2fr]">
          <div>
            <h2 id="faq-heading" className="type-section">
              Questions, answered.
            </h2>
            <Link href="/docs#faq" className="link-quiet mt-6 inline-flex text-[17px]">
              All questions
            </Link>
          </div>
          <Faq questions={LANDING_QUESTIONS} />
        </div>
      </section>

      {/* Final CTA */}
      <section className="page pt-24 md:pt-32">
        <div className="flex flex-col items-start gap-8 rounded-panel bg-burgundy px-6 py-14 sm:px-12 md:flex-row md:items-center md:justify-between md:px-16">
          <div className="max-w-2xl">
            <h2 className="type-section">Make the call before the ticker does.</h2>
            <p className="type-lead mt-5 text-cream/85">
              No wallet, no signup. Start as a guest; your History stays in this browser.
            </p>
          </div>
          <Link href="/play" className="btn-light shrink-0">
            Start a blind trial
          </Link>
        </div>
      </section>
    </>
  );
}
