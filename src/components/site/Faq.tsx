export interface FaqItem {
  q: string;
  a: string;
}

/** Every question, in plain language. Shown in full on /docs#faq. */
export const ALL_QUESTIONS: FaqItem[] = [
  {
    q: 'What is Trench Trials?',
    a: 'Decision-bias training for crypto traders. It measures how revealing a token’s identity changes your decision: you choose with the names hidden, choose again after seeing them, and the real outcome shows what the change gained or cost.',
  },
  {
    q: 'Who is it for?',
    a: 'Individual crypto traders and analysts who want to test whether they follow market signals or familiar narratives. Trading communities can use the shared Daily as a common calibration exercise.',
  },
  {
    q: 'What problem does it solve?',
    a: 'Familiar tickers, reputation and narratives influence decisions, but prediction games and backtests record only the final choice, so they cannot tell whether the identity changed it. Trench Trials records the choice before and after the reveal and prices the difference.',
  },
  {
    q: 'What is a blind pick?',
    a: 'Your first choice. You compare three tokens using four Nansen signals each, while their names, addresses, dates and prices are hidden, and lock the one you think will return the most.',
  },
  {
    q: 'What is the Unmask stage?',
    a: 'Once your blind pick is locked, the three names appear while the outcome stays sealed. A short window runs on the server’s clock: stick with your pick or switch, once. If time runs out, your blind pick stands.',
  },
  {
    q: 'What is Ticker Tax?',
    a: 'Your blind pick’s return minus your final pick’s return, in percentage points: what changing your mind after seeing the names cost or gained you. Sticking costs exactly zero. It becomes a measurement after five explicit decisions.',
  },
  {
    q: 'Why can Daily be played only once?',
    a: 'The Daily is the same round for everyone on a UTC date. One attempt keeps it a fair, comparable measurement: playing it again after seeing the outcome would measure memory, not judgement.',
  },
  {
    q: 'Why doesn’t every click make a new Nansen request?',
    a: 'A round’s Nansen inputs are fetched once, before anyone plays, then frozen. Fetching again during play could change the evidence after you decide and would make verdicts impossible to reproduce.',
  },
  {
    q: 'Is frozen data fake or simulated?',
    a: 'No. It is the exact authenticated Nansen data the round was built from, stored with each response’s request ID and SHA-256 hash. Nothing is mocked, estimated or substituted.',
  },
  {
    q: 'What stops a round from changing after I play?',
    a: 'Before a round opens, everything that decides it is written into a manifest and sealed with a SHA-256 commitment. At the verdict the manifest is revealed, so anyone can recompute the hash and check it.',
  },
  {
    q: 'What happens if Nansen is unavailable?',
    a: 'Rounds that already exist stay playable, because their inputs are frozen and hash-sealed. No new Replay, Daily or Live round can be created until Nansen is reachable again, and no other data source is used.',
  },
  {
    q: 'How is the winner calculated?',
    a: 'Each token’s return is its exit price divided by its entry price, minus one, using Nansen hourly candles at the round’s fixed boundaries. The highest return wins; returns within 0.01 percentage points share the win.',
  },
  {
    q: 'How is my History retained?',
    a: 'Your trial history is saved to this browser as an anonymous profile, through a signed cookie. There is no account: clearing site data or using another device starts a new anonymous profile.',
  },
  {
    q: 'What happens after I play every available round?',
    a: 'You see how many rounds you have completed and when the next Daily arrives. New rounds appear only when they are built from real Nansen data and pass review.',
  },
  {
    q: 'Why might no Live round be available?',
    a: 'A Live round opens only when a fresh Nansen snapshot yields three candidates that pass the eligibility policy. If none qualify, no Live round is offered rather than a weak one.',
  },
  {
    q: 'Is this financial advice?',
    a: 'No. Rounds use past market data to measure decision-making. Past returns say nothing about future returns.',
  },
];

const LANDING = [
  'What is Trench Trials?',
  'Who is it for?',
  'What is a blind pick?',
  'What is the Unmask stage?',
  'What is Ticker Tax?',
  'Is frozen data fake or simulated?',
  'What happens if Nansen is unavailable?',
  'Is this financial advice?',
];

/** The eight essentials shown on the landing page; the rest live on /docs#faq. */
export const LANDING_QUESTIONS: FaqItem[] = LANDING.map((q) => ALL_QUESTIONS.find((item) => item.q === q)!);

/** Accessible accordion built on native <details>: keyboard and screen-reader friendly without script. */
export function Faq({ questions = ALL_QUESTIONS }: { questions?: FaqItem[] }) {
  return (
    <div className="grid gap-3" data-testid="faq">
      {questions.map(({ q, a }) => (
        <details key={q} className="group rounded-card bg-raised open:bg-raised-2">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-6 px-5 py-5 text-[17px] font-bold sm:px-6 [&::-webkit-details-marker]:hidden">
            {q}
            <span
              className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-canvas text-secondary transition-transform duration-200 group-open:rotate-45"
              aria-hidden="true"
            >
              +
            </span>
          </summary>
          <p className="px-5 pb-6 text-[16px] leading-relaxed text-secondary sm:px-6">{a}</p>
        </details>
      ))}
    </div>
  );
}
