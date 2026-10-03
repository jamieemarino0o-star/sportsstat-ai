# Security & Reliability Review — SportsStat AI Predictor

Date: 2026-10-01. Scope: `server.js`, `src/*.js`, `public/js/*.js`, `public/index.html`, configuration files.

## Security findings

| # | Severity | File | Lines | Vulnerability | Confidence | Status |
|---|----------|------|-------|---------------|------------|--------|
| 1 | LOW | server.js / src/ledger.js / src/notifier.js | 113 / 87 / 99 | Unauthenticated `POST /api/predictions` let a caller toggle `selection` to spam Telegram "New Bet" alerts | 9/10 | Mitigated: each event is announced at most once (persisted across restarts). The endpoint itself remains unauthenticated (see Open items). |

No XSS, SSRF, prototype-pollution or secret-exposure issues were found. `ODDS_API_KEY` and `TELEGRAM_BOT_TOKEN` are read only from `process.env`, never logged, and upstream error messages are sanitized before reaching clients. `.env` and `data/` are git-ignored and have never been committed.

## Reliability and data-integrity fixes

1. Predictions are accepted only for games ESPN reports as scheduled (`state: pre`), so live in-play odds can no longer become a "closing" price and corrupt CLV/ROI.
2. Pending predictions whose games left the live scoreboard are settled from the event's ESPN summary (throttled to every 15 minutes per sport, 4+ hours after kickoff).
3. Reconciliation skips non-finite scores instead of settling them as 0-0.
4. A torn final ledger line is newline-terminated before the next append.
5. On reload, a prediction line after a result cannot reopen a settled event.
6. Ledger write failures are logged once per error code instead of being swallowed.
7. Decimal prices above 1001 are discarded.
8. Ledger pruning is linear instead of quadratic.
9. Malformed or oversized JSON returns 400/413 with a generic message instead of 502.
10. `Cache-Control: no-store` on `/api/audit` and `/api/optimized-params`; bounded shutdown; unhandled-rejection logging; Telegram queue initially capped at 100. Superseded on 2026-10-02 by an atomic persistent outbox with retries and ledger recovery, avoiding dropped notifications (requires durable storage and one process per outbox).
11. Shin's method falls back to multiplicative de-vig for no-margin markets; Audit Lab result column ordered away-home; push-only calendar days show "Push".
12. Optional `TRUST_PROXY` so rate limiting keys on real client IPs behind a reverse proxy.

Regression tests: `tests/ledger.test.js`, `tests/server.test.js`, `tests/notifier.test.js`.

## Open items (require architectural or operational decisions)

- `POST /api/predictions` is unauthenticated on public deployments; anyone can write pre-game predictions and skew audit/backtest statistics. Add authentication in front of the deployment or move prediction generation server-side.
- Hosts with ephemeral disks (including Render without a persistent disk) erase `data/predictions.jsonl` on deploy/restart. Attach a persistent disk or use a database.
- Run exactly one server process per ledger file; multiple processes reconcile and notify independently.
- Rotate the Odds API key, which was shared in plain text during development.
