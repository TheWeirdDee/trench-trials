import Link from 'next/link';
import { Faq } from '@/components/site/Faq';

export const metadata = {
  title: 'Docs · Trench Trials',
  description: 'How Trench Trials works: Blind Pick, Unmask, Verdict, Ticker Tax, and how Nansen data powers every round.',
};

const SECTIONS: Array<{ id: string; title: string }> = [
  { id: 'what-it-is', title: 'What Trench Trials is' },
  { id: 'problem', title: 'The problem it tests' },
  { id: 'how-it-works', title: 'How a round works' },
  { id: 'scoring', title: 'Scoring' },
  { id: 'ticker-tax', title: 'Ticker Tax' },
  { id: 'replay', title: 'Replay' },
  { id: 'daily', title: 'Daily' },
  { id: 'live', title: 'Live' },
  { id: 'history', title: 'Your History' },
  { id: 'privacy', title: 'Privacy and retention' },
  { id: 'nansen', title: 'How Nansen powers the game' },
  { id: 'provenance', title: 'Data provenance' },
  { id: 'verified', title: 'What “verified” means' },
  { id: 'leakage', title: 'How the future stays hidden' },
  { id: 'invalid', title: 'Why a round can be invalid' },
  { id: 'commitments', title: 'Commitments' },
  { id: 'faq', title: 'FAQ' },
  { id: 'disclaimer', title: 'Not financial advice' },
];

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-heading`} className="scroll-mt-24">
      <h2 id={`${id}-heading`} className="text-[clamp(28px,3.2vw,40px)] font-extrabold leading-[1.08] tracking-[-0.03em]">
        {title}
      </h2>
      <div className="docs-prose mt-5 grid max-w-[68ch] gap-4 text-[17px] leading-[1.65] text-secondary sm:text-[18px]">
        {children}
      </div>
    </section>
  );
}

function Stage({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-card bg-raised p-5 sm:p-6">
      <p className="flex items-center gap-3 text-[18px] font-extrabold text-cream">
        <span className="grid h-8 w-8 place-items-center rounded-full bg-burgundy-strong text-[15px]">{n}</span>
        {title}
      </p>
      <div className="mt-3 grid gap-3 text-[16px] leading-relaxed text-secondary sm:text-[17px]">{children}</div>
    </div>
  );
}

export default function DocsPage() {
  return (
    <div className="page py-14 sm:py-20">
      <header className="max-w-4xl">
        <p className="eyebrow">Docs</p>
        <h1 className="type-section mt-4">How Trench Trials works.</h1>
        <p className="type-lead mt-6 max-w-3xl">
          The rules, the data, and the guarantees behind every round — in plain language.
        </p>
      </header>

      <div className="mt-14 grid gap-12 lg:grid-cols-[240px_1fr] lg:gap-16">
        <nav aria-label="On this page" className="lg:sticky lg:top-24 lg:self-start">
          <p className="text-[14px] font-bold text-subtle">On this page</p>
          <ul className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-[15px] sm:grid-cols-3 lg:grid-cols-1">
            {SECTIONS.map((s) => (
              <li key={s.id}>
                <a href={`#${s.id}`} className="font-semibold text-secondary transition-colors hover:text-cream">
                  {s.title}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <div className="grid gap-16">
          <Section id="what-it-is" title="What Trench Trials is">
            <p>
              Trench Trials is a blind market game. Each round shows three real tokens with their names hidden and asks
              which one returned the most over the round’s outcome window. You answer twice: once blind, and once after
              the names are revealed. The verdict shows what actually happened and what the reveal did to your choice.
            </p>
          </Section>

          <Section id="problem" title="The problem it tests">
            <p>
              A familiar ticker can overpower a stronger signal. People anchor on names they know, avoid names they
              don’t, and rarely find out what that bias costs them. Trench Trials records your choice before and after
              the reveal, on the same data, and measures the difference against a real, verified outcome.
            </p>
          </Section>

          <Section id="how-it-works" title="How a round works">
            <div className="grid gap-3">
              <Stage n={1} title="Blind Pick">
                <p>
                  You see three candidates labelled A, B and C. Each shows four signals from Nansen data that existed at
                  the round’s cutoff:
                </p>
                <ul className="grid gap-1.5 pl-5 [list-style:disc]">
                  <li>
                    <strong className="text-cream">Buy / sell balance</strong> — buy volume against sell volume over the
                    day before the cutoff.
                  </li>
                  <li>
                    <strong className="text-cream">Trading pace</strong> — that day’s volume against the prior week’s daily
                    average.
                  </li>
                  <li>
                    <strong className="text-cream">Netflow vs liquidity</strong> — net inflow over that day relative to
                    liquidity at the cutoff.
                  </li>
                  <li>
                    <strong className="text-cream">7-day momentum</strong> — price change over the seven days ending at the
                    cutoff.
                  </li>
                </ul>
                <p>Pick the candidate you think did best and lock it. Locking cannot be undone.</p>
              </Stage>
              <Stage n={2} title="Unmask">
                <p>
                  Locking reveals all three token names. The outcome stays sealed. A short decision window starts, timed
                  by the server’s clock — refreshing the page or changing your device clock does not change it. Keep your
                  blind pick or switch to another candidate.
                </p>
                <p>If the window closes before you decide, your blind pick stands and is recorded as a timeout.</p>
              </Stage>
              <Stage n={3} title="Verdict">
                <p>
                  The round opens: all three real returns, the winner, your blind and final choices, the switch impact
                  and your Ticker Tax contribution. A winning final pick earns 100 points; anything else earns 0.
                  Returns within 0.01 percentage points of each other share the win.
                </p>
                <p>Verification details — the exact cutoff, the commitment and the Nansen responses used — sit below.</p>
              </Stage>
            </div>
          </Section>

          <Section id="scoring" title="Scoring">
            <ul className="grid gap-2 pl-5 [list-style:disc]">
              <li>
                <strong className="text-cream">Points.</strong> A final pick that is a winner earns 100 points; any other
                final pick earns 0. Returns within 0.01 percentage points of the best share the win, and each earns 100.
              </li>
              <li>
                <strong className="text-cream">Switch impact.</strong> Final return minus blind return, in percentage
                points. It is 0.0 when you keep your pick.
              </li>
              <li>
                <strong className="text-cream">Accuracy.</strong> Blind accuracy counts how often your blind pick was a
                winner; final accuracy counts your final pick. Both use the first time you play each round.
              </li>
              <li>
                <strong className="text-cream">What never scores.</strong> A repeat of a round you already played, an
                abandoned Blind Pick, a Live prediction until its round resolves, and any invalid round.
              </li>
            </ul>
          </Section>

          <Section id="ticker-tax" title="Ticker Tax">
            <p>
              Ticker Tax is what changing your mind after the reveal cost or earned you: your blind pick’s return minus
              your final pick’s return, in percentage points. Keeping your pick contributes exactly zero. A positive
              average means the names pulled you away from better reads; a negative one means they helped.
            </p>
            <p>
              Timeouts are excluded because they are not decisions. Your Ticker Tax reads “insufficient evidence” until
              you have made five explicit keep-or-switch decisions on rounds you are playing for the first time.
            </p>
          </Section>

          <Section id="replay" title="Replay">
            <p>
              Replay rounds are built from a past cutoff whose outcome is already known and verified. You are never
              served a round you have already played. When you have played every verified round, the game says so —
              it does not generate filler.
            </p>
          </Section>

          <Section id="daily" title="Daily">
            <p>
              The Daily is one verified round assigned to a UTC calendar date, the same for every player that day. It
              appears in the menu only on days a verified round has actually been assigned. A round used as a Daily is
              not also served as a Replay while it is current. Sharing your Daily result reveals what kind of decision
              you made, never the answer.
            </p>
          </Section>

          <Section id="live" title="Live">
            <p>
              A Live trial is measured in real time. The candidates and their signals come from Nansen’s current token
              screener at the moment the round opens (trailing 24 hours and 7 days), and every candidate must pass the
              eligibility policy: a memecoin by Nansen’s sector filter, not an excluded symbol, with at least $100K traded
              in 24 hours. Entry stays open for five minutes,
              and the outcome is measured over the next 24 hours between two fixed five-minute candle boundaries. All Live
              times are shown in UTC.
            </p>
            <p>
              After you lock, your prediction is pending until the window ends and the closing candles are available
              from Nansen. Live appears in the menu only while a Live trial is open for entry or has a verified result.
            </p>
          </Section>

          <Section id="history" title="Your History">
            <p>
              You play as a guest — no wallet, no signup. Your first locked pick sets a signed, HttpOnly cookie on this
              browser that links it to your decisions on our server. History lists every decided trial with your
              blind accuracy, final accuracy, switches helped and hurt, average switch impact and Ticker Tax.
            </p>
            <p>
              Only decided trials count. An abandoned Blind Pick is never counted, and replays of a round you already
              played are listed but excluded from the metrics. History does not sync across browsers or devices;
              clearing cookies starts a new one.
            </p>
          </Section>

          <Section id="privacy" title="Privacy and retention">
            <ul className="grid gap-2 pl-5 [list-style:disc]">
              <li>
                <strong className="text-cream">What is stored.</strong> A random guest ID in a signed, HttpOnly cookie
                (one year), and on our server the decisions made under it: picks, the times they were locked, and optional
                recognition answers. No name, email, wallet or payment details are ever requested.
              </li>
              <li>
                <strong className="text-cream">In your browser.</strong> The cookie above, and a note that you have seen
                the onboarding sheet. There are no advertising or analytics trackers.
              </li>
              <li>
                <strong className="text-cream">Limits.</strong> History belongs to this browser: another browser or
                device, or clearing cookies, starts a new one, and it cannot be moved or recovered. There is no
                self-service way yet to delete the decisions stored for a guest ID.
              </li>
            </ul>
          </Section>

          <Section id="nansen" title="How Nansen powers the game">
            <p>
              Every round depends on the Nansen API. For historical rounds, Nansen’s historical token screener, read as
              of the day before the cutoff, decides which tokens qualify and supplies the signals you see, and Nansen’s
              historical price candles decide the outcome. Live rounds take their candidates from Nansen’s current token screener and their
              outcome from five-minute price candles.
            </p>
            <p className="rounded-card bg-raised p-5 text-[16px] text-cream">
              Candidate selection → Blind clues → Outcome prices → Verdict
            </p>
            <p>
              If Nansen data a round needs cannot be retrieved and verified, the round is not created — no other source
              is substituted and nothing is estimated.
            </p>
          </Section>

          <Section id="provenance" title="Data provenance">
            <p>
              Each round keeps a receipt for every Nansen response it was built from: the endpoint, the exact request,
              the SHA-256 of the response, Nansen’s request ID, the credits it cost and when it arrived. Every request
              attempt — including failures and retries — is also written to a call log before the next one is sent.
            </p>
            <p>
              The verification panel under each verdict lists those receipts and lets you recompute the round’s
              commitment in your browser. Raw responses are kept privately by the operator as evidence and are not
              republished, in line with Nansen’s redistribution terms.
            </p>
          </Section>

          <Section id="verified" title="What “verified” means">
            <p>A round is called verified only when four separate checks hold. Each is a different claim:</p>
            <ul className="grid gap-2">
              <li>
                <strong className="text-cream">Provenance.</strong> Every input traces to a logged Nansen response, by
                SHA-256 and request ID, and is sealed in the round’s commitment before play.
              </li>
              <li>
                <strong className="text-cream">Calculation.</strong> Each return is exit close ÷ entry close − 1 on the
                committed candles, and anyone can recompute it from the revealed manifest.
              </li>
              <li>
                <strong className="text-cream">Eligibility.</strong> The round was reviewed and approved under the
                current eligibility policy: freely traded tokens (no stablecoins, wrapped or bridged majors, staking or
                tokenized assets), liquidity and trading-volume floors, complete price candles, and no near-duplicate of
                another round. Tokens the policy cannot positively classify are excluded.
              </li>
              <li>
                <strong className="text-cream">Availability.</strong> Only approved rounds are offered for Replay, the
                Daily or Live. A round can later be withdrawn: it leaves play and scoring, stays listed in the History of
                anyone who played it, and nothing is deleted.
              </li>
            </ul>
          </Section>

          <Section id="leakage" title="How the future stays hidden">
            <p>
              The server decides what each stage may contain. During Blind Pick, responses carry only the slot letters
              and signal buckets — no names, addresses, exact dates, prices or returns. Names are added only after your
              blind pick is locked, and prices and returns only after your final choice is locked. Your browser never
              receives information early and hides it; it simply does not receive it.
            </p>
          </Section>

          <Section id="invalid" title="Why a round can be invalid">
            <p>
              A round is invalid when the data it committed to cannot be verified — for example, when a closing price
              candle is missing at the exact measurement boundary. An invalid round is never scored and no winner is
              manufactured. It stays visible in the audit record so the failure is transparent.
            </p>
          </Section>

          <Section id="commitments" title="Commitments">
            <p>
              Before a round opens, everything that decides it — the candidates, their signals and the outcome rules — is
              written into a manifest and sealed with a SHA-256 hash together with a secret random value. The hash is
              published; the manifest stays private.
            </p>
            <p>
              At the verdict, the manifest and the random value are revealed, so anyone can recompute the hash and
              confirm the round was not changed after players started choosing.
            </p>
          </Section>

          <Section id="faq" title="FAQ">
            <Faq />
          </Section>

          <Section id="disclaimer" title="Not financial advice">
            <p>
              Trench Trials measures decision-making on past and time-boxed market data. Nothing here is a
              recommendation to buy or sell anything. Token prices are volatile and past returns say nothing about
              future returns.
            </p>
          </Section>

          <div className="rounded-panel bg-burgundy-surface p-8 sm:p-10">
            <p className="text-[clamp(26px,3vw,36px)] font-extrabold leading-[1.1] tracking-[-0.03em] text-cream">
              Still have a question?
            </p>
            <div className="mt-6 flex flex-col gap-3 sm:flex-row">
              <a href="#faq" className="btn-light">
                Read the FAQ
              </a>
              <Link href="/play" className="btn-primary">
                Play a blind round
              </Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
