import Link from 'next/link';
import { CopyValue } from '@/components/site/CopyValue';
import { getEvidence, type RoundEvidence } from '@/lib/repo/evidence';

export const metadata = {
  title: 'Nansen evidence · Trench Trials',
  description:
    'How Nansen data selects the tokens, builds the blind clues and decides every Trench Trials verdict, with request IDs, response hashes and commitments.',
};

// Reads the live database on every request so the checks below are current.
export const dynamic = 'force-dynamic';

const REPO = 'https://github.com/TheWeirdDee/trench-trials';
/** The hackathon's qualifying threshold for real Nansen API calls. */
const REQUIRED_CALLS = 100;
/** Calls the app made before the call log existed; visible only on the Nansen dashboard. */
const BASELINE_CALLS = 21;
/** Nansen's official announcement of the 100-call requirement. Set when the link is confirmed. */
const REQUIREMENT_ANNOUNCEMENT_URL = '';

const ENDPOINTS: Array<[string, string, string, string]> = [
  ['Historical Token Screener', '/api/v1beta1/token-screener/historical', 'Which tokens qualify, and the four blind signals', '5'],
  ['Historical Token OHLCV (1h)', '/api/v1beta1/tgm/historical-token-ohlcv', 'Exact entry and exit prices, returns and the winner', '5'],
  ['Token Screener (current)', '/api/v1/token-screener', 'Live candidate capture', '1'],
  ['Historical Token OHLCV (5m)', '/api/v1beta1/tgm/historical-token-ohlcv', 'Live resolution', '5'],
];

const CLUES: Array<[string, string, string]> = [
  ['Buy / sell balance', '(buys − sells) ÷ (buys + sells), 1-day window', 'buy_volume, sell_volume'],
  ['Trading pace', '1-day volume ÷ (7-day volume ÷ 7)', 'volume (1-day and 7-day windows)'],
  ['Netflow vs liquidity', '1-day netflow ÷ liquidity', 'netflow, liquidity'],
  ['7-day momentum', '7-day price change', 'price_change (7-day window)'],
];

const STAGES: Array<{ id: string; title: string; body: string }> = [
  {
    id: 'screener',
    title: 'Nansen screener',
    body: 'Two Historical Token Screener requests — a 7-day and a 1-day window — read as of the day before the cutoff, so nothing in them comes from the outcome window.',
  },
  {
    id: 'eligibility',
    title: 'Eligibility',
    body: 'Only freely traded tokens that Nansen positively classifies qualify (memecoins, AI, DEX, gaming, infrastructure, derivatives). Stablecoins, wrapped or bridged majors, staking, LP, yield, tokenized-stock and RWA tokens are excluded, and anything unclassified fails closed. Floors: $2M liquidity, $100K 24h volume, 30 days of age. The three most liquid qualifying tokens are chosen, and no two playable rounds share two tokens.',
  },
  {
    id: 'clues',
    title: 'Blind clues',
    body: 'Four signals per token, computed from the screener rows below and bucketed. Names, addresses, dates and prices stay hidden.',
  },
  {
    id: 'commitment',
    title: 'Commitment',
    body: 'Before anyone plays, the candidates, signals, receipts and outcome rules are written into a manifest and sealed with a SHA-256 commitment. The inputs are frozen from then on.',
  },
  {
    id: 'choices',
    title: 'Player choices',
    body: 'Your blind pick and your final keep-or-switch are locked on the server’s clock, in that order, before any outcome is released.',
  },
  {
    id: 'ohlcv',
    title: 'Nansen OHLCV',
    body: 'One Historical Token OHLCV request per token supplies the hourly candles at the round’s fixed entry and exit boundaries. The whole outcome window must be present; a missing or broken candle rejects the round.',
  },
  {
    id: 'verdict',
    title: 'Verdict',
    body: 'Each return is exit close ÷ entry close − 1. The highest return wins; returns within 0.01 percentage points share the win. The manifest is revealed so the commitment can be recomputed.',
  },
  {
    id: 'ticker-tax',
    title: 'Ticker Tax',
    body: 'Your blind pick’s return minus your final pick’s return: what the reveal cost or gained you. Keeping your pick costs zero.',
  },
];

