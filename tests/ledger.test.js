import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLedger } from '../src/ledger.js';

function game(id, homeScore, awayScore, completed = true) {
  return { id, completed, home: { score: homeScore }, away: { score: awayScore } };
}

test('records a prediction, ignores invalid input and locks a resolved entry against further writes', () => {
  const ledger = createLedger();
  assert.equal(ledger.record({ sport: 'nfl', eventId: '1', homeProbability: 1.5 }), null);
  assert.equal(ledger.record({ sport: 'nfl', eventId: '', homeProbability: 0.6 }), null);
  const entry = ledger.record({ sport: 'nfl', eventId: '1', homeProbability: 0.6, selection: 'home', window: 10, sample: 10 });
  assert.equal(entry.resolved, false);
  assert.equal(entry.homeProbability, 0.6);
  const [resolved] = ledger.reconcile('nfl', [game('1', 24, 20)]);
  assert.equal(resolved.resolved, true);
  assert.equal(resolved.outcome, 1);
  assert.equal(resolved.favoriteCorrect, true);
  assert.ok(Math.abs(resolved.brier - (0.6 - 1) ** 2) < 1e-9);
  // A further record() call after resolution must not overwrite the immutable ground-truth entry.
  const relocked = ledger.record({ sport: 'nfl', eventId: '1', homeProbability: 0.1 });
  assert.equal(relocked.homeProbability, 0.6);
});

test('reconciliation only resolves completed games and is idempotent', () => {
  const ledger = createLedger();
  ledger.record({ sport: 'nfl', eventId: '2', homeProbability: 0.4, selection: 'away', window: 10 });
  assert.deepEqual(ledger.reconcile('nfl', [game('2', 10, 20, false)]), []);
  const [first] = ledger.reconcile('nfl', [game('2', 10, 20, true)]);
  assert.equal(first.favoriteCorrect, true);
  assert.deepEqual(ledger.reconcile('nfl', [game('2', 10, 20, true)]), []);
});

test('stats compute Brier score, hit rate, calibration bias and best window once minimum samples are met', () => {
  const ledger = createLedger();
  for (let index = 0; index < 25; index += 1) {
    const eventId = `w10-${index}`;
    ledger.record({ sport: 'nba', eventId, homeProbability: 0.7, selection: 'home', window: 10 });
    ledger.reconcile('nba', [game(eventId, index % 5 === 0 ? 90 : 100, 95)]);
  }
  for (let index = 0; index < 25; index += 1) {
    const eventId = `w20-${index}`;
    ledger.record({ sport: 'nba', eventId, homeProbability: 0.7, selection: 'home', window: 20 });
    ledger.reconcile('nba', [game(eventId, 95, index % 5 === 0 ? 90 : 100)]);
  }
  const stats = ledger.stats('nba');
  assert.equal(stats.sample, 50);
  assert.equal(stats.pending, 0);
  assert.ok(stats.brier > 0);
  assert.ok(Number.isFinite(stats.hitRate));
  assert.ok(Math.abs(stats.biasFactor) > 0);
  assert.equal(stats.bestWindow, 10);
  assert.equal(stats.windows[10].sample, 25);
  assert.equal(stats.windows[20].sample, 25);
  assert.deepEqual(ledger.stats('mlb'), { sport: 'mlb', pending: 0, sample: 0, brier: null, hitRate: null, bias: null, windows: { 10: { sample: 0, brier: null, hitRate: null, bias: null }, 20: { sample: 0, brier: null, hitRate: null, bias: null } }, bestWindow: null, biasFactor: 0, decays: {}, bestDecay: null, sosWeights: {}, bestSosWeight: null });
});

test('stats compute a best decay once at least two decay values each have enough resolved samples', () => {
  const ledger = createLedger();
  for (let index = 0; index < 20; index += 1) {
    const eventId = `d1-${index}`;
    ledger.record({ sport: 'nhl', eventId, homeProbability: 0.7, selection: 'home', window: 10, decay: 1 });
    ledger.reconcile('nhl', [game(eventId, index % 4 === 0 ? 90 : 100, 95)]);
  }
  for (let index = 0; index < 20; index += 1) {
    const eventId = `d2-${index}`;
    ledger.record({ sport: 'nhl', eventId, homeProbability: 0.7, selection: 'home', window: 10, decay: 0.85 });
    ledger.reconcile('nhl', [game(eventId, 95, 90)]);
  }
  const stats = ledger.stats('nhl');
  assert.equal(stats.decays[1].sample, 20);
  assert.equal(stats.decays[0.85].sample, 20);
  assert.equal(stats.bestDecay, 0.85); // decay 0.85 always favored home correctly, so it has the lower Brier score
});

