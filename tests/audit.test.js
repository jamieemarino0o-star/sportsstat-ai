import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLedger } from '../src/ledger.js';
import { computeWinRate, walkForwardValidation, buildLedgerRows, buildWinCalendar, generateInsights, auditReport } from '../src/audit.js';
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

test('ledger rows carry the game date and grade the opening pick; the calendar groups settled picks by local game date', () => {
  const resultLine = (eventId, homeScore, awayScore, gameDate) => JSON.stringify({ type: 'result', sport: 'nfl', eventId, resolved: true, homeScore, awayScore, outcome: homeScore === awayScore ? 0.5 : homeScore > awayScore ? 1 : 0, gameDate, resolvedAt: '2026-10-03T12:00:00Z' });
  const groups = parseLedgerLines([
    // 00:15 UTC on Oct 2 is still Oct 1 in New York.
    predictionLine({ eventId: '1', gameDate: '2026-10-02T00:15:00Z' }), resultLine('1', 24, 10, '2026-10-02T00:15:00Z'),
    predictionLine({ eventId: '2' }), resultLine('2', 3, 20, '2026-10-01T17:00:00Z'), // gameDate only on the result (backfill)
    predictionLine({ eventId: '3', selection: 'away' }), resultLine('3', 7, 30, '2026-10-01T20:00:00Z'),
    predictionLine({ eventId: '4' }), resultLine('4', 14, 14, '2026-10-01T21:00:00Z'),
    predictionLine({ eventId: '5', gameDate: '2026-10-05T17:00:00Z' }), // pending: not settled
    predictionLine({ eventId: '6', selection: null }), resultLine('6', 1, 0, '2026-10-01T18:00:00Z'), // no pick: not a bet
  ]);
  const rows = buildLedgerRows(groups);
  const byId = Object.fromEntries(rows.map((row) => [row.eventId, row]));
  assert.equal(byId['1'].gameDate, '2026-10-02T00:15:00Z');
  assert.equal(byId['2'].gameDate, '2026-10-01T17:00:00Z');
  assert.deepEqual(['1', '2', '3', '4', '5', '6'].map((id) => byId[id].pickResult), ['win', 'loss', 'win', 'push', null, null]);

  assert.deepEqual(buildWinCalendar(rows, { timeZone: 'America/New_York' }), [
    { date: '2026-10-01', wins: 2, losses: 1, pushes: 1, settled: 4, decided: 3, fraction: '2/3', winRate: 2 / 3 },
  ]);
  assert.deepEqual(buildWinCalendar(rows, { timeZone: 'UTC' }).map((day) => [day.date, day.fraction]), [['2026-10-01', '1/2'], ['2026-10-02', '1/1']]);
});

test('auditReport exposes the calendar in the requested time zone and falls back to UTC for invalid zones', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sportsstat-audit-cal-'));
  try {
    const file = join(dir, 'predictions.jsonl');
    const ledger = createLedger({ file });
    ledger.record({ sport: 'nfl', eventId: '9', homeTeam: 'A', awayTeam: 'B', gameDate: '2026-10-02T00:15:00Z', homeProbability: 0.6, selection: 'home', selectionPrice: 1.9 });
    ledger.reconcile('nfl', [{ id: '9', completed: true, date: '2026-10-02T00:15:00Z', home: { score: 21 }, away: { score: 17 } }]);
    const local = auditReport(file, { timeZone: 'America/New_York' });
    assert.equal(local.history[0].gameDate, '2026-10-02T00:15:00.000Z');
    assert.deepEqual(local.calendar, { timeZone: 'America/New_York', days: [{ date: '2026-10-01', wins: 1, losses: 0, pushes: 0, settled: 1, decided: 1, fraction: '1/1', winRate: 1 }] });
    assert.equal(auditReport(file, { timeZone: 'Not/AZone' }).calendar.timeZone, 'UTC');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('yesterday stays 3/3 after a cloud restore and 600 new predictions beyond the history display limit', async () => {
  const records = [];
  const ledger = createLedger({ persist: async (record) => { records.push(record); } });
  for (let index = 1; index <= 3; index += 1) {
    await ledger.record({ sport: 'mlb', eventId: String(index), gameDate: '2026-10-02T18:00:00Z', homeProbability: 0.6, selection: 'home', selectionPrice: 2 });
    await ledger.reconcile('mlb', [{ id: String(index), completed: true, home: { score: 3 }, away: { score: 1 } }]);
  }
  const before = auditReport(records).calendar.days;
  assert.equal(before[0].fraction, '3/3');
  const restored = createLedger({ records, persist: async (record) => { records.push(record); } });
  for (let index = 4; index <= 603; index += 1) await restored.record({ sport: 'mlb', eventId: String(index), gameDate: '2026-10-03T18:00:00Z', homeProbability: 0.6 });
  const report = auditReport(records);
  assert.equal(report.history.length, 500);
  assert.deepEqual(report.calendar.days, before);
});

test('month filter scopes every metric and the history while keeping the full calendar', async () => {
  const records = [];
  const ledger = createLedger({ persist: async (record) => { records.push(record); } });
  const games = [['1', '2026-09-20T18:00:00Z', 3, 1], ['2', '2026-09-21T18:00:00Z', 3, 1], ['3', '2026-10-01T03:30:00Z', 1, 3], ['4', '2026-10-05T18:00:00Z', 3, 1]];
  for (const [id, gameDate, home, away] of games) {
    await ledger.record({ sport: 'nfl', eventId: id, gameDate, homeProbability: 0.6, selection: 'home', selectionPrice: 2 });
    await ledger.reconcile('nfl', [{ id, completed: true, home: { score: home }, away: { score: away } }]);
  }
  const september = auditReport(records, { month: '2026-09', timeZone: 'America/Toronto' });
  // Game 3 kicks off Sept 30 at 11:30 PM in Toronto, so it belongs to September there.
  assert.deepEqual([september.sample, september.winRate.wins, september.winRate.losses, september.history.length], [3, 2, 1, 3]);
  assert.equal(september.month, '2026-09');
  const october = auditReport(records, { month: '2026-10', timeZone: 'America/Toronto' });
  assert.deepEqual([october.sample, october.winRate.winRate, october.roi.roi], [1, 1, 1]);
  assert.equal(october.calendar.days.length, 4);
  assert.deepEqual(october.history[0].risk, { tier: 'medium', byOdds: 'medium', mispriced: false });
  assert.equal(october.history[0].pickProbability, 0.6);
  assert.equal(auditReport(records, { month: 'bad' }).sample, 4);
});
