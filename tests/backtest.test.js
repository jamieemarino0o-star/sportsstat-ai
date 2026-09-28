import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLedger } from '../src/ledger.js';
import { parseLedgerLines, readLedgerFile, buildTrials, computeROI, computeBrierScore, computeCLV, computeDrawdown, runBacktest, backtestFile, oddsBracket, stratifyByRiskTier, stratifyByOddsBracket, stratifyBySport, computeKellyGrid, recommendKellyFraction } from '../src/backtest.js';

function predictionLine(overrides) {
  return JSON.stringify({ type: 'prediction', sport: 'nfl', eventId: '1', homeProbability: 0.6, selection: 'home', selectionPrice: 2, loggedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', ...overrides });
}

function resultLine(overrides) {
  return JSON.stringify({ type: 'result', sport: 'nfl', eventId: '1', outcome: 1, brier: 0.16, resolvedAt: '2026-01-01T20:00:00Z', ...overrides });
}

test('parseLedgerLines groups predictions and results by sport/event and ignores malformed or incomplete lines', () => {
  const groups = parseLedgerLines(['', '  ', 'not json', JSON.stringify({ type: 'prediction', sport: 'nfl' }), predictionLine(), predictionLine({ updatedAt: '2026-01-01T05:00:00Z', selectionPrice: 1.8 }), resultLine()]);
  assert.equal(groups.size, 1);
  const group = groups.get('nfl:1');
  assert.equal(group.predictions.length, 2);
  assert.equal(group.result.outcome, 1);
});

test('buildTrials uses the first logged snapshot as the bet and the last as the closing price, and requires a selection, price and result', () => {
  const groups = parseLedgerLines([predictionLine({ selectionPrice: 1.9 }), predictionLine({ updatedAt: '2026-01-01T12:00:00Z', selectionPrice: 1.6 }), resultLine()]);
  const [trial] = buildTrials(groups);
  assert.equal(trial.openingPrice, 1.9);
  assert.equal(trial.closingPrice, 1.6);
  assert.equal(trial.selection, 'home');
  assert.equal(trial.win, 1);
  assert.ok(Math.abs(trial.modelProbability - 0.6) < 1e-9);

  // No selection recorded: unusable for staking, dropped.
  assert.equal(buildTrials(parseLedgerLines([predictionLine({ selection: null }), resultLine()])).length, 0);
  // No matched price: dropped.
  assert.equal(buildTrials(parseLedgerLines([predictionLine({ selectionPrice: null }), resultLine()])).length, 0);
  // Never resolved: dropped.
  assert.equal(buildTrials(parseLedgerLines([predictionLine()])).length, 0);
  // A push (tied game) still requires a valid price/selection but is excluded from win/loss ROI.
  const [push] = buildTrials(parseLedgerLines([predictionLine(), resultLine({ outcome: 0.5 })]));
  assert.equal(push.win, 0.5);

  // Sport filter narrows to the requested sport only.
  const mixed = parseLedgerLines([predictionLine(), resultLine(), predictionLine({ sport: 'nba', eventId: '2' }), resultLine({ sport: 'nba', eventId: '2' })]);
  assert.equal(buildTrials(mixed, { sport: 'nba' }).length, 1);
  assert.equal(buildTrials(mixed).length, 2);
});

test('computeROI sizes flat unit stakes off the opening (bet-time) price and excludes pushes', () => {
  const win = { win: 1, openingPrice: 2.5 };
  const loss = { win: 0, openingPrice: 1.5 };
  const push = { win: 0.5, openingPrice: 1.9 };
  const result = computeROI([win, loss, push]);
  assert.equal(result.bets, 2);
  assert.equal(result.totalStaked, 2);
  assert.ok(Math.abs(result.totalProfit - (1.5 - 1)) < 1e-9);
  assert.ok(Math.abs(result.roi - 0.25) < 1e-9);
  assert.equal(computeROI([]).roi, null);
});

test('computeBrierScore averages the ledger-reconciled score and ignores unscored trials', () => {
  const score = computeBrierScore([{ brier: 0.1 }, { brier: 0.3 }, { brier: null }]);
  assert.ok(Math.abs(score - 0.2) < 1e-9);
  assert.equal(computeBrierScore([]), null);
});

test('computeCLV rewards prices that shorten in the bettor\'s favor by kickoff and separately reports model edge versus the close', () => {
  // Bet home at 1.80 (55.6% implied); closed at 1.65 (60.6% implied) -- the market moved toward
  // the picked side after the bet, so this should register as a positive CLV / beaten close.
  const beat = { modelProbability: 0.65, openingPrice: 1.8, closingPrice: 1.65 };
  // Bet drifted the other way: opened at 1.65, closed at 1.80 -- the market moved away from the pick.
  const drift = { modelProbability: 0.65, openingPrice: 1.65, closingPrice: 1.8 };
  const result = computeCLV([beat, drift]);
  assert.equal(result.sample, 2);
  assert.ok(result.trials[0].clv > 0);
  assert.ok(result.trials[1].clv < 0);
  assert.ok(Math.abs(result.beatCloseRate - 0.5) < 1e-9);
  assert.ok(Math.abs(result.averageClv) < 1e-9); // the two moves are symmetric and cancel out
  assert.equal(computeCLV([]), null);
});

test('computeDrawdown tracks a flat-stake equity curve and reports the maximum peak-to-valley drop', () => {
  const trials = [{ win: 1, openingPrice: 2 }, { win: 0, openingPrice: 2 }, { win: 0, openingPrice: 2 }, { win: 1, openingPrice: 2 }];
  const result = computeDrawdown(trials, { stake: 1, startingBankroll: 10 });
  // 10 -> 11 (win) -> 10 (loss) -> 9 (loss) -> 10 (win). Peak was 11, trough was 9: drawdown of 2.
  assert.equal(result.endingBankroll, 10);
  assert.ok(Math.abs(result.maxDrawdown - 2) < 1e-9);
  assert.ok(Math.abs(result.maxDrawdownPct - 2 / 11) < 1e-9);
  assert.equal(result.curve.length, 5);
});

test('runBacktest composes every metric from a shared trial list', () => {
  const groups = parseLedgerLines([predictionLine({ selectionPrice: 1.9 }), predictionLine({ updatedAt: '2026-01-01T12:00:00Z', selectionPrice: 1.7 }), resultLine()]);
  const result = runBacktest(buildTrials(groups));
  assert.equal(result.sample, 1);
  assert.equal(result.roi.bets, 1);
  assert.ok(Number.isFinite(result.brier));
  assert.equal(result.clv.sample, 1);
  assert.equal(result.drawdown.startingBankroll, 100);
  assert.ok(Array.isArray(result.byRiskTier));
  assert.ok(Array.isArray(result.byOddsBracket));
  assert.ok(Array.isArray(result.bySport));
});

test('backtestFile reads an on-disk ledger written by the live ledger module end to end', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sportsstat-backtest-'));
  const file = join(dir, 'predictions.jsonl');
  try {
    const ledger = createLedger({ file });
    ledger.record({ sport: 'nfl', eventId: '10', homeProbability: 0.7, selection: 'home', selectionPrice: 1.7 });
    ledger.reconcile('nfl', [{ id: '10', completed: true, home: { score: 24 }, away: { score: 20 } }]);
    ledger.record({ sport: 'nba', eventId: '11', homeProbability: 0.4, selection: 'away', selectionPrice: 2.1 });
    ledger.reconcile('nba', [{ id: '11', completed: true, home: { score: 90 }, away: { score: 100 } }]);
    const all = backtestFile(file);
    assert.equal(all.sample, 2);
    const nflOnly = backtestFile(file, { sport: 'nfl' });
    assert.equal(nflOnly.sample, 1);
    assert.equal(nflOnly.roi.bets, 1);
    assert.equal(readLedgerFile(join(dir, 'missing.jsonl')).size, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('oddsBracket labels decimal prices in bettor-recognizable American odds bands', () => {
  assert.equal(oddsBracket(1.5).key, 'favorite_heavy'); // shorter than -200
  assert.equal(oddsBracket(1.67).key, 'favorite'); // ~-149
  assert.equal(oddsBracket(1.95).key, 'even_money'); // ~-105
  assert.equal(oddsBracket(2.09).key, 'even_money'); // ~+109, still even money
  assert.equal(oddsBracket(2.1).key, 'underdog'); // +110
  assert.equal(oddsBracket(2.5).key, 'underdog'); // +150
  assert.equal(oddsBracket(3.5).key, 'underdog_mid'); // +250
  assert.equal(oddsBracket(5).key, 'longshot'); // +400
  assert.equal(oddsBracket(null), null);
  assert.equal(oddsBracket(1), null);
});

test('stratifyByRiskTier exposes low/medium/high buckets even when a tier has no resolved trials yet', () => {
  // model probability 0.7 (low-risk tier) matched at a longshot price is a mispriced "low-risk" bet --
  // exactly the slow-bleed case Step 2 is meant to surface.
  const mispriced = { modelProbability: 0.7, openingPrice: 3.5, win: 1, brier: 0.09 };
  const buckets = stratifyByRiskTier([mispriced]);
  assert.deepEqual(buckets.map((bucket) => bucket.key), ['low', 'medium', 'high']);
  const low = buckets.find((bucket) => bucket.key === 'low');
  assert.equal(low.sample, 1);
  const medium = buckets.find((bucket) => bucket.key === 'medium');
  assert.equal(medium.sample, 0);
  assert.equal(medium.roi.roi, null);
});

test('stratifyByOddsBracket groups trials by price band and preserves bettor-facing labels for empty bands', () => {
  const favorite = { modelProbability: 0.75, openingPrice: 1.5, win: 1, brier: 0.06 };
  const longshot = { modelProbability: 0.3, openingPrice: 5, win: 0, brier: 0.09 };
  const buckets = stratifyByOddsBracket([favorite, longshot]);
  assert.equal(buckets.find((bucket) => bucket.key === 'favorite_heavy').sample, 1);
  assert.equal(buckets.find((bucket) => bucket.key === 'longshot').sample, 1);
  const emptyBucket = buckets.find((bucket) => bucket.key === 'even_money');
  assert.equal(emptyBucket.sample, 0);
  assert.match(emptyBucket.label, /Even money/);
});

test('stratifyBySport isolates each sport\'s ROI so a blended total cannot hide a losing sport', () => {
  const nflWin = { sport: 'nfl', modelProbability: 0.6, openingPrice: 2, win: 1, brier: 0.16 };
  const wnbaLoss = { sport: 'wnba', modelProbability: 0.6, openingPrice: 2, win: 0, brier: 0.36 };
  const buckets = stratifyBySport([nflWin, wnbaLoss]);
  assert.deepEqual(buckets.map((bucket) => bucket.key), ['nfl', 'wnba']);
  assert.equal(buckets.find((bucket) => bucket.key === 'nfl').roi.roi, 1);
  assert.equal(buckets.find((bucket) => bucket.key === 'wnba').roi.roi, -1);
});


test('computeKellyGrid requires a minimum decisive sample before trusting the grid search', () => {
  const trials = Array.from({ length: 10 }, (_, i) => ({ modelProbability: 0.55, openingPrice: 2, win: i % 2 }));
  const result = computeKellyGrid(trials);
  assert.equal(result.grid.length, 0);
  assert.equal(result.recommendedFraction, null);
  assert.equal(result.sample, 10);
});

test('computeKellyGrid simulates compounding bankroll growth per fraction and recommends the fastest-growing fraction within a drawdown cap', () => {
  // A real positive edge (55% true win rate priced as a 50/50 coin flip at 2.0 decimal odds):
  // growth should increase monotonically with a more aggressive fraction on this fixed sequence.
  const trials = Array.from({ length: 40 }, (_, i) => ({ modelProbability: 0.55, openingPrice: 2, win: i % 20 < 11 ? 1 : 0 }));
  const result = computeKellyGrid(trials, { fractions: [0.1, 0.25, 0.5, 1] });
  assert.equal(result.grid.length, 4);
  const byFraction = Object.fromEntries(result.grid.map((entry) => [entry.fraction, entry]));
  assert.ok(byFraction[1].growthMultiple > byFraction[0.5].growthMultiple);
  assert.ok(byFraction[0.5].growthMultiple > byFraction[0.25].growthMultiple);
  assert.ok(byFraction[1].maxDrawdownPct > byFraction[0.1].maxDrawdownPct);
  // Full Kelly (fraction 1) grows fastest here but should be passed over for breaching the drawdown cap.
  assert.notEqual(result.recommendedFraction, 1);
  assert.equal(result.recommendedFraction, recommendKellyFraction(result.grid));
});

test('recommendKellyFraction falls back to the lowest-drawdown fraction when every candidate breaches the cap', () => {
  const grid = [
    { fraction: 0.5, endingBankroll: 500, maxDrawdownPct: 0.9 },
    { fraction: 1, endingBankroll: 1000, maxDrawdownPct: 0.95 },
  ];
  assert.equal(recommendKellyFraction(grid), 0.5);
  assert.equal(recommendKellyFraction([]), null);
});

test('runBacktest includes a Kelly grid alongside every other metric', () => {
  const trials = Array.from({ length: 32 }, (_, i) => ({ modelProbability: 0.55, openingPrice: 2, win: i % 20 < 11 ? 1 : 0, brier: 0.2, resolvedAt: `2026-01-${(i % 28) + 1}` }));
  const result = runBacktest(trials);
  assert.ok(Array.isArray(result.kellyGrid.grid));
  assert.ok(result.kellyGrid.grid.length > 0);
});
