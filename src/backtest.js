import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { classifyRisk, kellyStake } from '../public/js/quants.js';
import { configuredLedgerSource } from './history-store.js';

// The live ledger (src/ledger.js) keeps an in-memory "latest wins" view of each event for its own
// bookkeeping, but the underlying JSONL file it writes to is append-only: every prediction snapshot
// ever logged for an event survives on disk, even after the event resolves. Replaying the raw file
// here (rather than reusing the ledger's own load()) lets the backtest recover, per event:
//   - the *opening* snapshot: the first prediction logged, i.e. the price available the moment the
//     model's signal first appeared -- the assumed bet-placement point for this backtest.
//   - the *closing* snapshot: the last prediction logged before the event resolved. Predictions are
//     re-posted on every refresh cycle up to kickoff, so this is a close proxy for the closing line.
//   - the result: final score, outcome and Brier score, as reconciled by the ledger.
export function parseLedgerLines(lines) {
  const groups = new Map();
  for (const line of lines) {
    if (!line || !line.trim()) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (!record?.sport || !record?.eventId) continue;
    const key = `${record.sport}:${record.eventId}`;
    const group = groups.get(key) || { predictions: [], result: null };
    if (record.type === 'prediction') group.predictions.push(record);
    else if (record.type === 'result') group.result = record;
    groups.set(key, group);
  }
  return groups;
}

