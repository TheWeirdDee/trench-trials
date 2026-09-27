# Contributing

Thanks for your interest. Keep changes small and focused.

## Get running

Follow the [quickstart](README.md#run-it-locally-in-under-ten-minutes). Then prepare the isolated test schema once with `npm run test:db:setup`.

## Before opening a pull request

```bash
npm run typecheck
npm test                               # unit and integration, in the tt_test schema
npm run build && npx playwright test   # end-to-end on the production build
npm run verify
```

## Ground rules

- **Real data only.** Production paths never use mock, synthetic, estimated or substituted market data. Test fixtures stay in the test schema and are clearly labelled.
- **No credit spending in tests.** Tests never call Nansen. Any script that calls Nansen needs `--confirm` and explicit call and credit caps.
- **Dry run first.** Every script that writes to a database prints its plan without `--confirm`.
- **Never commit secrets** (`.env.local`, API keys, database URLs) or raw Nansen responses. See [SECURITY.md](SECURITY.md).
- **Keep the evidence intact.** Rounds, receipts and commitments are never edited or deleted. A round that should not be played is withdrawn through `npm run review:round`.
