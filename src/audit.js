import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { readLedgerFile, buildTrials, runBacktest, computeROI, oddsBracket } from './backtest.js';
import { classifyRisk } from '../public/js/quants.js';
import { configuredLedgerSource } from './history-store.js';

// The "Quant Audit & Amelioration Lab" builds on top of the existing backtest engine
// (src/backtest.js) rather than duplicating its ROI/Brier/CLV/drawdown/stratification math. This
// module adds three things the backtest CLI doesn't already provide: a headline win-rate KPI, a
// lightweight walk-forward stability check (to flag whether the model's calibration is drifting
// rather than merely reporting one static blended number), and a plain-English insights generator
// that reads the backtest's own stratified buckets and turns them into suggested adjustments -- the
// same reasoning a human auditor would apply by eye, made automatic.

// Win rate is a simpler, more intuitive KPI than ROI or Brier score for a summary card: the raw
// share of decisive (non-push) picks that actually won, independent of the price paid for them.
export function computeWinRate(trials) {
  const decisive = trials.filter((trial) => trial.win !== 0.5);
  if (!decisive.length) return { sample: 0, wins: 0, losses: 0, winRate: null };
  const wins = decisive.filter((trial) => trial.win === 1).length;
  return { sample: decisive.length, wins, losses: decisive.length - wins, winRate: wins / decisive.length };
}

// A lightweight walk-forward validation: rather than a single blended Brier/ROI number (which can
// hide whether the model has been getting better or worse over time, or was simply lucky/unlucky in
// one stretch), this slices chronologically-resolved trials into overlapping rolling windows and
// reports each window's own Brier score, ROI and signed residual (predicted - actual, matching the
// sign convention of the ledger's own calibration bias). Comparing the earliest windows against the
// most recent ones surfaces *drift*: a model whose recent error is meaningfully higher than its
// historical error may be overfit to a regime that no longer holds, rather than genuinely improving.
// This intentionally does not retrain or replay the model itself (see src/optimize.js's header
// comment on why decay/SOS weight can't be replayed offline) -- it only measures how stable the
// *existing* logged predictions have been over time, which requires no new data collection.
export function walkForwardValidation(trials, { windowSize = 20, step = 10 } = {}) {
  const scored = trials.filter((trial) => Number.isFinite(trial.brier)).sort((first, second) => new Date(first.resolvedAt) - new Date(second.resolvedAt));
  if (scored.length < windowSize) return { windowSize, step, sample: scored.length, windows: [], earlyAvgBrier: null, lateAvgBrier: null, drift: null, variance: null };
  const windows = [];
  for (let start = 0; start + windowSize <= scored.length; start += step) {
    const slice = scored.slice(start, start + windowSize);
    const brier = slice.reduce((total, trial) => total + trial.brier, 0) / slice.length;
    const residual = slice.reduce((total, trial) => total + (trial.modelProbability - trial.win), 0) / slice.length;
    windows.push({ from: slice[0].resolvedAt, to: slice.at(-1).resolvedAt, sample: slice.length, brier, roi: computeROI(slice).roi, residual });
  }
  const average = (values) => values.reduce((total, value) => total + value, 0) / values.length;
  const briers = windows.map((entry) => entry.brier);
  const half = Math.ceil(briers.length / 2);
  const earlyAvgBrier = average(briers.slice(0, half));
  const lateAvgBrier = briers.length > half ? average(briers.slice(half)) : null;
  const variance = briers.length > 1 ? average(briers.map((brier) => (brier - average(briers)) ** 2)) : null;
  return {
    windowSize, step, sample: scored.length, windows, earlyAvgBrier, lateAvgBrier,
    // Positive drift = recent windows are calibrating worse than earlier ones (rising Brier score).
    drift: Number.isFinite(lateAvgBrier) ? lateAvgBrier - earlyAvgBrier : null, variance,
  };
}

// Builds the searchable/filterable ledger history grid: one row per logged event, whether resolved
// or still pending, so the frontend can show the complete prediction history rather than only
// settled bets. Unlike buildTrials (which requires a selection, a matched price and a result to be
// usable for staking math), this keeps every event so the grid can honestly show gaps in the data
// (no price matched, no selection favored, or still awaiting a final score).
// Grades the *opening* pick (the same side buildTrials() stakes in src/backtest.js), so the
// history grid, calendar and headline win rate all agree. Ties are a push, not a win.
function pickResult(selection, result) {
  if (!result?.resolved || !selection || result.outcome == null) return null;
  if (result.outcome === 0.5) return 'push';
  return (selection === 'home') === (result.outcome === 1) ? 'win' : 'loss';
}