export function readLedgerFile(file) {
  if (Array.isArray(file)) return parseLedgerLines(file.map((record) => JSON.stringify(record)));
  let raw = '';
  try { raw = readFileSync(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return new Map(); throw error; }
  return parseLedgerLines(raw.split('\n'));
}

// A resolved trial: one settled bet, using the model's *first* logged pick and price for the
// event (opening) as the simulated bet, the *last* logged price (closing) for CLV, and the
// ledger's own reconciled outcome/Brier score.
function buildTrial(key, group) {
  if (!group.result || !group.predictions.length) return null;
  const chronological = [...group.predictions].sort((first, second) => new Date(first.updatedAt || first.loggedAt) - new Date(second.updatedAt || second.loggedAt));
  const opening = chronological[0];
  const closing = chronological.at(-1);
  if (!opening.selection || !Number.isFinite(opening.selectionPrice) || opening.selectionPrice <= 1) return null;
  if (group.result.outcome == null) return null;
  const homeWon = group.result.outcome === 1;
  const push = group.result.outcome === 0.5;
  const win = push ? 0.5 : (opening.selection === 'home' ? homeWon : !homeWon) ? 1 : 0;
  const modelProbability = opening.selection === 'home' ? opening.homeProbability : 1 - opening.homeProbability;
  return {
    key, sport: group.result.sport, eventId: group.result.eventId, homeTeam: opening.homeTeam, awayTeam: opening.awayTeam,
    selection: opening.selection, modelProbability, win,
    openingPrice: opening.selectionPrice,
    closingPrice: Number.isFinite(closing.selectionPrice) ? closing.selectionPrice : opening.selectionPrice,
    brier: group.result.brier, loggedAt: opening.loggedAt, resolvedAt: group.result.resolvedAt,
  };
}

// Builds every settled trial from parsed ledger groups, optionally filtered to a single sport.
export function buildTrials(groups, { sport = null } = {}) {
  const trials = [];
  for (const [key, group] of groups) {
    if (sport && group.result?.sport !== sport) continue;
    const trial = buildTrial(key, group);
    if (trial) trials.push(trial);
  }
  return trials.sort((first, second) => new Date(first.resolvedAt) - new Date(second.resolvedAt));
}

// ROI = total profit / total amount wagered, using flat unit stakes (the standard, path-independent
// convention for asking "did the edge exist", as opposed to a compounding/Kelly equity simulation).
// Pushes (outcome === 0.5, i.e. a tie with no favorite/underdog) are excluded: no stake risked.
export function computeROI(trials, { stake = 1 } = {}) {
  const decisive = trials.filter((trial) => trial.win !== 0.5);
  let totalStaked = 0;
  let totalProfit = 0;
  for (const trial of decisive) {
    totalStaked += stake;
    totalProfit += trial.win === 1 ? stake * (trial.openingPrice - 1) : -stake;
  }
  return { bets: decisive.length, totalStaked, totalProfit, roi: totalStaked > 0 ? totalProfit / totalStaked : null };
}

// Brier score = mean squared error between the model's stated probability and the actual outcome
// (0 = perfect calibration, 1 = maximally wrong). Uses the ledger's own reconciled per-event score,
// which is computed against the home-win probability and is therefore selection-agnostic.
export function computeBrierScore(trials) {
  const scored = trials.filter((trial) => Number.isFinite(trial.brier));
  if (!scored.length) return null;
  return scored.reduce((total, trial) => total + trial.brier, 0) / scored.length;
}

// Closing Line Value: did the number move in the bettor's favor after the bet was placed?
// clv = closing implied probability - opening implied probability, for the side actually bet.
// Positive clv means the market shortened the price on your side after you got in -- the classic
// definition of "beating the close" and the strongest available proxy for a genuinely sharp model,
// since a persistent positive average CLV cannot be explained by luck in the outcomes themselves.
// modelEdgeVsClose is a secondary, complementary read: model probability minus the closing implied
// probability, i.e. did the model still see value even after the market had fully priced the game.
export function computeCLV(trials) {
  const withClose = trials.filter((trial) => Number.isFinite(trial.openingPrice) && Number.isFinite(trial.closingPrice));
  if (!withClose.length) return null;
  const implied = (price) => 1 / price;
  let clvTotal = 0;
  let edgeTotal = 0;
  let beatCount = 0;
  const perTrial = withClose.map((trial) => {
    const openingImplied = implied(trial.openingPrice);
    const closingImplied = implied(trial.closingPrice);
    const clv = closingImplied - openingImplied;
    const modelEdgeVsClose = trial.modelProbability - closingImplied;
    clvTotal += clv;
    edgeTotal += modelEdgeVsClose;
    if (clv > 0) beatCount += 1;
    return { ...trial, clv, modelEdgeVsClose };
  });
  return {
    sample: withClose.length, averageClv: clvTotal / withClose.length, beatCloseRate: beatCount / withClose.length,
    averageModelEdgeVsClose: edgeTotal / withClose.length, trials: perTrial,
  };
}

// Maximum peak-to-valley drop in a flat-stake equity curve, in both units and percent of the
// running peak. Trials are assumed to settle in resolution order (already sorted by buildTrials).
export function computeDrawdown(trials, { stake = 1, startingBankroll = 100 } = {}) {
  const decisive = trials.filter((trial) => trial.win !== 0.5);
  let bankroll = startingBankroll;
  let peak = startingBankroll;
  let maxDrawdown = 0;
  let maxDrawdownPct = 0;
  const curve = [{ at: null, bankroll }];
  for (const trial of decisive) {
    bankroll += trial.win === 1 ? stake * (trial.openingPrice - 1) : -stake;
    peak = Math.max(peak, bankroll);
    const drawdown = peak - bankroll;
    const drawdownPct = peak > 0 ? drawdown / peak : 0;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
    if (drawdownPct > maxDrawdownPct) maxDrawdownPct = drawdownPct;
    curve.push({ at: trial.resolvedAt, bankroll });
  }
  return { startingBankroll, endingBankroll: bankroll, maxDrawdown, maxDrawdownPct, curve };
}

// Default Kelly-fraction grid: the two fractions the live research tool actually offers (0.25 and
// 0.5), plus a wider surrounding sweep so the report can show whether a more/less aggressive
// fraction than either preset would have grown the bankroll faster historically.
export const DEFAULT_KELLY_FRACTIONS = [0.1, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.75, 1];

// Simulates a compounding, Kelly-staked equity curve (bankroll * fraction * kellyStake's recommended
// edge-proportional bet) for a single candidate fraction, using the model probability and opening
// price already captured per trial -- no re-run of the prediction model against raw historical
// stats is needed, unlike a decay/SOS grid search (see the module-level comment on computeKellyGrid).
function simulateKellyFraction(trials, fraction, startingBankroll) {
  const decisive = trials.filter((trial) => trial.win !== 0.5);
  let bankroll = startingBankroll;
  let peak = startingBankroll;
  let maxDrawdownPct = 0;
  let bets = 0;
  for (const trial of decisive) {
    const kelly = kellyStake(trial.modelProbability, trial.openingPrice, fraction);
    const stakeAmount = kelly ? bankroll * kelly.recommended : 0;
    if (stakeAmount > 0) bets += 1;
    bankroll += trial.win === 1 ? stakeAmount * (trial.openingPrice - 1) : -stakeAmount;
    bankroll = Math.max(0, bankroll);
    peak = Math.max(peak, bankroll);
    const drawdownPct = peak > 0 ? (peak - bankroll) / peak : 0;
    if (drawdownPct > maxDrawdownPct) maxDrawdownPct = drawdownPct;
    if (bankroll <= 0) break; // ruined -- no bankroll left to stake with
  }
  return { fraction, bets, endingBankroll: bankroll, growthMultiple: bankroll / startingBankroll, maxDrawdownPct };
}

// Grid-searches the fractional Kelly multiplier against the historical ledger. Unlike recency decay
// or the strength-of-schedule weight, the fractional Kelly multiplier only scales *stake size*, not
// the model's win probability itself -- so, uniquely among the app's tunable constants, its effect
// on realized bankroll growth can be fully replayed from data the ledger already captures (model
// probability, matched price, outcome), with no need to re-run the prediction model against raw
// historical team stats. Requires a minimum sample so a handful of lucky/unlucky trials can't make
// an aggressive fraction look artificially safe.
export function computeKellyGrid(trials, { fractions = DEFAULT_KELLY_FRACTIONS, startingBankroll = 100, minSample = 30 } = {}) {
  const decisive = trials.filter((trial) => trial.win !== 0.5 && Number.isFinite(trial.modelProbability) && Number.isFinite(trial.openingPrice));
  if (decisive.length < minSample) return { sample: decisive.length, minSample, grid: [], recommendedFraction: null };
  const grid = fractions.map((fraction) => simulateKellyFraction(decisive, fraction, startingBankroll));
  return { sample: decisive.length, minSample, grid, recommendedFraction: recommendKellyFraction(grid) };
}

// A grid search that simply maximizes historical ending bankroll is prone to picking an
// unrealistically aggressive fraction, since higher Kelly fractions mechanically compound faster on
// any single historical sample (that is exactly what happened, not necessarily what always will).
// To guard against that overfitting trap, this recommends the fraction with the highest ending
// bankroll *among fractions whose historical max drawdown stayed within maxDrawdownCap* -- i.e. the
// fastest historical growth a bettor could have tolerated without an unacceptable bankroll swing.
// Falls back to the single lowest-drawdown fraction if every candidate breached the cap.
export function recommendKellyFraction(grid, { maxDrawdownCap = 0.4 } = {}) {
  if (!grid.length) return null;
  const acceptable = grid.filter((entry) => entry.maxDrawdownPct <= maxDrawdownCap);
  const pool = acceptable.length ? acceptable : [grid.reduce((safest, entry) => (entry.maxDrawdownPct < safest.maxDrawdownPct ? entry : safest), grid[0])];
  return pool.reduce((best, entry) => (entry.endingBankroll > best.endingBankroll ? entry : best), pool[0]).fraction;
}

// Decimal thresholds preserve the original portfolio buckets without rounding prices first.
const ODDS_BRACKETS = [
  { key: 'favorite_heavy', label: 'Heavy favorite (1.00 < odds <= 1.50)', max: 1.5 },
  { key: 'favorite', label: 'Favorite (1.50 < odds <= 1.9091)', max: 1 + 100 / 110 },
  { key: 'even_money', label: 'Even money (1.9091 < odds <= 2.09)', max: 2.09 },
  { key: 'underdog', label: 'Underdog (2.09 < odds <= 2.50)', max: 2.5 },
  { key: 'underdog_mid', label: 'Mid underdog (2.50 < odds <= 4.00)', max: 4 },
  { key: 'longshot', label: 'Longshot (odds > 4.00)', max: Infinity },
];

export function oddsBracket(decimalOdds) {
  if (!Number.isFinite(decimalOdds) || decimalOdds <= 1) return null;
  for (const bracket of ODDS_BRACKETS) {
    if (decimalOdds <= bracket.max) return bracket;
  }
  return ODDS_BRACKETS.at(-1);
}

// Aggregates a bucket of trials into the same headline metrics as the top-level report, so each
// slice (risk tier / odds bracket / sport) can be read the same way as the overall backtest.
function summarizeBucket(trials) {
  return { sample: trials.length, roi: computeROI(trials), brier: computeBrierScore(trials), clv: computeCLV(trials) };
}

// Groups trials by keyFn's return value (a bucket definition, or a plain string/null to skip) and
// summarizes each non-empty bucket. `order` (if given) is a list of keys to enumerate buckets in
// their natural order even when a bucket has zero trials, so "no data yet" slices are still visible.
function stratify(trials, keyFn, order = null) {
  const buckets = new Map();
  for (const trial of trials) {
    const bucket = keyFn(trial);
    if (bucket == null) continue;
    const key = typeof bucket === 'object' ? bucket.key : bucket;
    const label = typeof bucket === 'object' ? bucket.label : bucket;
    if (!buckets.has(key)) buckets.set(key, { key, label, trials: [] });
    buckets.get(key).trials.push(trial);
  }
  const keys = order || [...buckets.keys()];
  return keys
    .filter((key) => order ? true : buckets.has(key))
    .map((key) => {
      const bucket = buckets.get(key);
      return { key, label: bucket?.label ?? key, ...summarizeBucket(bucket?.trials ?? []) };
    });
}

// Slice 1: risk tier, derived the same way the live app classifies a signal -- model probability
// tier (low/medium/high variance) versus the market's own implied tier from the matched price.
// A "low" tier that isn't actually profitable once vig is priced in is the classic bettor trap the
// audit is meant to catch.
export function stratifyByRiskTier(trials) {
  return stratify(trials, (trial) => classifyRisk(trial.modelProbability, trial.openingPrice)?.tier ?? null, ['low', 'medium', 'high']);
}

// Slice 2: decimal odds bracket, so profitability by price range
// (heavy favorites through longshots) is visible independent of the model's own risk tier.
export function stratifyByOddsBracket(trials) {
  return stratify(trials, (trial) => oddsBracket(trial.openingPrice), ODDS_BRACKETS.map((bracket) => bracket.key)).map((bucket) => ({
    ...bucket, label: ODDS_BRACKETS.find((bracket) => bracket.key === bucket.key)?.label ?? bucket.label,
  }));
}

// Slice 3: sport, so a strong blended ROI can't hide one sport's model quietly losing money while
// another subsidizes it.
export function stratifyBySport(trials) {
  return stratify(trials, (trial) => trial.sport, null).sort((first, second) => first.key.localeCompare(second.key));
}

export function runBacktest(trials, options = {}) {
  return {
    sample: trials.length,
    roi: computeROI(trials, options),
    brier: computeBrierScore(trials),
    clv: computeCLV(trials),
    drawdown: computeDrawdown(trials, options),
    byRiskTier: stratifyByRiskTier(trials),
    byOddsBracket: stratifyByOddsBracket(trials),
    bySport: stratifyBySport(trials),
    kellyGrid: computeKellyGrid(trials, options),
  };
}

// End-to-end convenience entry point: reads a ledger file, filters to an optional sport, and runs
// every metric above. This is what the CLI below and any future API endpoint should call.
export function backtestFile(file, { sport = null, stake = 1, startingBankroll = 100 } = {}) {
  const groups = readLedgerFile(file);
  const trials = buildTrials(groups, { sport });
  return runBacktest(trials, { stake, startingBankroll });
}

function formatPercent(value, digits = 1) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(digits)}%` : '--';
}

function printBucketTable(title, buckets) {
  console.log(`\n${title}`);
  if (!buckets.length) { console.log('  No data.'); return; }
  for (const bucket of buckets) {
    if (!bucket.sample) { console.log(`  ${bucket.label}: no resolved trials yet`); continue; }
    const roi = formatPercent(bucket.roi.roi, 2);
    const brier = Number.isFinite(bucket.brier) ? bucket.brier.toFixed(4) : '--';
    const clv = bucket.clv ? formatPercent(bucket.clv.averageClv, 2) : '--';
    console.log(`  ${bucket.label}: n=${bucket.sample}, ROI=${roi}, Brier=${brier}, avg CLV=${clv}`);
  }
}

function printReport(result, { sport }) {
  console.log(`\nSportsStat AI Predictor — Backtest Report${sport ? ` (${sport.toUpperCase()})` : ' (all sports)'}`);
  console.log('='.repeat(50));
  console.log(`Resolved trials with a matched price: ${result.sample}`);
  console.log(`\nROI`);
  console.log(`  Bets: ${result.roi.bets}, Staked: ${result.roi.totalStaked.toFixed(2)}u, Profit: ${result.roi.totalProfit.toFixed(2)}u`);
  console.log(`  ROI: ${formatPercent(result.roi.roi, 2)}`);
  console.log(`\nBrier Score (0 = perfect, 1 = worst): ${Number.isFinite(result.brier) ? result.brier.toFixed(4) : '--'}`);
  console.log(`\nClosing Line Value`);
  if (result.clv) {
    console.log(`  Sample: ${result.clv.sample}`);
    console.log(`  Average CLV: ${formatPercent(result.clv.averageClv, 2)} (percentage points)`);
    console.log(`  Beat-the-close rate: ${formatPercent(result.clv.beatCloseRate)}`);
    console.log(`  Average model edge vs. closing line: ${formatPercent(result.clv.averageModelEdgeVsClose, 2)} (percentage points)`);
  } else console.log('  No trials with both an opening and closing price.');
  console.log(`\nDrawdown (starting bankroll ${result.drawdown.startingBankroll}u)`);
  console.log(`  Ending bankroll: ${result.drawdown.endingBankroll.toFixed(2)}u`);
  console.log(`  Max drawdown: ${result.drawdown.maxDrawdown.toFixed(2)}u (${formatPercent(result.drawdown.maxDrawdownPct)})`);
  printBucketTable('By Risk Tier', result.byRiskTier);
  printBucketTable('By Odds Bracket', result.byOddsBracket);
  printBucketTable('By Sport', result.bySport);
  console.log('\nFractional Kelly Grid Search');
  if (!result.kellyGrid.grid.length) {
    console.log(`  Not enough decisive, priced trials yet (${result.kellyGrid.sample}/${result.kellyGrid.minSample} minimum).`);
  } else {
    for (const entry of result.kellyGrid.grid) {
      const flag = entry.fraction === result.kellyGrid.recommendedFraction ? '  <- recommended' : '';
      console.log(`  Fraction ${entry.fraction}: ${entry.bets} bets, ${entry.growthMultiple.toFixed(2)}x bankroll, max drawdown ${formatPercent(entry.maxDrawdownPct)}${flag}`);
    }
    console.log('  Recommendation maximizes historical bankroll growth among fractions that stayed within a 40% max drawdown, to avoid a search that simply rewards the most aggressive fraction.');
  }
  console.log('');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const sportArg = args.find((arg) => !arg.startsWith('--'));
  const file = fileURLToPath(new URL('../data/predictions.jsonl', import.meta.url));
  const result = backtestFile(await configuredLedgerSource(file), { sport: sportArg || null });
  printReport(result, { sport: sportArg || null });
}
