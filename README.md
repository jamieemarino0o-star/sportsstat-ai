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

Set `ODDS_API_KEY` in `.env`, then restart Node. Never put the key in frontend code or commit `.env`. The proxy requests US moneylines and, when selected, per-event props, spreads and totals for DraftKings, FanDuel and BetMGM. Availability depends on league, market, region, provider coverage and subscription. Odds refresh every 12 hours by default (`ODDS_POLL_INTERVAL_MS` overrides this, in milliseconds). A shared budget limits new requests to 400 in a rolling 31-day window, including per-event markets. Supabase persists both the odds cache and reservations across restarts; local development without Supabase uses memory only. Each cached fetch also feeds the in-memory line-movement snapshot store at no extra API cost. See "Durable Odds Budget" below before deploying.

Without a key, live scores and historical analysis still work, but actual sportsbook markets remain unavailable.

All sportsbook quotes are displayed in decimal odds (for example, `1.91` or `2.50`), including signal tables, sportsbook comparisons, line movement, bet slips, Telegram alerts and audit/backtest odds brackets. EV, probability and staking calculations continue to use the original unrounded decimal prices.

## Telegram Notifications

`src/notifier.js` sends a Telegram message whenever the prediction ledger logs a new priced pick and when that game is reconciled as final. Create a bot with [@BotFather](https://t.me/BotFather), message it once, then set in `.env`:

```sh
TELEGRAM_BOT_TOKEN=123456:ABC...
TELEGRAM_CHAT_ID=123456789
TELEGRAM_MIN_EV=3   # optional: only announce picks with EV >= 3%
```

Every server start sends a confirmation message to the configured chat and logs success or the Telegram error in Render logs. Each restart or Render Free wake-up sends another one. Notification times always use Quebec time (`America/Toronto`, EDT/EST); daily summaries already sent for a date under an older time zone are not replayed.

Restart Node and run `npm run telegram:test` to confirm delivery. Both bet and result messages include the model's selected-side probability as a percentage. New-bet messages include the scheduled game date/time, without a detection date; result messages include the scheduled game date/time and settlement date/time (when the server reconciles the result, not necessarily the final whistle). The result probability reflects the latest recorded pick, not necessarily the initially announced pick. Times include a time-zone label and respect daylight saving time. Older records without a game date show "Not available". A pick is announced once per event, including across side flips, not on every refresh; results are announced once on reconciliation. Sends are queued about one per second, and failures are logged without the token and never affect the ledger. Without both credential variables, notifications are disabled.

The server persists pending messages and delivery acknowledgements in `data/telegram-outbox.json` (gitignored), using an atomic replace before sending. Network errors, invalid credentials and API failures retain messages for exponential-backoff retries; Telegram's `retry_after` is respected. There is no 100-message drop limit. Keep one process per outbox and provide a persistent disk: committing the prediction ledger does **not** preserve delivery state or newly generated messages on an ephemeral host. Storage failures are logged and the ledger is re-scanned on startup and every 30 seconds to recover missing bet/result enqueue operations. Pending games are checked against ESPN every five minutes even when no browser is open; off-scoreboard reconciliation retains its existing per-sport throttle.

Daily closing messages combine all sports and show wins/decisive picks (e.g. `3/4`), win rate, losses and pushes separately. They use the Audit Lab's **opening pick** and game-date time-zone grouping. A summary is queued only after that local calendar date ends and every tracked event for it has settled; pending or postponed games delay it. No-pick games do not contribute to the fraction. Once delivered, the summary is not revised for predictions imported later.

Delivery is **at least once**, not a 100% or exactly-once guarantee: a timeout or crash after Telegram accepts a message but before acknowledgement is saved can cause a duplicate. A lost disk loses the outbox. On first use of the persistent outbox, existing ledger bet/result notifications and closed-day summaries are recovered; historical alerts can repeat because the former queue did not store delivery acknowledgements. Do not commit the outbox or delete it while notifications are active.

## Workspace

- **Dashboard:** schedules, live scores, model signals, featured matchup, upcoming games and provider win probabilities.
- **AI Prediction Engine:** recent-form signals, historical W/L/T results, search, saved signals, probability/EV filters and sportsbook comparisons.
- **Advanced markets:** NBA and WNBA points, rebounds and assists; WNBA made threes; NFL rushing/passing yards, alternate spreads and team totals; NHL shots on goal and puck lines; EPL shots on target, BTTS and goal totals; plus supported spreads, first-half spreads and game totals. Availability follows provider coverage. EPL three-way moneylines are not modeled.
- **Data Provenance & Source Inspection:** inspect each exact historical observation, event ID, source URL, fetch timestamp, weight, current line, price and model calculation; export the captured analysis as JSON.
- **Bet Tracker:** record personal slips and manually entered odds, manage opening bankroll, review active exposure, win rate, ROI and settlement history, and export the local ledger. ESPN final-score checks are suggestions only; settlement requires confirmation.
- **Live Match Tracker:** live scores, ESPN win-probability series, injury reports, automated match notes, play-by-play, team statistics and available player box scores.
- **API Feeds Status:** connection health, successful fetch times, odds quota, sportsbook setup and pipeline coverage.
- **Audit Lab:** backtested KPI cards (ROI, win rate, Brier score, sample size), a stratified risk-tier/odds-bracket/sport performance table, plain-English amelioration insights, a win fraction calendar, a walk-forward validation and Kelly-grid status panel, and a searchable/filterable/exportable ledger history grid showing each game's date and start time. Sourced entirely from the persistent prediction ledger — see "Quant Audit & Amelioration Lab" under Model Methodology below.

NFL, NBA, WNBA, MLB, NHL and EPL feeds are supported. Advanced market availability varies by league and provider. The default view loads the NFL feed. ESPN's default scoreboard can return its current week or next scheduled slate, not necessarily today's games; each matchup displays its actual date.

Saved signals and the personal ledger persist in this browser's local storage, not an account. Active stakes reserve available bankroll. Win rate excludes active bets, pushes and voids; ROI is settled net profit divided by settled non-void stake. The ledger does not place wagers, handle money, or synchronize across devices. Moneyline signal exports are CSV; market analysis, provenance and ledger exports are JSON.

## Data Flow

```text
Browser -> same-origin Express proxy -> ESPN scoreboard / schedule / summary / injuries
                                    -> The Odds API (server-side key)
        <- normalized scores, history, player stats, probabilities and odds
        -> local statistical model -> signals, comparisons and CSV export
```

| Endpoint | Query | Purpose |
| --- | --- | --- |
| `/api/scoreboard` | `sport=nfl` | Normalized events and season |
| `/api/injuries` | `sport=nfl` | ESPN team injury reports and player availability notes |
| `/api/history` | `sport=nfl&team=12&season=2026` | Current/previous-season team schedules |
| `/api/summary` | `sport=nfl&event=<ESPN event ID>` | Box score, players, plays and win probability |
| `/api/odds` | `sport=nfl` | Supported sportsbook moneylines |
| `/api/markets` | `sport=wnba&event=<ESPN event ID>&market=player_points&window=20` | Per-event quotes and exact-line historical market analysis |
| `/api/predictions` (POST) | `sport=nfl` + JSON body | Legacy route; returns 409 when the background scanner owns predictions |
| `/api/predictions/stats` | `sport=nfl` | Reconciled prediction accuracy (Brier score, hit rate, calibration bias, best sample window) |
| `/api/status` | None | Feed health and quota; never credentials |
| `/api/jobs/status` | None | Background scan timestamps, leagues, counts, errors and last authenticated external trigger |
| `/api/jobs/scan` (POST) | `Authorization: Bearer <BACKGROUND_JOB_TOKEN>` | Queues a background scan and returns 202; does not wait for completion |

Schedules and selected game details poll every 30 seconds while the page is visible. Polling pauses while a dialog is open and can be switched off. There are no WebSocket or subsecond latency claims.

The proxy uses a 20-second score/summary cache, a five-minute injury-report cache, a 15-minute history cache and a 12-hour odds/market cache. It coalesces identical requests, limits upstream concurrency to five, times out individual upstream fetches after 10 seconds, and rate-limits each client to 150 API requests/minute. History loads progressively with three frontend workers. Advanced props can inspect up to 20 historical box scores per team and may take longer on a cold cache; missing or partial history is disclosed. Per-event market queries consume additional provider quota and share the same protected budget as moneylines.

Provider errors are explicit. Failed odds requests remove prices instead of displaying cached odds as current. If a scoreboard refresh fails, the last successful scoreboard stays visible with a warning and timestamp. Scores, lineups, statistics, probabilities and play-by-play coverage vary by event and provider.

## Model Methodology

The product name includes "AI", but this initial implementation is a **transparent statistical baseline**, not a trained neural model, an LLM or a validated betting strategy. Match notes are deterministic summaries of scores and probability changes; actual play-by-play text comes from ESPN.

1. Fetch each team's current and previous-season results.
2. Exclude uncompleted games, duplicate events and games at or after the matchup/current time.
3. Take the latest 10 or 20 completed games, as selected in the engine. A tie counts as half a win. Require at least five games for each team.
4. Apply a Beta(2, 2) prior: `strength = (wins + 2) / (games + 4)`.
5. Convert each strength to an odds ratio `strength / (1 - strength)` and normalize the two ratios into a matchup estimate.
6. Match sportsbook events by normalized home/away names and kickoff within six hours, then select the best available price for the model's side.

For props, spreads, totals, team totals, BTTS and supported first-half markets, each historical result is graded against the exact selected player/team, direction and current line. Missing box-score values are excluded; they are not zeros. Equal-weight observations are summarized using a Beta(2,2) prior on decisive outcomes. At least five decisive results are needed. Push probability is the observed fraction of pushes; it is included separately in expected value. The exact sample and per-observation sources are available in provenance. Historical hit frequency is descriptive and is not backtested model accuracy.

```text
Implied probability = 1 / decimal odds
EV percent = (model probability * decimal odds - 1) * 100
```

The Match Tracker displays ESPN injury reports as context, but the baselines do not use injuries, lineups, opponent strength, home advantage, season transitions or live score state. Injury weighting is excluded until player impact and historical pregame availability can be validated. Even during live games the recent-form estimate remains pregame-only; ESPN's live win probability is a separate series. Implied prices are not de-vigged in the core moneyline model itself (see the supplementary calculators below). Book-specific overtime, void and settlement rules, taxes and fees are not incorporated. Use only markets compatible with the selected league and sportsbook.

Historical frequency is not predictive accuracy. No backtested hit rate or profitability is claimed. Positive estimated EV is not proof of an advantage. Signals are for research, not financial advice. 18+ only; never wager money you cannot afford to lose.

### Supplementary quantitative calculators

`public/js/quants.js` adds pure-function calculators layered on top of the baseline model above. They do not feed back into `predictGame` or change the core moneyline probability — they are separate, clearly labeled math shown in the Prediction Engine's signal inspection dialog and the Match Tracker.

- **No-Vig fair odds** — multiplicative de-vig only (`fair probability = (1/odds) / sum(1/odds)` across the matched best price on each side). Requires a matched sportsbook price for both outcomes; additive and power de-vig methods are not implemented.
- **Kelly Criterion stake sizing** — standard `f* = (b*p - q) / b` using the model's own (uncalibrated) probability, displayed as quarter-Kelly (25% of full Kelly) against the current bankroll. Because it reuses the base model's probability, it inherits all of the base model's limitations above; a positive suggested stake is not proof of a real edge.
- **Monte Carlo posterior preview** — draws 4,000 samples from each team's Beta(wins + 2, losses + 2) posterior (the same distribution implicit in the core model's math), normalizes each draw into a matchup probability the same way `predictGame` does, and reports the resulting mean/median/p10-p90 range. This visualizes the *existing* model's sample-size uncertainty; it is not a play-by-play simulation and adds no new information.
- **Poisson goal model (EPL & NHL, Match Tracker)** — a simplified two-factor model: `expected goals = (team's own scoring rate + opponent's conceding rate) / 2` over each team's last 10 completed games, independently for home and away. The resulting Poisson distributions are combined into a scoreline matrix to estimate win/draw/loss, both-teams-to-score (soccer) and over/under probabilities. This is **not** a league-normalized Dixon-Coles model — there is no adjustment for opponent quality, schedule strength, home advantage magnitude, or injuries, and the "over" line shown is a fixed illustrative reference (2.5 goals for EPL, 5.5 for NHL), not a matched sportsbook total.