test('stats compute a best strength-of-schedule weight once at least two weights each have enough resolved samples', () => {
  const ledger = createLedger();
  for (let index = 0; index < 20; index += 1) {
    const eventId = `s1-${index}`;
    ledger.record({ sport: 'nfl', eventId, homeProbability: 0.7, selection: 'home', window: 10, sosWeight: 0.3 });
    ledger.reconcile('nfl', [game(eventId, index % 4 === 0 ? 90 : 100, 95)]);
  }
  for (let index = 0; index < 20; index += 1) {
    const eventId = `s2-${index}`;
    ledger.record({ sport: 'nfl', eventId, homeProbability: 0.7, selection: 'home', window: 10, sosWeight: 0.125 });
    ledger.reconcile('nfl', [game(eventId, 95, 90)]);
  }
  const stats = ledger.stats('nfl');
  assert.equal(stats.sosWeights[0.3].sample, 20);
  assert.equal(stats.sosWeights[0.125].sample, 20);
  assert.equal(stats.bestSosWeight, 0.125); // 0.125 always favored home correctly, so it has the lower Brier score
});

test('persists predictions and results to disk and reloads them on restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sportsstat-ledger-'));
  const file = join(dir, 'predictions.jsonl');
  try {
    const first = createLedger({ file });
    first.record({ sport: 'nhl', eventId: '9', homeProbability: 0.55, selection: 'home', window: 10 });
    first.reconcile('nhl', [game('9', 3, 2)]);
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    const second = createLedger({ file });
    const stats = second.stats('nhl');
    assert.equal(stats.sample, 1);
    assert.equal(stats.hitRate, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hardening: torn tail repair, finality on reload, invalid scores and prices, overdue lookup, once-only announcements', async () => {
  const { mkdtempSync, rmSync, writeFileSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'sportsstat-ledger-hard-'));
  try {
    const file = join(dir, 'predictions.jsonl');
    const base = { type: 'prediction', sport: 'nfl', homeProbability: 0.6, selection: 'home', loggedAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', resolved: false };
    writeFileSync(file, [
      JSON.stringify({ ...base, eventId: '1' }),
      JSON.stringify({ type: 'result', sport: 'nfl', eventId: '1', resolved: true, homeScore: 7, awayScore: 3, outcome: 1, brier: 0.16 }),
      JSON.stringify({ ...base, eventId: '1' }), // stray post-result prediction (second process)
      '{"type":"prediction","sport":"nfl","eventId":"2","homePro', // torn write, no newline
    ].join('\n'));
    const ledger = createLedger({ file, logger: {} });
    assert.equal(ledger.stats('nfl').sample, 1, 'a later prediction line must not reopen a settled event');

    ledger.record({ sport: 'nfl', eventId: '3', homeTeam: 'A', awayTeam: 'B', gameDate: '2026-09-02T00:00:00Z', homeProbability: 0.55, selection: 'home', selectionPrice: 5000 });
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const last = JSON.parse(lines.at(-1));
    assert.equal(last.eventId, '3', 'the new record is on its own line after the torn tail');
    assert.equal(last.selectionPrice, null, 'implausible prices are discarded');

    assert.deepEqual(ledger.reconcile('nfl', [{ id: '3', completed: true, home: { score: NaN }, away: { score: 3 } }]), [], 'never settle on a missing score');
    assert.deepEqual(ledger.overdue('nfl', { now: Date.parse('2026-09-02T05:00:00Z') }).map((entry) => entry.eventId), ['3']);
    assert.deepEqual(ledger.overdue('nfl', { now: Date.parse('2026-09-02T02:00:00Z') }), [], 'not overdue inside the grace window');

    const announced = [];
    const notifying = createLedger({ file, logger: {}, notifier: { notifyNewBet: (entry) => announced.push(entry.eventId) } });
    notifying.record({ sport: 'nfl', eventId: '4', homeProbability: 0.6, selection: 'home', selectionPrice: 1.9 });
    const reloaded = createLedger({ file, logger: {}, notifier: { notifyNewBet: (entry) => announced.push(entry.eventId) } });
    reloaded.record({ sport: 'nfl', eventId: '4', homeProbability: 0.4, selection: 'away', selectionPrice: 2.2 });
    assert.deepEqual(announced, ['4'], 'announcement state survives a restart and side flips');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('hardening: persistence failures are logged once, never thrown', () => {
  const errors = [];
  const ledger = createLedger({ file: '/dev/null/not-a-dir/predictions.jsonl', logger: { error: (message) => errors.push(message) } });
  assert.ok(ledger.record({ sport: 'nfl', eventId: '1', homeProbability: 0.5 }));
  assert.ok(ledger.record({ sport: 'nfl', eventId: '2', homeProbability: 0.5 }));
  assert.equal(errors.length, 1);
  assert.doesNotMatch(errors[0], /token|key/i);
});