export function isValidTimeZone(timeZone) {
  if (!timeZone || typeof timeZone !== 'string') return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone }); return true; } catch { return false; }
}

// YYYY-MM-DD for an instant in the given IANA time zone (en-CA formats dates as ISO).
export function dayKey(value, timeZone = 'UTC') {
  if (!value || Number.isNaN(Date.parse(value))) return null;
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
}

// Daily win fraction over settled picks, bucketed by the game's local date in the viewer's time
// zone (falling back to resolution time for older entries logged before gameDate was recorded).
// The fraction is wins over decisive picks ("3/4"); pushes are counted separately, not as losses.
export function buildWinCalendar(rows, { timeZone = 'UTC' } = {}) {
  const days = new Map();
  for (const row of rows) {
    if (!row.pickResult) continue;
    const date = dayKey(row.gameDate || row.resolvedAt || row.loggedAt, timeZone);
    if (!date) continue;
    const day = days.get(date) || { date, wins: 0, losses: 0, pushes: 0 };
    if (row.pickResult === 'win') day.wins += 1;
    else if (row.pickResult === 'loss') day.losses += 1;
    else day.pushes += 1;
    days.set(date, day);
  }
  return [...days.values()]
    .map((day) => {
      const decided = day.wins + day.losses;
      return { ...day, settled: decided + day.pushes, decided, fraction: `${day.wins}/${decided}`, winRate: decided ? day.wins / decided : null };
    })
    .sort((first, second) => first.date.localeCompare(second.date));
}

export function buildLedgerRows(groups, { sport = null, limit = 500 } = {}) {
  const rows = [];
  for (const [key, group] of groups) {
    if (!group.predictions.length) continue;
    const chronological = [...group.predictions].sort((first, second) => new Date(first.updatedAt || first.loggedAt) - new Date(second.updatedAt || second.loggedAt));
    const opening = chronological[0];
    const closing = chronological.at(-1);
    if (sport && opening.sport !== sport) continue;
    const result = group.result;
    const gameDate = result?.gameDate || [...chronological].reverse().find((entry) => entry.gameDate)?.gameDate || null;
    const pickProbability = opening.selection === 'home' ? opening.homeProbability : opening.selection === 'away' ? 1 - opening.homeProbability : null;
    const risk = opening.selection ? classifyRisk(pickProbability, opening.selectionPrice) : null;
    rows.push({
      key, sport: opening.sport, eventId: opening.eventId, homeTeam: opening.homeTeam, awayTeam: opening.awayTeam,
      selection: opening.selection, homeProbability: opening.homeProbability, pickProbability,
      risk: risk?.tier ? { tier: risk.tier, byOdds: risk.byOdds, mispriced: risk.mispriced } : null,
      openingPrice: opening.selectionPrice ?? null, closingPrice: closing.selectionPrice ?? null,
      window: opening.window, decay: opening.decay, sosWeight: opening.sosWeight,
      resolved: Boolean(result?.resolved), homeScore: result?.homeScore ?? null, awayScore: result?.awayScore ?? null,
      outcome: result?.outcome ?? null, favoriteCorrect: result?.favoriteCorrect ?? null, brier: result?.brier ?? null,
      pickResult: pickResult(opening.selection, result),
      gameDate, loggedAt: opening.loggedAt, resolvedAt: result?.resolvedAt ?? null,
    });
  }
  return rows
    .sort((first, second) => new Date(second.resolvedAt || second.loggedAt) - new Date(first.resolvedAt || first.loggedAt))
    .slice(0, limit);
}

// stratify()'s bucket summaries (from src/backtest.js) only report ROI/Brier/CLV, not win rate --
// this bolts a per-bucket win rate on afterward by re-deriving the exact same bucketing key each
// stratifyBy* function already uses internally, so the added win rate always lines up with the same
// buckets runBacktest() returned, without needing to change backtest.js's own tested return shape.
function attachWinRates(buckets, trials, keyFn) {
  return buckets.map((bucket) => {
    const bucketTrials = trials.filter((trial) => {
      const value = keyFn(trial);
      const key = value && typeof value === 'object' ? value.key : value;
      return key === bucket.key;
    });
    return { ...bucket, winRate: computeWinRate(bucketTrials) };
  });
}