### Prediction ledger & calibration feedback loop

The server's `src/prediction-scanner.js` generates pre-game moneyline picks using the same `predictGame` and deterministic parameter selection as the browser, with a fixed 10-game window. It writes priced picks to the append-only ledger (`src/ledger.js`, Supabase when configured, otherwise the local JSONL file). Browser calculations are previews only: changing leagues, refreshing or switching to a 20-game window no longer posts predictions or creates Telegram alerts. The scanner runs at startup and every 10 minutes while the process is alive; see the Supabase Cron setup below to trigger real work on Render Free without an open browser.

Results are reconciled from ESPN scoreboards every five minutes while running and during scheduled jobs. A settled prediction is never reopened. New predictions require both a future kickoff and ESPN's scheduled state. Missing odds, partial histories and insufficient samples are skipped rather than recorded as fabricated bets. Games that drop off the live scoreboard are checked through their ESPN summary at most every 15 minutes per sport once 4+ hours past kickoff. Missing scores never settle as 0-0, and database failures leave records retryable.

`GET /api/predictions/stats?sport=nfl` exposes, per sport:

- **Brier score** (0 = perfect, 1 = worst) and **favorite hit rate** over all reconciled predictions.
- **Calibration bias** — the running average signed error (`model home probability - actual home result`) once at least 20 reconciled predictions exist. The browser subtracts this bias from every new home-win probability before display (`predictGame(..., biasFactor)` in `public/js/model.js`), so the model self-corrects a systematic lean (e.g. persistent home-team overconfidence) without a manual code change.
- **Best-performing sample window** — Brier score remains tracked separately for historical 10-game and 20-game records. New automated records use 10 games; changing the browser preview no longer adds a 20-game trial.
- **Self-tuning recency decay** — Brier score is also tracked separately for each recency-decay value the model has used (see below); once at least two distinct decay values each have 15+ reconciled samples, the lower-Brier value is surfaced as `bestDecay`.

