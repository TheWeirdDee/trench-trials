# Security

## Reporting a vulnerability

Please report security issues privately through GitHub’s **“Report a vulnerability”** (Security tab of this repository), or by direct message to [@TheWeirdDee](https://x.com/TheWeirdDee) on X. Do not open a public issue for a vulnerability. Include steps to reproduce and the impact you expect; you will get an acknowledgement and a fix or mitigation plan.

## How secrets are handled

- **Never committed.** `.env.local`, every other `.env.*` file (except the placeholder `.env.example`), raw Nansen responses (`.nansen-raw/`) and Vercel project files are git-ignored. `.vercelignore` keeps them out of deployment uploads too.
- **Server-only.** `NANSEN_API_KEY` is read only by the server-side Nansen client and is never sent to the browser or logged. The production deployment runs **without** a Nansen key, so public traffic cannot spend credits.
- **Fail closed.**
  - Internal routes (`/api/internal/*`) refuse every request unless `CRON_SECRET` is configured and matched with a constant-time comparison.
  - In production, guest cookies are neither issued nor trusted without a `SESSION_SECRET` of at least 32 characters.
- **Guest cookies** are signed (HMAC), `HttpOnly`, `SameSite=Lax` and `Secure` in production. No name, email, wallet or payment detail is ever collected.
- **No early data.** The server builds each stage’s response from an allowlist. Names are sent only after the blind lock, and prices and returns only after the final lock.
- **Tests cannot spend credits.** The test setup removes the Nansen key and blocks requests to Nansen hosts. Tests run only in an isolated database schema.

## Data integrity

Every round is sealed with a SHA-256 commitment before play. Every Nansen request is logged, with its request ID and response hash, before the next request is sent. `npm run verify` recomputes every commitment and return. See the [Evidence page](https://trench-trials.vercel.app/evidence) and [docs/NANSEN-CONTRACT-AUDIT.md](docs/NANSEN-CONTRACT-AUDIT.md).
