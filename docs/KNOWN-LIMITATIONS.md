# Known limitations

What is honestly unresolved or deliberately limited, as of 2026-09-27.

## Catalog size

Six rounds are playable. Their IDs, receipts and commitments are on the [Evidence page](https://trench-trials.vercel.app/evidence); tokens and cutoffs stay behind its spoiler control, so they are not listed here.

| Round | Built by | Daily |
| --- | --- | --- |
| `c5e34c58…` | Offline leak-free rebuild (zero new calls) | 2026-09-26 |
| `d2ecc59b…` | Offline leak-free rebuild (zero new calls) | 2026-09-27 |
| `67d694e4…` | Round Forge v4, 2026-09-27 | 2026-09-28 |
| `d06b6bc2…` | Round Forge v4, 2026-09-27 | — |
| `15b4670e…` | Round Forge v4, 2026-09-27 | — |
| `50e1edc8…` | Round Forge v4, 2026-09-27 | — |

A round is not served as Replay on the day it is the Daily, or before that day. On 2026-09-27 Replay therefore offers four rounds and on 2026-09-28 five. A guest who has played everything available sees how many rounds they completed and when the next Daily opens; no filler round is ever served. More rounds need new Nansen calls, which are made only under an explicit, capped spending authorization.

A fifth Round Forge v4 candidate, `c0f61751…`, was reviewed and not published (`catalog_quality_repeat_winner`: its winning token already wins a playable round). It is recorded as withdrawn with that reason; its data, receipts, raw responses and commitment are kept, and it is never served.

## Why sixteen earlier rounds were withdrawn

Nansen’s historical token screener reports `to_date = D` as of about midday UTC on D. The first sixteen rounds took their entry price at D 00:00. So their blind signals could include up to twelve hours of the outcome window. Many also held tokens that are not fair comparisons: tokenized stocks, yield or LP tokens, bridged majors, unclassifiable tokens, thin volume, missing candles, or near-duplicate token sets.

All sixteen were **withdrawn, not deleted**. Their receipts and commitments are unchanged, and `npm run verify` still checks them. Withdrawal is a reversible status change with an audit trail.

Two of them were rebuilt offline as new rounds with zero new API calls. Each keeps the preserved screener snapshot for day D and moves the cutoff to D+1 00:00 UTC, measured from the same preserved candles. Round Forge v4, which built the other four playable rounds, reads the screener as of the day before the cutoff. The full analysis is in the [Nansen contract and data audit](NANSEN-CONTRACT-AUDIT.md).

## Live is withheld

The Live pipeline is built and audited: current-screener capture, commitment, a 24-hour measurement and resolution from five-minute candles. Its only candidate round (PUMP / XXXX / TRX) failed the eligibility policy, because TRX is a bridged major and XXXX traded about $1.3K in 24 hours. It was marked invalid and never resolved. A new Live round needs a spending authorization and a snapshot whose candidates pass the policy.

## Nansen usage figure

The expected dashboard total is 137 calls: 21 earlier app calls plus 116 calls logged by the application (572 credits; balance 448). It stays labelled *pending dashboard confirmation* until a dashboard screenshot is recorded in [API-USAGE-EVIDENCE.md](API-USAGE-EVIDENCE.md).

## History and privacy

History is an anonymous profile tied to a signed cookie in one browser. Another browser or device, or clearing site data, starts a new profile. It cannot be moved or recovered, and there is no self-service way yet to delete a profile’s stored decisions.

## Data caveats

- Nansen reconstructs the historical screener at request time and may later correct late data. Each round stores response hashes, so a later correction is detectable, not silently trusted.
- One playable token's Nansen sector tag (Decentralised Exchanges) differs from its widely known identity (a social-app token). Both are freely traded, allowed classes, and the round was approved on the tag.
- Raw Nansen responses are kept privately, in line with Nansen’s redistribution terms. The public record is request IDs, response SHA-256 hashes and derived round data.

## Performance

Lighthouse (mobile preset, 4× CPU throttling) scores about 70 for performance, driven by JavaScript blocking time. Accessibility, best practices and SEO score 100.