This is visible in the app under API Feeds Status → **Model accuracy**. The append-only ledger uses Supabase in the hosted setup and an in-memory index for calibration. It is shared across visitors, not a per-user record.

### Self-enhancing recency weighting, Bayesian shrinkage & strength-of-schedule tuning

Beyond the flat calibration-bias correction above, `historicalTrend()` in `public/js/model.js` supports additional, backward-compatible self-tuning mechanics:

- **Exponential recency weighting (EWMA-style)** — each team's games within the selected window are weighted by `decay^index` (index 0 = most recent game), so a `decay` below 1 lets recent form count more than older games in the same window, instead of every game counting equally (`decay = 1`, the original behavior). The app currently explores exactly two candidate values (`1` and `0.85`) and picks one per upcoming game via a deterministic hash of the event ID — so the same game always gets the same decay whether it's displayed or logged, keeping the ledger an honest record. Once the ledger's `bestDecay` is confidently known (see above), the app switches to always applying that value instead of exploring.
- **Bayesian shrinkage toward each team's own baseline** — instead of shrinking small samples toward a flat 50% league-average prior, the model now looks at up to 30 of that team's completed games *older* than the selected window (falling back to 50% if fewer than 8 such games exist) and uses that team-specific long-run win rate as the shrinkage target. This means a team on a stretch of unusually good or bad recent form is compared against its own established baseline rather than an arbitrary constant.
- **Strength-of-schedule (SOS) weight self-tuning** — `historicalTrend()` nudges a team's win rate by `sosWeight × (average recency-weighted opponent win% - 0.5)`, correcting for teams that pad their record against weak opponents. `sosWeight` is now an explorable parameter, tuned via the exact same live A/B loop as decay: the app explores five candidate weights (`0`, `0.125`, `0.25`, `0.375`, `0.5`, spanning the requested 0.0–0.5 range) per upcoming game via a deterministic, independently-salted hash, logs which one it used, and the ledger's `bestSosWeight` (see below) declares the lowest-Brier candidate the winner once at least two candidates each have 15+ reconciled samples.