function utc(iso: string | null): string {
  return iso ? `${iso.replace('T', ' ').slice(0, 19)} UTC` : '—';
}

function Check({ ok, label }: { ok: boolean; label: string }) {
  return (
    <li className="flex items-center gap-2 text-[15px]">
      <span className={`font-bold ${ok ? 'text-gain' : 'text-loss'}`} aria-hidden="true">
        {ok ? '✓' : '✗'}
      </span>
      <span>
        {label}
        <span className="sr-only">{ok ? ': passed' : ': failed'}</span>
      </span>
    </li>
  );
}

function RoundCard({ round }: { round: RoundEvidence }) {
  return (
    <article className="rounded-panel bg-raised p-6 sm:p-8" data-testid="evidence-round">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h3 className="text-[20px] font-extrabold tracking-[-0.02em]">
          Round <CopyValue value={round.id} label="round ID" keep={8} />
        </h3>
        <span className="text-[14px] text-secondary">Eligibility policy v{round.policyVersion ?? '—'}</span>
      </div>
      <ul className="mt-4 grid gap-1.5 sm:grid-cols-2" aria-label="Checks recomputed on this page load">
        <Check ok={round.checks.provenance} label={`Provenance: ${round.receipts.length} Nansen responses, each with request ID and SHA-256`} />
        <Check ok={round.checks.commitment} label="Commitment: the sealed manifest still hashes to the published commitment" />
        <Check ok={round.checks.calculation} label="Calculation: every return recomputes from its stored candle closes" />
        <Check ok={round.checks.eligibility} label="Eligibility: approved under the current policy" />
      </ul>
      <div className="mt-5 text-[15px]">
        <span className="font-semibold text-secondary">Commitment</span>{' '}
        <CopyValue value={round.commitmentHash} label="commitment hash" />
      </div>
      <table className="mt-5 w-full text-left text-[14px]">
        <caption className="sr-only">Nansen responses this round was built from</caption>
        <thead className="text-secondary">
          <tr>
            <th className="py-2 pr-3 font-semibold">Purpose</th>
            <th className="py-2 pr-3 font-semibold">Request ID</th>
            <th className="py-2 pr-3 font-semibold">Response SHA-256</th>
            <th className="hidden py-2 font-semibold md:table-cell">Retrieved</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line/70">
          {round.receipts.map((r) => (
            <tr key={`${r.requestId}-${r.responseSha256}`}>
              <td className="py-2 pr-3 align-top">{(r.purpose ?? r.endpoint).replace(/^replay_/, '').replace(/_/g, ' ')}</td>
              <td className="py-2 pr-3 align-top">{r.requestId ? <CopyValue value={r.requestId} label="request ID" keep={6} /> : '—'}</td>
              <td className="py-2 pr-3 align-top">
                <CopyValue value={r.responseSha256} label="response SHA-256" keep={8} />
              </td>
              <td className="hidden py-2 align-top text-secondary md:table-cell">{utc(r.retrievedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <details className="group mt-5 rounded-card bg-raised-2">
        <summary className="cursor-pointer list-none px-4 py-3 text-[15px] font-semibold [&::-webkit-details-marker]:hidden">
          Show tokens and cutoff <span className="text-secondary">(spoils this round if you haven’t played it)</span>
        </summary>
        <dl className="grid gap-2 px-4 pb-4 text-[15px] sm:grid-cols-2">
          <div>
            <dt className="text-secondary">Tokens</dt>
            <dd className="font-bold">{round.tokens.join(' · ')}</dd>
          </div>
          <div>
            <dt className="text-secondary">Cutoff (entry)</dt>
            <dd className="font-bold">{utc(round.cutoff)}</dd>
          </div>
        </dl>
      </details>
    </article>
  );
}

export default async function EvidencePage() {
  const { rounds, usage } = await getEvidence();
  const expected = BASELINE_CALLS + usage.successfulCalls;

  return (
    <div className="page py-12 sm:py-16">
      <p className="eyebrow">Evidence</p>
      <h1 className="type-section mt-4 max-w-4xl">How Nansen drives every trial.</h1>
      <p className="type-lead mt-6 max-w-3xl" data-testid="nansen-role">
        Nansen supplies the candidate universe and the point-in-time market data used to construct every blind trial.
        Trench Trials deterministically selects eligible assets from that data, derives the blind clues, and uses Nansen
        price candles to calculate the outcome. Without Nansen, no new Replay, Daily or Live round can be produced.
      </p>
      <p className="type-body mt-4 max-w-3xl">
        Historical inputs are frozen and hash-sealed before a player enters. This prevents the evidence from changing
        after a decision has been made and makes every verdict reproducible. Existing rounds can survive a temporary
        Nansen outage, but the product cannot create new content without Nansen. There is no substitute data source.
      </p>

      <section className="mt-16" aria-labelledby="pipeline-heading">
        <h2 id="pipeline-heading" className="type-title">
          The pipeline
        </h2>
        <p className="mt-3 font-mono text-[15px] text-secondary">
          Nansen API → eligible candidates → blind clues → locked decisions → Nansen outcome candles → verdict
        </p>
        <ol className="mt-8 grid gap-4 md:grid-cols-2">
          {STAGES.map((s, i) => (
            <li key={s.id} id={s.id} className="scroll-mt-24 rounded-card bg-raised p-5 sm:p-6">
              <p className="font-mono text-[14px] text-subtle">0{i + 1}</p>
              <h3 className="mt-1 text-[19px] font-extrabold tracking-[-0.02em]">{s.title}</h3>
              <p className="mt-2 text-[15px] leading-relaxed text-secondary">{s.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="mt-16" aria-labelledby="endpoints-heading">
        <h2 id="endpoints-heading" className="type-title">
          Endpoints and what they drive
        </h2>
        <div className="mt-6 overflow-x-auto rounded-card bg-raised">
          <table className="w-full min-w-[640px] text-left text-[15px]">
            <thead className="text-secondary">
              <tr>
                <th className="px-5 py-3 font-semibold">Nansen endpoint</th>
                <th className="px-5 py-3 font-semibold">Drives</th>
                <th className="px-5 py-3 font-semibold">Credits / call</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line/70">
              {ENDPOINTS.map(([name, path, drives, credits]) => (
                <tr key={name}>
                  <td className="px-5 py-3 align-top">
                    <span className="block font-bold">{name}</span>
                    <code className="mono-value text-[14px] text-secondary">{path}</code>
                  </td>
                  <td className="px-5 py-3 align-top">{drives}</td>
                  <td className="px-5 py-3 align-top">{credits}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <h3 className="mt-10 text-[20px] font-extrabold tracking-[-0.02em]">Fields behind each blind clue</h3>
        <div className="mt-4 overflow-x-auto rounded-card bg-raised">
          <table className="w-full min-w-[640px] text-left text-[15px]">
            <thead className="text-secondary">
              <tr>
                <th className="px-5 py-3 font-semibold">Clue</th>
                <th className="px-5 py-3 font-semibold">Formula</th>
                <th className="px-5 py-3 font-semibold">Nansen fields</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line/70">
              {CLUES.map(([clue, formula, fields]) => (
                <tr key={clue}>
                  <td className="px-5 py-3 font-bold">{clue}</td>
                  <td className="px-5 py-3">{formula}</td>
                  <td className="px-5 py-3">
                    <code className="mono-value text-[14px]">{fields}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section id="usage" className="mt-16 scroll-mt-24" aria-labelledby="usage-heading">
        <h2 id="usage-heading" className="type-title">
          Real API usage
        </h2>
        <dl className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="usage">
          {[
            ['Requirement', `${REQUIRED_CALLS} calls`],
            ['Earlier app calls (dashboard only)', String(BASELINE_CALLS)],
            ['Logged build calls', `${usage.loggedCalls} (${usage.successfulCalls} successful)`],
            ['Expected dashboard total', `${expected} — pending dashboard confirmation`],
            ['Credits spent (logged)', String(usage.creditsUsed)],
            ['Balance after the last call', usage.creditsRemaining === null ? '—' : String(usage.creditsRemaining)],
          ].map(([label, value]) => (
            <div key={label} className="rounded-card bg-raised p-5">
              <dt className="text-[14px] font-semibold text-secondary">{label}</dt>
              <dd className="mt-1 text-[20px] font-extrabold tracking-[-0.02em]">{value}</dd>
            </div>
          ))}
        </dl>
        <p className="type-body mt-4 max-w-3xl">
          Every request — including retries and failures — is logged before the next one is sent. Logged calls ran from{' '}
          {utc(usage.firstCallAt)} to {utc(usage.lastCallAt)}.
          {REQUIREMENT_ANNOUNCEMENT_URL && (
            <>
              {' '}
              <a href={REQUIREMENT_ANNOUNCEMENT_URL} target="_blank" rel="noopener noreferrer" className="link-quiet">
                Nansen’s announcement of the {REQUIRED_CALLS}-call requirement
              </a>
              .
            </>
          )}
        </p>
      </section>

      <section id="rounds" className="mt-16 scroll-mt-24" aria-labelledby="rounds-heading">
        <h2 id="rounds-heading" className="type-title">
          Playable rounds
        </h2>
        <p className="type-body mt-3 max-w-3xl">
          Each round below was built from the Nansen responses listed, sealed before play, and checked again when this
          page loaded.
        </p>
        <div className="mt-6 grid gap-5">
          {rounds.length === 0 ? (
            <p className="type-body">No round is open for play right now.</p>
          ) : (
            rounds.map((r) => <RoundCard key={r.id} round={r} />)
          )}
        </div>
      </section>

      <section className="mt-16" aria-labelledby="verification-heading">
        <h2 id="verification-heading" className="type-title">
          What verification means
        </h2>
        <dl className="mt-6 grid gap-3 md:grid-cols-2">
          {[
            ['Provenance', 'Every input traces to a logged Nansen response, by request ID and SHA-256, sealed in the round’s commitment.'],
            ['Calculation', 'Each return is exit close ÷ entry close − 1 on the committed candles, and anyone can recompute it.'],
            ['Eligibility', 'The round was reviewed and approved under the current eligibility policy.'],
            ['Availability', 'Only approved rounds are offered for play. A withdrawn round leaves play and scoring; nothing is deleted.'],
          ].map(([name, text]) => (
            <div key={name} className="rounded-card bg-raised p-5">
              <dt className="text-[17px] font-extrabold">{name}</dt>
              <dd className="mt-1 text-[15px] leading-relaxed text-secondary">{text}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="mt-16" aria-labelledby="fallback-heading">
        <h2 id="fallback-heading" className="type-title">
          No fallback, ever
        </h2>
        <p className="type-lead mt-4 max-w-3xl" data-testid="no-fallback">
          Missing or malformed Nansen data invalidates or prevents a round. No alternate market-data provider, estimate or
          mock input is ever used in production.
        </p>
      </section>

      <section className="mt-16" aria-labelledby="reproduce-heading">
        <h2 id="reproduce-heading" className="type-title">
          Reproduce it
        </h2>
        <ul className="type-body mt-4 grid gap-2">
          <li>
            <code className="mono-value">npm run verify</code> recomputes every commitment and return in the database.
          </li>
          <li>
            <code className="mono-value">npm run verify:rebuilt</code> re-checks each round against its preserved Nansen
            responses (these stay private under Nansen’s redistribution terms).
          </li>
          <li>
            <a className="link-quiet" href={`${REPO}/blob/main/DATA-CONTRACT.md`} target="_blank" rel="noopener noreferrer">
              Data contract
            </a>{' '}
            ·{' '}
            <a className="link-quiet" href={`${REPO}/blob/main/docs/API-USAGE-EVIDENCE.md`} target="_blank" rel="noopener noreferrer">
              API usage evidence
            </a>{' '}
            ·{' '}
            <a className="link-quiet" href={`${REPO}/blob/main/docs/NANSEN-CONTRACT-AUDIT.md`} target="_blank" rel="noopener noreferrer">
              Contract and data audit
            </a>{' '}
            ·{' '}
            <a className="link-quiet" href={REPO} target="_blank" rel="noopener noreferrer">
              GitHub repository
            </a>
          </li>
        </ul>
        <div className="mt-10 flex flex-col gap-3 sm:flex-row">
          <Link href="/play" className="btn-primary">
            Start a blind trial
          </Link>
          <Link href="/docs" className="btn-quiet">
            Read the docs
          </Link>
        </div>
      </section>
    </div>
  );
}
