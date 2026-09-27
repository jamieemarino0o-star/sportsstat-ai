# SportsStat AI Predictor

A responsive sports analytics workspace built with vanilla HTML, JavaScript ES modules, Tailwind CSS via CDN, Lucide icons and an Express API proxy. Live ESPN data loads automatically; no CSV uploads are required.

## Run Locally

Use Node.js 24 LTS (minimum 22.9) and npm.

```sh
npm install
npm run dev
```

Open **http://localhost:3000**. The development command restarts the server after backend changes; reload the browser after frontend changes. Use `npm start` without the watcher.

If port 3000 is occupied:

```sh
PORT=3001 npm run dev
```

Open **http://localhost:3001** instead. Serve the app through Node, not by double-clicking the HTML: browser modules and the same-origin API routes require the server.

The app binds to `127.0.0.1` by default. Set `HOST=0.0.0.0` only when intentionally exposing it to another device or a deployment proxy.

## Sportsbook Connection

ESPN requires no API key. Real DraftKings, FanDuel and BetMGM odds require your own [The Odds API](https://the-odds-api.com/) account and quota.

```sh
cp .env.example .env
```

Set `ODDS_API_KEY` in `.env`, then restart Node. Never put the key in frontend code or commit `.env`. The proxy requests US two-way moneyline markets for all three books. Availability depends on league, region, provider coverage and subscription.

Without a key, live scores and historical analysis still work. EV and sportsbook prices remain blank. **Demo** enables explicitly labeled simulated games, history, odds, probability curves and a sample player datasheet. It does not silently replace failed live feeds.

## Workspace

- **Dashboard:** schedules, live scores, model signals, featured matchup, upcoming games and provider win probabilities.
- **AI Prediction Engine:** recent-form signals, historical W/L/T results, search, saved signals, probability/EV filters and sportsbook comparisons.
- **Live Match Tracker:** live scores, ESPN win-probability series, automated match notes, play-by-play, team statistics and available player box scores.
- **API Feeds Status:** connection health, successful fetch times, odds quota, sportsbook setup and pipeline coverage.

NFL, NBA, MLB and NHL are supported. The default view loads the NFL feed. ESPN's default scoreboard can return its current week or next scheduled slate, not necessarily today's games; each matchup displays its actual date.

Saved signals persist in this browser's local storage, not an account. Export produces a CSV containing the source mode, probabilities, sample sizes, odds timestamps, implied probabilities and EV. CSV cells are protected against spreadsheet formula injection.

## Data Flow

```text
Browser -> same-origin Express proxy -> ESPN scoreboard / schedule / summary
                                    -> The Odds API (server-side key)
        <- normalized scores, history, player stats, probabilities and odds
        -> local statistical model -> signals, comparisons and CSV export
```

| Endpoint | Query | Purpose |
| --- | --- | --- |
| `/api/scoreboard` | `sport=nfl` | Normalized events and season |
| `/api/history` | `sport=nfl&team=12&season=2026` | Current/previous-season team schedules |
| `/api/summary` | `sport=nfl&event=<ESPN event ID>` | Box score, players, plays and win probability |
| `/api/odds` | `sport=nfl` | Supported sportsbook moneylines |
| `/api/status` | None | Feed health and quota; never credentials |

Schedules and selected game details poll every 30 seconds while the page is visible. Polling pauses while a dialog is open and can be switched off. There are no WebSocket or subsecond latency claims.

The proxy uses a 20-second score/summary cache, a 15-minute history cache and a three-minute odds cache. It coalesces identical requests, limits upstream concurrency to five, times out individual upstream fetches after 10 seconds, and rate-limits each client to 150 API requests/minute. History loads progressively with three frontend workers. A cold league can take longer to analyze; missing or partial history is disclosed.

Provider errors are explicit. Failed odds requests remove prices instead of displaying cached odds as current. If a scoreboard refresh fails, the last successful scoreboard stays visible with a warning and timestamp. Scores, lineups, statistics, probabilities and play-by-play coverage vary by event and provider.

## Model Methodology

The product name includes "AI", but this initial implementation is a **transparent statistical baseline**, not a trained neural model, an LLM or a validated betting strategy. Match notes are deterministic summaries of scores and probability changes; actual play-by-play text comes from ESPN.

1. Fetch each team's current and previous-season results.
2. Exclude uncompleted games, duplicate events and games at or after the matchup/current time.
3. Take the latest 10 completed games. A tie counts as half a win. Require at least five games for each team.
4. Apply a Beta(2, 2) prior: `strength = (wins + 2) / (games + 4)`.
5. Convert each strength to an odds ratio `strength / (1 - strength)` and normalize the two ratios into a matchup estimate.
6. Match sportsbook events by exact normalized home/away names and kickoff within six hours, then select the best available price for the model's side.

```text
Implied probability = 1 / decimal odds
EV percent = (model probability * decimal odds - 1) * 100
```

The model omits injuries, lineups, opponent strength, home advantage, season transitions and live score state. Even during live games its recent-form estimate remains pregame-only; ESPN's live win probability is a separate series. Implied prices are not de-vigged. Draws, pushes, voids, overtime settlement, taxes and fees are not modeled. Use only compatible two-outcome markets.

Historical frequency is not predictive accuracy. No backtested hit rate or profitability is claimed. Positive estimated EV is not proof of an advantage. Signals are for research, not financial advice. 18+ only; never wager money you cannot afford to lose.

## Test

```sh
npm run check
npm test
```

The Node test suite uses injected provider fixtures, not paid APIs. It covers scoreboard normalization, historical filtering, duplicates, ties, small samples, odds math, strict event matching, route validation, security headers, missing keys, request coalescing, secret redaction and NFL drive-based commentary.

Browser smoke checks:

1. Open the app with a working internet connection. Confirm live schedules and real team logos load; without an odds key, prices and EV must remain blank.
2. Switch to Demo. Confirm the simulated-data notice appears. Open a model signal and compare all three books.
3. Search in the prediction engine, save a signal and choose Saved signals. Export a CSV and inspect its `Data mode` column.
4. Open the first NFL demo match: its probability chart, match notes and Patrick Mahomes/Lamar Jackson sample box scores should render.
5. Switch all four leagues and tabs. At mobile widths, use the navigation menu; tables scroll within their containers.
6. Pause/resume auto-refresh, inspect API Feeds Status and open the model methodology dialog. Test keyboard navigation, Escape and dialog focus.
7. Block `/api/scoreboard` using browser developer tools and reload. Confirm the retry state appears; switch explicitly to Demo to continue offline with fixtures. CDN fonts, icons and images still require connectivity.

The dashboard has been checked in the integrated Chromium browser at desktop and mobile sizes. Native file-download behavior should also be smoke-tested in your regular browser; the integrated browser may suppress download events.

## Structure

```text
public/
  index.html             Application entry and navigation shell
  css/styles.css         Responsive dark theme and component styles
  js/app.js              Four views, API lifecycle and interactions
  js/model.js            Pure normalization, statistics and odds math
  js/demo.js             Explicitly simulated fixtures
src/feeds.js             Cached, bounded provider adapters
server.js                Express server, validation and security headers
tests/model.test.js      Statistical unit tests
tests/server.test.js     Proxy and provider-adapter tests
.env.example             Local configuration template
```

## Before Public Production Use

This is a working, production-minded starter, not a certified production betting system. In particular:

- Confirm ESPN endpoint usage rights and obtain a licensed provider/SLA if needed. ESPN's public APIs are unofficial and can change without notice.
- Backtest out-of-time, measure probability calibration, address data leakage and settlement rules, and add injury/lineup features before relying on estimates.
- Replace Tailwind's development CDN with compiled CSS; self-host pinned Lucide/fonts/assets. The current CSP permits inline styles/scripts and eval for the requested CDN workflow. Tighten it for deployment.
- Deploy behind HTTPS with authentication where needed, a secret manager, request logging without credentials, monitoring and error reporting. Set `NODE_ENV=production` behind TLS.
- Use a shared cache and distributed rate-limit store for multiple server instances, and manage sportsbook quotas per plan. The current stores are in memory and intended for one local process.
- Provide accessibility/security audits, your jurisdiction's age checks and required responsible-gaming controls before offering any wagering workflow. This app does not accept wagers or manage money.

Team marks are supplied by ESPN. The stadium photograph is served from Unsplash. Review third-party asset and data rights before commercial distribution.