All three mechanics default to their original, pre-existing behavior (`decay = 1`, a 50% prior when no baseline data exists, `sosWeight = 0.3`), so every existing prediction, test and API response is unaffected unless the new self-tuning logic actively picks a different value.

**Explicitly out of scope:** a full least-squares/maximum-likelihood weight-fitting pass over multiple offensive/defensive rating coefficients was considered but not implemented, because the current moneyline model is a single-factor, win/loss-frequency posterior (a Beta-like estimate) — it has no per-factor coefficients (home-field advantage, offensive rating, etc.) to regress against outcomes. Building a residual-correction or multi-factor regression layer would require first adding those factors to the model itself, which is a larger architectural change than the ledger-driven decay/SOS/shrinkage tuning above.

### Backtesting (`src/backtest.js`)

Every prediction the server scanner records carries `selectionPrice`, matched to the model's selected side. The ledger preserves the first logged snapshot as the assumed bet-placement price and the last logged pre-game snapshot as a closing-line proxy. Odds refresh frequency limits the freshness of this proxy; it is not a guaranteed sportsbook closing quote.

`node src/backtest.js [sport]` (or `npm run backtest [-- sport]`) reads `data/predictions.jsonl` and reports, over every resolved prediction with a matched price:

- **ROI** — flat 1-unit-per-bet return on investment, staked at the opening (bet-time) price; pushes are excluded.
- **Brier score** — the mean of each trial's ledger-reconciled calibration score (0 = perfect, 1 = worst).
- **Closing Line Value (CLV)** — the average shift in the picked side's implied probability from opening to closing price (positive = the market moved toward the bettor's side, i.e. "beat the close"), the share of trials that beat the close, and a secondary **model edge vs. the close** (model probability minus the closing implied probability — does the model still see value even after the market has fully priced the game?).
- **Drawdown** — the maximum peak-to-valley drop of a flat-stake equity curve, in units and as a percentage of the peak.

A single blended ROI can hide a losing slice inside a winning total, so every run also reports the same headline metrics (sample size, ROI, Brier score, average CLV) sliced three ways:

