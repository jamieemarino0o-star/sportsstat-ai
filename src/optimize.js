import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLedger } from './ledger.js';
import { readLedgerFile, buildTrials, computeKellyGrid } from './backtest.js';
import { SPORTS } from './feeds.js';

// Automated amelioration: combines every self-tuning signal the app can honestly compute today into
// one canonical config file (data/optimized-params.json) that the live model/backend can read.
//
// Two very different mechanisms feed this file, and it is important not to conflate them:
//
//   1. Recency decay and the strength-of-schedule weight are *inputs* to the prediction model
//      itself (public/js/model.js) -- changing them changes what probability the model would have
//      produced for a past game. The ledger only stores the probability the model actually produced
//      at the time, using whichever candidate value the live app happened to explore for that game
//      (see DECAY_CANDIDATES / SOS_CANDIDATES in public/js/app.js). There is no stored history of
//      raw team stats to *replay* a batch grid search against, so these two are tuned via a live A/B
//      exploration loop instead: the app deterministically assigns each game one of a few candidate
//      values, logs which one it used, and once the ledger has enough reconciled samples per
//      candidate, src/ledger.js's stats() declares the lower-Brier value the winner. This script
//      simply surfaces that already-computed winner (per sport) into the shared config file.
//   2. The fractional Kelly multiplier only scales *stake size*, not the model's win probability, so
//      its effect on realized bankroll growth CAN be fully replayed after the fact from data already
//      in the ledger (model probability, matched price, outcome) -- this script runs a true offline
//      grid search for it via src/backtest.js's computeKellyGrid.
export function optimizeSport(file, sport) {
  const ledgerStats = createLedger({ file }).stats(sport);
  const trials = buildTrials(readLedgerFile(file), { sport });
  const kelly = computeKellyGrid(trials);
  return {
    sport,
    decay: { best: ledgerStats.bestDecay, candidates: ledgerStats.decays },
    sosWeight: { best: ledgerStats.bestSosWeight, candidates: ledgerStats.sosWeights },
    kellyFraction: { recommended: kelly.recommendedFraction, sample: kelly.sample, minSample: kelly.minSample, grid: kelly.grid },
  };
}

export function optimize(file) {
  const sports = Object.keys(SPORTS).map((sport) => optimizeSport(file, sport));
  return { generatedAt: new Date().toISOString(), sports: Object.fromEntries(sports.map((entry) => [entry.sport, entry])) };
}

export function writeOptimizedParams(file, outFile) {
  const result = optimize(file);
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, JSON.stringify(result, null, 2));
  return result;
}

function printReport(result) {
  console.log('\nSportsStat AI Predictor — Automated Amelioration Report');
  console.log('='.repeat(56));
  for (const entry of Object.values(result.sports)) {
    const anySample = entry.decay.best != null || entry.sosWeight.best != null || entry.kellyFraction.sample > 0;
    if (!anySample) continue;
    console.log(`\n${entry.sport.toUpperCase()}`);
    console.log(`  Recency decay: ${entry.decay.best != null ? `${entry.decay.best} (winner)` : 'not enough reconciled samples per candidate yet'}`);
    console.log(`  Strength-of-schedule weight: ${entry.sosWeight.best != null ? `${entry.sosWeight.best} (winner)` : 'not enough reconciled samples per candidate yet'}`);
    if (entry.kellyFraction.recommended != null) {
      console.log(`  Fractional Kelly: ${entry.kellyFraction.recommended} recommended (n=${entry.kellyFraction.sample} decisive priced trials)`);
    } else {
      console.log(`  Fractional Kelly: not enough decisive, priced trials yet (${entry.kellyFraction.sample}/${entry.kellyFraction.minSample} minimum)`);
    }
  }
  console.log('');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const ledgerFile = fileURLToPath(new URL('../data/predictions.jsonl', import.meta.url));
  const outFile = fileURLToPath(new URL('../data/optimized-params.json', import.meta.url));
  const result = writeOptimizedParams(ledgerFile, outFile);
  printReport(result);
  console.log(`Wrote ${outFile}`);
}
