import Link from 'next/link';
import { Faq } from '@/components/site/Faq';

export const metadata = {
  title: 'Docs · Trench Trials',
  description:
    'Decision-bias training for crypto traders: how Blind Pick, Unmask, Verdict and Ticker Tax work, and how Nansen data builds every round.',
};

const REPO = 'https://github.com/TheWeirdDee/trench-trials';

const GROUPS: Array<{ title: string; sections: Array<{ id: string; title: string }> }> = [
  {
    title: 'Product',
    sections: [
      { id: 'what-it-is', title: 'What Trench Trials is' },
      { id: 'problem', title: 'The problem' },
      { id: 'who', title: 'Who it is for' },
      { id: 'how-it-works', title: 'How a round works' },
      { id: 'scoring', title: 'Scoring' },
      { id: 'ticker-tax', title: 'Ticker Tax' },
      { id: 'replay', title: 'Replay' },
      { id: 'daily', title: 'Daily' },
      { id: 'live', title: 'Live' },
      { id: 'history', title: 'Your History' },
      { id: 'privacy', title: 'Privacy and retention' },
      { id: 'faq', title: 'FAQ' },
    ],
  },
  {
    title: 'Trust and data',
    sections: [
      { id: 'nansen', title: 'Why Nansen is load-bearing' },
      { id: 'frozen', title: 'Why inputs are frozen' },
      { id: 'provenance', title: 'Data provenance' },
      { id: 'verified', title: 'What verification means' },
      { id: 'leakage', title: 'How the future stays hidden' },
      { id: 'invalid', title: 'Why a round can be invalid' },
      { id: 'commitments', title: 'Commitments' },
      { id: 'disclaimer', title: 'Not financial advice' },
    ],
  },
];