- **By risk tier** (`low`/`medium`/`high`, matching the live app's `classifyRisk()`) — exposes whether "low risk" short-priced favorites are actually a slow bleed once the vig is priced in, since a flat proportional margin taxes short favorites the hardest.
- **By odds bracket**, labeled in decimal odds bands (heavy favorite, favorite, even money, underdog, mid underdog, longshot) — shows whether the edge lives in dogs, favorites, or is spread evenly.
- **By sport** — surfaces a sport whose model is quietly losing money that a blended total across sports would otherwise mask.

Empty slices are still listed (as "no resolved trials yet") so a thin sample isn't mistaken for "no data."

`src/backtest.js` also exports its building blocks (`parseLedgerLines`, `buildTrials`, `computeROI`, `computeBrierScore`, `computeCLV`, `computeDrawdown`, `oddsBracket`, `stratifyByRiskTier`, `stratifyByOddsBracket`, `stratifyBySport`, `computeKellyGrid`, `recommendKellyFraction`, `runBacktest`, `backtestFile`) for reuse — for example, from a future dashboard endpoint. Historical CLV/ROI accumulate only from the point `selectionPrice` capture was added, since prices weren't previously logged.

### Automated amelioration (`src/optimize.js`)

Once a backtest can measure performance across historical buckets, the natural next step is to stop guessing the model's tunable constants and let past performance choose them. Three constants are currently hardcoded (recency decay, the SOS weight, and the fractional Kelly multiplier), but they are **not equally tunable from the ledger alone**, and it's important not to conflate the two mechanisms `src/optimize.js` uses:

1. **Recency decay and SOS weight are model *inputs*** — changing them would change the probability the model produces for a past game, but the ledger only ever stored the probability the model actually produced using whichever candidate it happened to explore for that game (see above). There is no stored history of raw team stats to *replay* an offline grid search against without a much larger architectural change (persisting every team's raw game log at prediction time). So these two are tuned live, in the app itself, via the A/B exploration loop described above; `src/optimize.js` simply reads the ledger's already-computed `bestDecay`/`bestSosWeight` per sport into the shared config file.
2. **The fractional Kelly multiplier only scales stake size**, not the model's win probability — so, uniquely, its effect on realized bankroll growth *can* be fully replayed from data the ledger already has (model probability, matched price, outcome). `src/optimize.js` runs a true offline grid search over candidate fractions (`0.1` through `1.0`, including the app's own Quarter/Half Kelly presets) via `computeKellyGrid()`, simulating a compounding bankroll for each. Because grid-searching Kelly fraction on a finite historical sample mechanically rewards the most aggressive fraction (higher fractions compound faster on any fixed sequence of outcomes — a classic overfitting trap), the recommended fraction is the one with the highest historical ending bankroll *among fractions whose historical max drawdown stayed within 40%*, not simply the global-best fraction.

`node src/optimize.js` (or `npm run optimize`) reads `data/predictions.jsonl`, prints a per-sport report, and writes `data/optimized-params.json` — a small config file combining, per sport: `decay.best`, `sosWeight.best`, and `kellyFraction.recommended` plus the full comparison grid each was chosen from. `GET /api/optimized-params` (optionally `?sport=nfl`) serves this file's current contents to any future frontend integration; it degrades to an empty payload if the file hasn't been generated yet. This is intended to be re-run periodically (e.g. a weekly cron job) as the ledger accumulates more reconciled predictions — it is read-only with respect to the live app's own decay/SOS exploration, which keeps working independently of whether this script has ever been run.

### Quant Audit & Amelioration Lab (`src/audit.js`, `public/js/audit.js`)

A dedicated **Audit Lab** workspace (sidebar → "Audit Lab") composes `src/backtest.js`'s ROI/Brier/CLV/drawdown/stratification engine with a few additions, all served through a single `GET /api/audit` endpoint (optional `?sport=nfl`, `?kellyFraction=0.25|0.5` and `?tz=America/New_York` query params — `tz` is the viewer's IANA time zone, falling back to UTC when invalid; an invalid/missing sport is silently ignored rather than rejected, since the report defaults to all sports blended):

- **Win rate** per bucket, layered onto `backtest.js`'s existing risk-tier/odds-bracket/sport stratifications (which only report ROI/Brier/CLV/sample) without modifying that module's tested return shape.
- **Walk-forward validation** — a lightweight rolling-window stability check (default 20-trial windows, 10-trial step) over already-resolved, already-priced trials in ledger order. It reports each window's Brier score and ROI plus an early-vs-late drift metric, flagging when the model's calibration is trending worse over time. This is a stability/drift check on logged predictions, not a true offline retrain-and-replay backtest — recency decay and SOS weight remain live-tuned in the app itself (see above), since replaying them offline would require persisting every team's raw game log at prediction time.
- **Amelioration & Insights** — plain-English diagnostic notes generated from the same computed report: a low-risk-tier bleed warning, underperforming odds-bracket/sport call-outs, a CLV read, a mismatch warning between the historically-recommended Kelly fraction and whatever fraction is actually configured in the bet tracker (`localStorage['sportsstat-kelly-fraction']`, read client-side and passed as `?kellyFraction=`), and a walk-forward drift warning. These are informational only — nothing is auto-applied to the live model.
- **Ledger history grid** — unlike `backtest.js`'s `buildTrials` (which silently drops any prediction missing a selection, a matched price, or a result), the Audit Lab's history grid surfaces *every* logged prediction, pending or resolved, so gaps are visible rather than hidden. It's searchable by team/sport/event ID, filterable by outcome (all/resolved/pending/win/loss), capped at 200 displayed rows for performance, and exportable as a JSON file matching the full computed report. Each row shows the game's scheduled date and start time in the viewer's time zone (e.g. "Oct 1, 2026 - 8:15 PM"). The ledger stores this as `gameDate` on both prediction and result records, so predictions logged before the field existed are backfilled when they're reconciled; older rows still missing it show "Game time not recorded".
- **Win fraction calendar** — a month grid of settled picks grouped by local game date, showing each day's wins over decided picks (`3/4`, `2/2`, …) color-coded green/amber/red, with pushes counted separately (`+1P`) rather than as losses. The month header totals the same fraction. Clicking a day filters the ledger history to that date. Picks are graded on the *opening* selection, the same one the backtest stakes, so the calendar, grid outcome pills and headline win rate always agree.