function pct(value, digits = 1) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(digits)}%` : '--';
}

// Turns the audit's own computed numbers into plain-English diagnostic notes and suggested
// parameter adjustments -- the automated version of what a human auditor would notice by eye when
// reading the stratified tables. Every insight cites the sample size it is based on so a thin slice
// isn't mistaken for a confident finding; a minimum sample of 10 is required per bucket before it is
// surfaced at all, mirroring the conservative sample gates used elsewhere in the app (bestDecay,
// bestSosWeight, computeKellyGrid).
const MIN_BUCKET_SAMPLE = 10;
export function generateInsights(result, { currentKellyFraction = 0.25 } = {}) {
  const insights = [];
  if (!result.sample) {
    insights.push({ level: 'info', message: 'No resolved predictions with a matched price yet. Insights will appear automatically once enough bets settle.' });
    return insights;
  }

  if (Number.isFinite(result.roi.roi)) {
    insights.push({
      level: result.roi.roi > 0 ? 'positive' : 'warning',
      message: `Overall ROI is ${pct(result.roi.roi, 2)} across ${result.roi.bets} decisive bets. ${result.roi.roi > 0 ? 'The blended edge is real, but check the slices below for a hidden losing segment before increasing stake size.' : 'The blended book is currently in the red — review the odds-bracket and risk-tier slices below for where the drag is coming from.'}`,
    });
  }

  const lowTier = result.byRiskTier.find((bucket) => bucket.key === 'low');
  if (lowTier?.sample >= MIN_BUCKET_SAMPLE && Number.isFinite(lowTier.roi.roi) && lowTier.roi.roi < 0) {
    insights.push({ level: 'warning', message: `"Low risk" bets are actually losing money (${pct(lowTier.roi.roi, 2)} ROI over ${lowTier.sample} bets) — the vig on short favorites is likely eating the edge. Consider raising the minimum EV threshold applied to low-tier picks.` });
  }

  for (const bucket of result.byOddsBracket) {
    if (bucket.sample >= MIN_BUCKET_SAMPLE && Number.isFinite(bucket.roi.roi) && bucket.roi.roi < -0.05) {
      insights.push({ level: 'warning', message: `${bucket.label} bets are unprofitable (${pct(bucket.roi.roi, 2)} ROI, n=${bucket.sample}). Consider filtering this price range or requiring a larger edge before staking here.` });
    }
  }

  for (const bucket of result.bySport) {
    if (bucket.sample < MIN_BUCKET_SAMPLE || !Number.isFinite(bucket.roi.roi)) continue;
    if (bucket.roi.roi < 0) insights.push({ level: 'warning', message: `${bucket.key.toUpperCase()} is currently unprofitable (${pct(bucket.roi.roi, 2)} ROI, n=${bucket.sample}) despite the blended total — the model may need sport-specific recalibration.` });
    else if (bucket.roi.roi > 0.1) insights.push({ level: 'positive', message: `${bucket.key.toUpperCase()} is the strongest performer in the ledger (${pct(bucket.roi.roi, 2)} ROI, n=${bucket.sample}).` });
  }

  if (result.clv?.sample >= MIN_BUCKET_SAMPLE) {
    insights.push({
      level: result.clv.averageClv > 0 ? 'positive' : 'info',
      message: `Average closing line value is ${pct(result.clv.averageClv, 2)}, beating the close on ${pct(result.clv.beatCloseRate)} of bets — ${result.clv.averageClv > 0 ? 'a genuinely sharp signal, since it cannot be explained by lucky outcomes alone.' : 'the model is not yet consistently beating the closing number.'}`,
    });
  }

  if (result.kellyGrid.recommendedFraction != null && result.kellyGrid.recommendedFraction !== currentKellyFraction) {
    insights.push({ level: 'info', message: `The historical Kelly grid search recommends a ${result.kellyGrid.recommendedFraction} fraction (currently using ${currentKellyFraction}) based on ${result.kellyGrid.sample} priced bets, staying within a 40% max-drawdown cap. This is informational only — the app does not auto-apply it.` });
  }

  if (Number.isFinite(result.walkForward?.drift)) {
    if (result.walkForward.drift > 0.02) insights.push({ level: 'warning', message: `Recent rolling windows show a rising Brier score (drift +${result.walkForward.drift.toFixed(4)} vs. the earliest windows) — calibration may be degrading over time. Running \`npm run optimize\` to refresh the decay/SOS self-tuning may help.` });
    else if (result.walkForward.drift < -0.02) insights.push({ level: 'positive', message: `Recent rolling windows show an improving Brier score (drift ${result.walkForward.drift.toFixed(4)} vs. the earliest windows) — the self-tuning loop appears to be helping.` });
  }

  if (!insights.some((entry) => entry.level === 'warning')) insights.push({ level: 'info', message: 'No major hidden drags detected in the current sample. Keep accumulating resolved bets for a more powerful audit.' });

  return insights;
}

