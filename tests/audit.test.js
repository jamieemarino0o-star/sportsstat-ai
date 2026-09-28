import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLedger } from '../src/ledger.js';
import { computeWinRate, walkForwardValidation, buildLedgerRows, generateInsights, auditReport } from '../src/audit.js';
import { parseLedgerLines } from '../src/backtest.js';

function predictionLine(overrides) {
  return JSON.stringify({ type: 'prediction', sport: 'nfl', eventId: '1', homeProbability: 0.6, selection: 'home', selectionPrice: 2, loggedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', ...overrides });
}
function resultLine(overrides) {
  return JSON.stringify({ type: 'result', sport: 'nfl', eventId: '1', outcome: 1, brier: 0.16, resolvedAt: '2026-01-01T20:00:00Z', ...overrides });
}

test('computeWinRate reports wins/losses independent of price, excluding pushes', () => {
  const empty = computeWinRate([]);
  assert.equal(empty.winRate, null);
  const trials = [{ win: 1 }, { win: 1 }, { win: 0 }, { win: 0.5 }];
  const result = computeWinRate(trials);
  assert.equal(result.sample, 3);
  assert.equal(result.wins, 2);
  assert.equal(result.losses, 1);
  assert.ok(Math.abs(result.winRate - 2 / 3) < 1e-9);
});

test('walkForwardValidation returns an empty report below the window size, and detects rising Brier drift across rolling windows', () => {
  const tooFew = walkForwardValidation([{ brier: 0.2, resolvedAt: '2026-01-01T00:00:00Z', modelProbability: 0.6, win: 1 }], { windowSize: 20, step: 10 });
  assert.deepEqual(tooFew.windows, []);
  assert.equal(tooFew.drift, null);

  // 40 trials: first 20 well-calibrated (brier ~0.04), last 20 poorly calibrated (brier ~0.36) --
  // drift should be strongly positive (recent windows calibrating worse).
  const trials = [];
  for (let i = 0; i < 40; i += 1) {
    const good = i < 20;
    trials.push({ brier: good ? 0.04 : 0.36, resolvedAt: new Date(2026, 0, 1 + i).toISOString(), modelProbability: 0.8, win: good ? 1 : 0 });
  }
  const result = walkForwardValidation(trials, { windowSize: 20, step: 10 });
  assert.ok(result.windows.length >= 2);
  assert.ok(result.drift > 0.1, `expected strongly positive drift, got ${result.drift}`);
  assert.ok(Number.isFinite(result.variance));
});

test('buildLedgerRows surfaces every logged event (resolved or pending), most-recent first, respecting the sport filter and row limit', () => {
  const groups = parseLedgerLines([
    predictionLine({ eventId: '1' }), resultLine({ eventId: '1', resolvedAt: '2026-01-01T20:00:00Z' }),
    predictionLine({ eventId: '2', selectionPrice: null }), // never resolved, no price -- still shown
    predictionLine({ sport: 'nba', eventId: '3' }), resultLine({ sport: 'nba', eventId: '3', resolvedAt: '2026-01-02T20:00:00Z' }),
  ]);
  const rows = buildLedgerRows(groups);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].eventId, '3'); // most recently resolved first
  assert.equal(rows.find((row) => row.eventId === '2').resolved, false);

  const nflOnly = buildLedgerRows(groups, { sport: 'nfl' });
  assert.equal(nflOnly.length, 2);
  assert.ok(nflOnly.every((row) => row.sport === 'nfl'));

  const limited = buildLedgerRows(groups, { limit: 1 });
  assert.equal(limited.length, 1);
});

test('generateInsights flags a losing "low risk" tier hidden inside a positive blended ROI, and surfaces a Kelly fraction mismatch', () => {
  const empty = generateInsights({ sample: 0 });
  assert.equal(empty.length, 1);
  assert.equal(empty[0].level, 'info');

  const result = {
    sample: 40, roi: { roi: 0.05, bets: 40 }, brier: 0.2, clv: null,
    byRiskTier: [{ key: 'low', sample: 20, roi: { roi: -0.1 } }, { key: 'medium', sample: 10, roi: { roi: 0.2 } }, { key: 'high', sample: 0, roi: { roi: null } }],
    byOddsBracket: [], bySport: [{ key: 'nfl', sample: 40, roi: { roi: 0.05 } }],
    kellyGrid: { recommendedFraction: 0.5, sample: 40 }, walkForward: { drift: null },
  };
  const insights = generateInsights(result, { currentKellyFraction: 0.25 });
  assert.ok(insights.some((entry) => entry.level === 'warning' && entry.message.includes('"Low risk"')));
  assert.ok(insights.some((entry) => entry.message.includes('recommends a 0.5 fraction')));
});

test('auditReport combines the backtest engine, win rate, walk-forward validation, insights and ledger history rows into one payload', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sportsstat-audit-'));
  const file = join(dir, 'predictions.jsonl');
  try {
    const ledger = createLedger({ file });
    for (let i = 0; i < 15; i += 1) {
      ledger.record({ sport: 'nfl', eventId: `${i}`, homeProbability: 0.7, selection: 'home', selectionPrice: 1.8 });
      ledger.reconcile('nfl', [{ id: `${i}`, completed: true, home: { score: 100 }, away: { score: 90 } }]);
    }
    const report = auditReport(file, { sport: 'nfl' });
    assert.equal(report.sport, 'nfl');
    assert.equal(report.sample, 15);
    assert.equal(report.winRate.wins, 15);
    assert.ok(Array.isArray(report.insights));
    assert.ok(Array.isArray(report.history));
    assert.equal(report.history.length, 15);
    assert.ok(Number.isFinite(new Date(report.generatedAt).getTime()));

    // Stratified buckets also carry a per-bucket win rate now, not just ROI/Brier/CLV; a 15/15
    // winning sample of 1.8-decimal-odds home favorites should land entirely in the "low" risk
    // tier bucket at a 100% win rate, with the medium/high tiers correctly reporting no sample.
    const low = report.byRiskTier.find((bucket) => bucket.key === 'low');
    assert.equal(low.sample, 15);
    assert.equal(low.winRate.winRate, 1);
    const medium = report.byRiskTier.find((bucket) => bucket.key === 'medium');
    assert.equal(medium.sample, 0);
    assert.equal(medium.winRate.winRate, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