`node src/audit.js [sport]` (or `npm run audit [-- sport]`) prints the same report from the command line. The Audit Lab view is schedule/scoreboard-independent (like Bet Tracker), so it's excluded from the app's 30-second background auto-refresh and from the loading/error gating that other views use.

## Test

```sh
npm run check
npm test
```

The Node test suite uses injected provider fixtures, not paid APIs. It covers source provenance, sample windows, market quote matching and grading, bet-tracker ledger arithmetic, a configured WNBA prop-analysis endpoint, half-score normalization, route validation, security headers, missing keys, request coalescing and secret redaction. The quantitative calculators, the prediction ledger/reconciliation logic, the backtest engine, the automated amelioration script and the Audit Lab's win-rate/walk-forward/insights logic each have a separate unit-test suite (`tests/quants.test.js`, `tests/ledger.test.js`, `tests/backtest.test.js`, `tests/optimize.test.js`, `tests/audit.test.js`).

Browser smoke checks:

1. Open the app with a working internet connection. Confirm live schedules and real team logos load; without an odds key, prices and EV must remain blank.
2. Open a model signal in the prediction engine and compare all three books.
3. Search in the prediction engine, save a signal and choose Saved signals. Export a CSV of moneyline signals.
4. Open a live NFL match in the Match Tracker: its probability chart, match notes and player sample box scores should render.
5. Switch leagues and market categories, select 10/20-game windows, inspect source weights, and add/settle a ledger slip. At mobile widths, use the navigation menu; tables scroll within their containers.
6. Pause/resume auto-refresh, inspect API Feeds Status and open the model methodology dialog. Test keyboard navigation, Escape and dialog focus.
7. Block `/api/scoreboard` using browser developer tools and reload. Confirm the retry state appears with a way to try again. CDN fonts, icons and images still require connectivity.
8. Open Audit Lab, page through the win fraction calendar and click a day, switch the sport filter, search/filter the ledger history grid (typing must not lose input focus), and export the JSON report.

The dashboard has been checked in the integrated Chromium browser at desktop and mobile sizes. Native file-download behavior should also be smoke-tested in your regular browser; the integrated browser may suppress download events.

## Structure

```text
public/
  index.html             Application entry and navigation shell
  css/styles.css         Responsive dark theme and component styles
  js/app.js              Five views, API lifecycle and interactions
  js/model.js            Pure normalization, statistics and odds math
  js/quants.js           No-vig, Kelly, Poisson and Monte Carlo calculators
  js/markets.js          Market catalog, exact-line analysis and provenance
  js/bets.js             Local ledger accounting and result suggestions
  js/research.js         Market inspection, export and bet-tracker UI
  js/audit.js            Audit Lab KPI cards, insights box, stratified table and ledger history grid UI
src/feeds.js             Cached, bounded provider adapters
src/ledger.js            Persistent prediction ledger, reconciliation and calibration stats
src/backtest.js          ROI, Brier score, CLV and drawdown backtest engine + CLI
src/optimize.js          Automated amelioration: combines live-tuned decay/SOS with an offline Kelly grid search into data/optimized-params.json
src/audit.js             Quant Audit Lab: win rate, walk-forward validation, insights and ledger history on top of src/backtest.js + CLI
server.js                Express server, validation and security headers
tests/model.test.js      Statistical unit tests
tests/quants.test.js     Quantitative calculator unit tests
tests/ledger.test.js     Prediction ledger, reconciliation and calibration unit tests
tests/backtest.test.js   Backtest engine unit tests
tests/optimize.test.js   Automated amelioration (src/optimize.js) unit tests
tests/audit.test.js      Audit Lab (src/audit.js) unit tests
tests/server.test.js     Proxy and provider-adapter tests
.env.example             Local configuration template
```

## Free Persistent History: Render + Supabase

Git deploys code; it does not save files created while the Render app runs back to the repository. Your Mac's ledger and Render's ledger are different copies. Render Free discards runtime files on redeploy, restart and idle spin-down. A tracked ledger can reappear as its old Git version, without the bets collected since deployment.

Keep the existing Git-connected Render Free web service and use a **Supabase Free** project for history. No paid disk or compute upgrade is required. Supabase's current free allowance is 500 MB of database storage; it can pause after a week of inactivity and does not include automatic backups. Monitor its quotas and make exports. Free hosting is not an always-on or unlimited service.

### One-Time Setup

1. Create a Free project at <https://supabase.com/dashboard>. Run all of [supabase/schema.sql](supabase/schema.sql) in its SQL Editor. The tables have RLS enabled and no browser access; only the backend service role can use them.
2. In Render's **Environment** settings, add `SUPABASE_URL` (your project's HTTPS URL), `SUPABASE_SECRET_KEY` (the server secret key, not a publishable/anon key), and `TRUST_PROXY=1`. A legacy `SUPABASE_SERVICE_ROLE_KEY` also works instead of the secret key. Keep these values out of Git, chat and browser code. Do not change your existing odds/Telegram settings.
3. Deploy the updated code through your existing Git integration. The start command remains `npm start`. Startup restores the cloud ledger and Telegram outbox before listening. On Render, missing configuration or an unavailable database stops startup instead of falling back to temporary files.
4. Open `/api/storage` on your deployed site: it should report `"backend":"supabase"` and `"durable":true`. Audit Lab shows **Supabase - durable history**. Let the scanner capture a real priced pre-game prediction, then confirm it remains after a Render restart.