// End-to-end entry point for both the CLI below and the GET /api/audit endpoint: reads the ledger
// file once, runs the full backtest (ROI/Brier/CLV/drawdown/stratification/Kelly grid), adds win
// rate and walk-forward validation, generates plain-English insights from all of it, and returns
// the interactive ledger history grid rows -- everything the Audit Lab page needs in one call.
export function isValidMonth(month) {
  return typeof month === 'string' && /^20\d{2}-(0[1-9]|1[0-2])$/.test(month);
}

// Same date the calendar uses: game date, falling back to resolution or logging time.
function groupDay(group, timeZone) {
  const gameDate = group.result?.gameDate || [...group.predictions].reverse().find((entry) => entry.gameDate)?.gameDate;
  return dayKey(gameDate || group.result?.resolvedAt || group.predictions[0]?.loggedAt, timeZone);
}

export function auditReport(file, { sport = null, kellyFraction = 0.25, historyLimit = 500, timeZone = 'UTC', month = null } = {}) {
  const zone = isValidTimeZone(timeZone) ? timeZone : 'UTC';
  const selectedMonth = isValidMonth(month) ? month : null;
  const allGroups = readLedgerFile(file);
  const groups = selectedMonth ? new Map([...allGroups].filter(([, group]) => group.predictions.length && groupDay(group, zone)?.startsWith(selectedMonth))) : allGroups;
  const trials = buildTrials(groups, { sport });
  const backtest = runBacktest(trials);
  const result = {
    sport, month: selectedMonth, generatedAt: new Date().toISOString(), ...backtest, winRate: computeWinRate(trials), walkForward: walkForwardValidation(trials),
    byRiskTier: attachWinRates(backtest.byRiskTier, trials, (trial) => classifyRisk(trial.modelProbability, trial.openingPrice)?.tier ?? null),
    byOddsBracket: attachWinRates(backtest.byOddsBracket, trials, (trial) => oddsBracket(trial.openingPrice)),
    bySport: attachWinRates(backtest.bySport, trials, (trial) => trial.sport),
  };
  const allRows = buildLedgerRows(groups, { sport, limit: Infinity });
  return {
    ...result, insights: generateInsights(result, { currentKellyFraction: kellyFraction }), history: allRows.slice(0, historyLimit),
    calendar: { timeZone: zone, days: buildWinCalendar(selectedMonth ? buildLedgerRows(allGroups, { sport, limit: Infinity }) : allRows, { timeZone: zone }) },
  };
}

function printReport(result) {
  console.log(`\nSportsStat AI Predictor — Quant Audit Report${result.sport ? ` (${result.sport.toUpperCase()})` : ' (all sports)'}`);
  console.log('='.repeat(50));
  console.log(`Sample: ${result.sample} resolved, priced trials`);
  console.log(`Win rate: ${pct(result.winRate.winRate)} (${result.winRate.wins}W / ${result.winRate.losses}L)`);
  console.log(`ROI: ${pct(result.roi.roi, 2)}`);
  console.log(`Brier score: ${Number.isFinite(result.brier) ? result.brier.toFixed(4) : '--'}`);
  if (result.walkForward.windows.length) console.log(`Walk-forward drift: ${Number.isFinite(result.walkForward.drift) ? result.walkForward.drift.toFixed(4) : '--'} (${result.walkForward.windows.length} rolling windows of ${result.walkForward.windowSize})`);
  const recentDays = result.calendar.days.slice(-7);
  if (recentDays.length) console.log(`Daily win fraction (${result.calendar.timeZone}): ${recentDays.map((day) => `${day.date} ${day.fraction}`).join(' · ')}`);
  console.log('\nAmelioration & Insights');
  for (const insight of result.insights) console.log(`  [${insight.level.toUpperCase()}] ${insight.message}`);
  console.log('');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const sportArg = args.find((arg) => !arg.startsWith('--'));
  const file = fileURLToPath(new URL('../data/predictions.jsonl', import.meta.url));
  printReport(auditReport(await configuredLedgerSource(file), { sport: sportArg || null }));
}