const BUILDER_LINKS: Array<[string, string]> = [
  ['Run it locally', REPO + '#run-it-locally-in-under-ten-minutes'],
  ['Architecture', REPO + '/blob/main/ARCHITECTURE.md'],
  ['Data contract', REPO + '/blob/main/DATA-CONTRACT.md'],
  ['Known limitations', REPO + '/blob/main/docs/KNOWN-LIMITATIONS.md'],
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
          Decision-bias training for crypto traders. The rules, the data and the guarantees behind every round, in plain
          language.
        </p>
        <div className="mt-8 flex flex-col gap-3 sm:flex-row">
          <Link href="/evidence" className="btn-primary" data-testid="docs-evidence-cta">
            See the Nansen evidence
          </Link>
          <Link href="/play" className="btn-quiet">
            Start a blind trial
          </Link>
        </div>
      </header>

      <div className="mt-14 grid gap-12 lg:grid-cols-[240px_1fr] lg:gap-16">
        <nav aria-label="On this page" className="lg:sticky lg:top-24 lg:self-start">
          {GROUPS.map((group) => (
            <div key={group.title} className="mb-6">
              <p className="text-[14px] font-bold text-subtle">{group.title}</p>
              <ul className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-[15px] sm:grid-cols-3 lg:grid-cols-1">
                {group.sections.map((s) => (
                  <li key={s.id}>
                    <a href={`#${s.id}`} className="font-semibold text-secondary transition-colors hover:text-cream">
                      {s.title}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          <div className="mb-6">
            <p className="text-[14px] font-bold text-subtle">Evidence</p>
            <Link href="/evidence" className="mt-3 inline-block text-[15px] font-semibold text-secondary hover:text-cream">
              Requests, hashes and commitments
            </Link>
          </div>
          <div>
            <p className="text-[14px] font-bold text-subtle">Builders</p>
            <ul className="mt-3 grid gap-2 text-[15px]">
              {BUILDER_LINKS.map(([label, href]) => (
                <li key={label}>
                  <a href={href} target="_blank" rel="noopener noreferrer" className="font-semibold text-secondary hover:text-cream">
                    {label}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </nav>

        <div className="grid gap-16">
          <Section id="what-it-is" title="What Trench Trials is">
            <p>
              Trench Trials is decision-bias training for crypto traders. It measures how revealing a token’s identity
              changes a trader’s decision.
            </p>
            <p>
              Each trial shows three anonymous assets with pre-cutoff Nansen signals. You make a blind choice, see the
              identities, and can stick or switch before the future is revealed. The result measures what recognition
              gained or cost. Prediction games ask whether you were right; Trench Trials asks what the ticker changed.
            </p>
          </Section>

          <Section id="problem" title="The problem it tests">
            <p>
              Crypto traders have more data than ever, but familiar tickers, reputation and narratives still influence
              their decisions. Ordinary prediction games and backtests record only the final choice, so they cannot tell
              whether the token’s identity changed the decision.
            </p>
            <p>
              Trench Trials records the choice before and after the reveal, on the same data, and measures the difference
              against the real market outcome.
            </p>
          </Section>

          <Section id="who" title="Who it is for">
            <p>
              <strong className="text-cream">Individual crypto traders and analysts</strong> who want to test whether
              they follow market signals or familiar narratives, and to measure and reduce that narrative bias through
              repeated blinded decisions.
            </p>
            <p>
              <strong className="text-cream">Trading communities</strong> can use the shared Daily Trial as a common
              decision-bias calibration exercise: everyone plays the same round on the same UTC day.
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
              Replay rounds are built from a past cutoff whose outcome is already known. You are never served a round you
              have already played. When you have played every available round, you see how many you completed and when
              the next Daily arrives.
            </p>
          </Section>

          <Section id="daily" title="Daily">
            <p>
              The Daily is one round assigned to a UTC calendar date, the same for every player that day. You get one
              measured attempt: once you have played it, the Daily page shows your result and when the next one opens. A
              round used as today’s or an upcoming Daily is not served as a Replay until its day has passed. Sharing your
              Daily result reveals what kind of decision you made, never the answer.
            </p>
          </Section>

          <Section id="live" title="Live">
            <p>
              A Live trial is measured in real time. The candidates and their signals come from Nansen’s current token
              screener at the moment the round opens (trailing 24 hours and 7 days), and every candidate must qualify
              under the eligibility policy. Entry stays open for five minutes,
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
              played are listed but excluded from the metrics.
            </p>
            <p>
              Your trial history is saved to this browser as an anonymous profile. Clearing site data or using another
              device starts a new anonymous profile; there is no account, so it cannot follow you across devices.
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
              Nansen supplies the candidate universe and the point-in-time market data used to construct every blind
              trial. Trench Trials deterministically selects eligible assets from that data, derives the blind clues, and
              uses Nansen price candles to calculate the outcome. Without Nansen, no new Replay, Daily or Live round can
              be produced.
            </p>
            <p className="rounded-card bg-raised p-5 text-[16px] text-cream">
              Nansen screener → eligibility → blind clues → commitment → player choices → Nansen OHLCV → verdict → Ticker
              Tax
            </p>
            <p>
              If the Nansen data a round needs cannot be retrieved or checked, the round is not created. No other source
              is substituted and nothing is estimated.{' '}
              <Link href="/evidence" className="link-quiet">
                See the evidence
              </Link>
            </p>
          </Section>

          <Section id="frozen" title="Why inputs are frozen">
            <p>
              Historical inputs are frozen and hash-sealed before a player enters. This prevents the evidence from
              changing after a decision has been made and makes every verdict reproducible. That is why playing a round
              does not call Nansen again.
            </p>
            <p>
              Existing rounds can survive a temporary Nansen outage, but the product cannot create new content without
              Nansen: candidate discovery, blind signals, outcomes, Replay generation, new Daily rounds and Live capture
              and resolution all require it. Frozen data is the real Nansen data the round was built from, never a mock
              or substitute.
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

          <Section id="verified" title="What verification means">
            <p>A round is verified only when four separate checks hold. Each is a different claim:</p>
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
              <Link href="/evidence" className="btn-quiet">
                See the evidence
              </Link>
              <Link href="/play" className="btn-primary">
                Start a blind trial
              </Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
