const QUESTIONS: Array<{ q: string; a: string }> = [
  {
    q: 'What am I choosing?',
    a: 'Which of three real tokens earned the best return over the round’s outcome window, measured from a historical cutoff. You choose once with the names hidden, then once more after they are revealed.',
  },
  {
    q: 'What stays hidden during Blind Pick?',
    a: 'Token names and addresses, the exact cutoff date, every price and the outcome. You see four signals per token, derived from Nansen data that existed at the cutoff.',
  },
  {
    q: 'What happens during Unmask?',
    a: 'Your blind pick locks and the names appear, while the outcome stays sealed. A short decision window starts on the server: keep your pick or switch. If the window closes first, your blind pick stands and is recorded as a timeout.',
  },
  {
    q: 'What is Ticker Tax?',
    a: 'The return you gave up — or gained — by changing your mind after seeing the names: your blind pick’s return minus your final pick’s. Keeping costs exactly zero. It stays inconclusive until you have made five explicit decisions.',
  },
  {
    q: 'Where does the data come from?',
    a: 'The Nansen API. Candidates and their signals come from Nansen’s historical token screener at the cutoff; outcome prices come from Nansen’s historical price data. Each round keeps the request IDs and response hashes it was built from.',
  },
  {
    q: 'How is my History saved?',
    a: 'Through a signed cookie on this browser, linked to your decisions on our server. There is no account: another browser or device, or clearing cookies, starts a new History.',
  },
  {
    q: 'Why can a round be invalidated?',
    a: 'If the exact data a round committed to cannot be verified — for example a missing price candle at its measurement boundary — the round is marked invalid and never scored. No other data is substituted.',
  },
  {
    q: 'Is this financial advice?',
    a: 'No. Rounds replay past market data to measure decision-making. Past returns say nothing about future returns.',
  },
];

/** Accessible accordion built on native <details>: keyboard and screen-reader friendly without script. */
export function Faq() {
  return (
    <div className="grid gap-3" data-testid="faq">
      {QUESTIONS.map(({ q, a }) => (
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