With neither Supabase variable set, local development still uses the local JSONL file. Configuring only one variable is an error. Cloud mode never automatically imports the repository's bundled ledger; do not mistake old Git data or test data for production history.

### Background Alerts With the Browser Closed

Storage alone cannot run a sleeping server. Supabase Cron can make an authenticated request every 10 minutes to wake Render and trigger prediction scanning, result reconciliation and Telegram queue recovery. No paid worker is required. Both platforms' free quotas and availability limits still apply; cold starts, provider failures or project pauses can delay alerts. This is scheduled polling, not guaranteed real-time delivery.

1. In Render, set `BACKGROUND_SCAN_SPORTS` to the leagues to scan, for example `nfl` or `mlb`. Default: `nfl` only. Supported values are comma-separated `nfl,nba,wnba,mlb,nhl`; EPL is excluded because the moneyline model does not support its three-way market. Browsing another league does not add it to the scanner.
2. Set `BACKGROUND_JOB_TOKEN` in Render to a random secret of at least 32 characters. Generate it with a password manager and enter it directly into Render and Supabase Vault, not Git or chat. This is a separate secret from the Supabase service key. Deploy the updated code.
3. In Supabase **Vault**, add `sportsstat_app_url` with your public app URL (for this deployment, `https://bet.auraagency.ca`) and `sportsstat_job_token` with exactly the same secret as Render's `BACKGROUND_JOB_TOKEN`.
4. Run [supabase/background-jobs.sql](supabase/background-jobs.sql) in Supabase's SQL Editor. It enables `pg_cron`/`pg_net` and creates the named `sportsstat-background-scan` job. Re-running it updates that job rather than creating duplicates. The job reads the token from Vault at execution time; the token is not embedded in the cron command.
5. Close the site and check again after the next scheduled run. `/api/jobs/status` should show advancing `lastExternalTriggerAt` and `lastCompletedAt` timestamps, `externalTriggerEnabled: true`, and the intended `sports`. `recorded` counts accepted snapshots in the most recent scan, not new Telegram messages. `errors` explains missing odds or upstream/storage failures. One alert per event is normal even after repeated scans.

In Supabase **Cron**, use **Run Now** for an immediate check. An HTTP 202 means the job was accepted; use `/api/jobs/status` to verify completion. Cron's SQL success alone only means the HTTP request was queued. If the trigger timestamp never advances, inspect the HTTP response:

```sql
select id, status_code, timed_out, error_msg, created
from net._http_response
order by created desc
limit 5;
```

A 401 means the two job tokens differ. A 503 means the trigger is not configured (or the host is unavailable). Enable the named job in the Cron dashboard after any project pause; do not assume paused free services will continue executing.

**Odds budget:** the scanner's 10-minute cadence is independent of the 12-hour odds refresh. Five active leagues at two moneyline refreshes per day need roughly 310 credits over 31 days, leaving room under the default 400-call guard. Browser requests and extra markets share this budget. Prices can be up to 12 hours old, new games may wait for the next refresh, and the closing-line proxy can be stale. This setting prioritizes free-tier usage, not live price accuracy.

Do not run another server instance or a separate worker against the same notification outbox. The scheduled HTTP job targets the existing process, where overlapping scans are coalesced and scans are throttled to at most once every 10 minutes.

### Durable Odds Budget

1. Before deploying this update, re-run all of [supabase/schema.sql](supabase/schema.sql) in the existing project's SQL Editor. It preserves prediction history and notification state, and adds `odds_cache`, `odds_usage` and backend-only RPC functions. No Vault or Cron changes are needed.
2. In Render, set `ODDS_POLL_INTERVAL_MS=43200000` and `ODDS_CREDIT_LIMIT=400`. Existing environment values override the new defaults. The limit accepts 0-400; use a lower number if fewer than 400 provider credits remain in the current billing period, with a margin for any other consumers of the same key. Set 0 to stop new paid calls while still serving unexpired cached prices.
3. Deploy the code. After the first odds lookup, `/api/status` reports `odds.budget.durable: true`, `intervalMs: 43200000`, `limit`, `used`, `remaining`, `windowDays: 31` and `nextReleaseAt`. These are the budget snapshot from the last cache lookup/reservation, not the provider's billing balance. `odds.remaining` is the provider balance at the last fetched odds response and can also be old.

Before every uncached Odds API request, the server atomically reserves one credit in Supabase. Current requests specify one market and three bookmakers, normally costing at most one provider credit. Concurrent processes cannot reserve beyond the shared cap or refresh the same cache key concurrently during its two-minute lease. A successfully saved response retains its original fetch timestamp when restored after a restart.

