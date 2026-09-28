import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLedger } from '../src/ledger.js';
import { optimizeSport, optimize, writeOptimizedParams } from '../src/optimize.js';

test('optimizeSport surfaces the ledger\'s live-explored decay/SOS winners and a fresh Kelly grid search, independently, for one sport', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sportsstat-optimize-'));
  const file = join(dir, 'predictions.jsonl');
  try {
    const ledger = createLedger({ file });
    for (let i = 0; i < 20; i += 1) {
      ledger.record({ sport: 'nfl', eventId: `d1-${i}`, homeProbability: 0.7, selection: 'home', decay: 1, selectionPrice: 1.5 });
      ledger.reconcile('nfl', [{ id: `d1-${i}`, completed: true, home: { score: i % 4 === 0 ? 90 : 100 }, away: { score: 95 } }]);
      ledger.record({ sport: 'nfl', eventId: `d2-${i}`, homeProbability: 0.7, selection: 'home', decay: 0.85, selectionPrice: 2.2 });
      ledger.reconcile('nfl', [{ id: `d2-${i}`, completed: true, home: { score: 95 }, away: { score: 90 } }]);
    }
    const result = optimizeSport(file, 'nfl');
    assert.equal(result.sport, 'nfl');
    assert.equal(result.decay.best, 0.85); // decay 0.85 always favored home correctly
    assert.equal(result.sosWeight.best, null); // no sosWeight variety logged, so no comparison possible
    assert.equal(result.kellyFraction.sample, 40); // every trial above is decisive and priced
    assert.ok(Array.isArray(result.kellyFraction.grid));
    assert.ok(result.kellyFraction.grid.length > 0);
    // An unrelated sport with zero ledger entries degrades to "nothing to report yet", not an error.
    const empty = optimizeSport(file, 'mlb');
    assert.equal(empty.decay.best, null);
    assert.equal(empty.sosWeight.best, null);
    assert.equal(empty.kellyFraction.recommended, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('optimize combines every supported sport into one report, and writeOptimizedParams persists it to disk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sportsstat-optimize-'));
  const file = join(dir, 'predictions.jsonl');
  const outFile = join(dir, 'optimized-params.json');
  try {
    const ledger = createLedger({ file });
    ledger.record({ sport: 'nba', eventId: '1', homeProbability: 0.6, selection: 'home', selectionPrice: 1.9 });
    ledger.reconcile('nba', [{ id: '1', completed: true, home: { score: 100 }, away: { score: 90 } }]);
    const result = optimize(file);
    assert.ok(Number.isFinite(new Date(result.generatedAt).getTime()));
    assert.ok(Object.hasOwn(result.sports, 'nfl'));
    assert.ok(Object.hasOwn(result.sports, 'nba'));
    assert.equal(result.sports.nba.kellyFraction.sample, 1);

    const written = writeOptimizedParams(file, outFile);
    assert.equal(JSON.parse(readFileSync(outFile, 'utf8')).sports.nba.sport, 'nba');
    assert.equal(written.sports.nba.sport, 'nba');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