Every attempted call remains counted for 31 days, even empty responses, HTTP errors, timeouts or a crash before the request reaches the provider. This deliberately overestimates real usage; no refunds or automatic retries spend untracked credits. Failed fetches pause that key for 15 minutes. A crash or failed cache save retains the reservation and its lease. Reservations and old cache entries are pruned automatically during new lookups; there is no calendar-month reset that can accidentally replenish the budget mid-cycle.

When the cap is reached, unexpired cached odds remain usable; once they expire, odds routes return an explicit 503 and the scanner skips unpriced predictions. ESPN result reconciliation and Telegram queue recovery keep running. Missing schema, database failures or failed reservations block new paid requests rather than silently falling back to memory. Without Supabase, the local cache and counter do not survive restarts.

The cap only covers requests made by this updated app against the same Supabase project. It cannot account for credits spent before deployment or by other apps using the key, and must not be reset by deleting usage records. It does not guarantee continuous collection or alert delivery. No code upgrades a paid plan automatically.

### Recover and Back Up

Before deploying, preserve any live history still visible. **Export JSON** in Audit Lab saves its report, but that report is not a lossless ledger backup and its history rows are limited. After this update, `/api/ledger/export` downloads the complete raw JSONL ledger. The route has the same shared, unauthenticated visibility as the existing audit endpoint; protect the app with authentication before public use.

To import a surviving raw ledger from your Mac or an old download, set the same Supabase credentials in your local, gitignored `.env`, then run:

```sh
npm run history:import -- data/predictions.jsonl
```

Only import records you know came from real predictions. Repeating an import is safe: identical records have deterministic IDs and are not duplicated. Imports add records and never delete cloud history. Restart Render after an import so its calibration and reconciliation index also reloads. Existing bet/result notifications may be replayed on the first cloud migration because the new outbox has no old delivery acknowledgements.

For a complete backup, including all opening/closing snapshots and results:

```sh
npm run history:export -- data/history-backup-2026-10-03.jsonl
```

Use a new filename for each backup; the command refuses to overwrite an existing file. Keep another copy outside the app's filesystem. `npm run audit`, `npm run backtest` and `npm run optimize` read Supabase when configured, so local reports can analyze the hosted history. Missing original pre-game records cannot be recreated honestly from final scores alone.

### Runtime Behavior

- Predictions and final results are acknowledged only after a successful database write. Failed results remain pending for reconciliation to retry. Unchanged prediction polls are skipped to conserve database space; changed snapshots are append-only.
- Database read failures return an explicit error, not an empty calendar. Failed scan writes appear in `/api/jobs/status`. Requests page through all stored records rather than truncating at Supabase's default row cap.
- Telegram's pending messages and acknowledgements also use Supabase. Delivery remains at least once: a crash after Telegram accepts a message but before acknowledgement can still duplicate it.
- Run one server instance per ledger/outbox. The server generates picks without browser activity. Configure Supabase Cron above to wake Render Free for scheduled work; local timers alone cannot run while the service sleeps. Overdue recorded games are reconciled after wake-up.
- Bet Tracker's manually entered personal slips remain browser-local; this change protects the shared prediction ledger used by Audit Lab and backtests.

## Before Public Production Use

This is a working, production-minded starter, not a certified production betting system. In particular:

- Production startup assigns predictions to the server scanner and rejects legacy browser writes with HTTP 409. The scheduled trigger requires a private bearer token. Audit/export remain shared public read endpoints: add authentication if the deployment should be private. Telegram announces each event at most once.
- Configure Supabase for ephemeral hosts as described above. Local-file mode is not durable on Render and is blocked there. Run exactly one server process per ledger/outbox; two processes would each reconcile and notify independently.
- Behind a reverse proxy, set `TRUST_PROXY=1` so the API rate limit applies per client instead of to the proxy as a whole.

- Confirm ESPN endpoint usage rights and obtain a licensed provider/SLA if needed. ESPN's public APIs are unofficial and can change without notice.
- Backtest out-of-time, measure probability calibration, address data leakage and settlement rules, and add injury/lineup features before relying on estimates.
- Replace Tailwind's development CDN with compiled CSS; self-host pinned Lucide/fonts/assets. The current CSP permits inline styles/scripts and eval for the requested CDN workflow. Tighten it for deployment.
- Deploy behind HTTPS with authentication where needed, a secret manager, request logging without credentials, monitoring and error reporting. Set `NODE_ENV=production` behind TLS.
- Odds caching and credit reservations are shared through Supabase, but ESPN caches, client rate limiting and ledger/outbox ownership still assume one server process. Do not add instances without addressing those remaining constraints.
- Provide accessibility/security audits, your jurisdiction's age checks and required responsible-gaming controls before offering any wagering workflow. This app does not accept wagers or manage money.

Team marks are supplied by ESPN. The stadium photograph is served from Unsplash. Review third-party asset and data rights before commercial distribution.