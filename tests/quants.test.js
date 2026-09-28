import test from 'node:test';
import assert from 'node:assert/strict';
import { noVigProbabilities, shinProbabilities, probabilityTier, oddsTier, classifyRisk, fairOdds, kellyStake, poissonPmf, poissonMatrix, matchupProbabilities, totalGoalsDistribution, probabilityOverLine, expectedGoals, monteCarloMatchup } from '../public/js/quants.js';

function mulberry32(seed) {
  let state = seed;
  return () => {
    state |= 0; state = (state + 0x6D2B79F5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('no-vig removes the bookmaker margin for a two-way market', () => {
  const result = noVigProbabilities([1.91, 1.91]);
  assert.ok(Math.abs(result.probabilities[0] - 0.5) < 1e-9);
  assert.ok(Math.abs(result.probabilities[1] - 0.5) < 1e-9);
  assert.ok(result.overround > 0.04 && result.overround < 0.05);
  assert.equal(noVigProbabilities([1.5]), null);
  assert.equal(noVigProbabilities([1, 2]), null);
  assert.equal(fairOdds(0.5), 2);
  assert.equal(fairOdds(0), null);
  assert.equal(fairOdds(1.5), null);
});

test("Shin's method recovers 50/50 for a symmetric market and corrects longshot bias versus multiplicative de-vigging", () => {
  const symmetric = shinProbabilities([1.91, 1.91]);
  assert.ok(Math.abs(symmetric.probabilities[0] - 0.5) < 1e-9);
  assert.ok(Math.abs(symmetric.probabilities[1] - 0.5) < 1e-9);
  assert.ok(symmetric.z > 0 && symmetric.z < 0.5);
  const skewed = shinProbabilities([1.20, 5.50]);
  const multiplicative = noVigProbabilities([1.20, 5.50]);
  // Shin's method should shade further toward the favorite than a flat proportional split, since
  // it models the bookmaker's margin as insider-trading protection concentrated on the longshot side.
  assert.ok(skewed.probabilities[0] > multiplicative.probabilities[0]);
  assert.ok(skewed.probabilities[1] < multiplicative.probabilities[1]);
  assert.ok(Math.abs(skewed.probabilities.reduce((total, value) => total + value, 0) - 1) < 1e-9);
  const threeWay = shinProbabilities([2.20, 3.40, 3.20]);
  assert.ok(Math.abs(threeWay.probabilities.reduce((total, value) => total + value, 0) - 1) < 1e-9);
  assert.equal(shinProbabilities([1.5]), null);
  assert.equal(shinProbabilities([1, 2]), null);
  assert.equal(shinProbabilities([2.5, 2.5]), null); // sum of inverse odds <= 1: no margin to remove
});

test('risk classification segments by model probability and flags disagreement with the market-implied tier as a possible mispricing', () => {
  assert.equal(probabilityTier(0.7), 'low');
  assert.equal(probabilityTier(0.5), 'medium');
  assert.equal(probabilityTier(0.3), 'high');
  assert.equal(probabilityTier(null), null);
  assert.equal(oddsTier(1.6), 'low');
  assert.equal(oddsTier(2.2), 'medium');
  assert.equal(oddsTier(4), 'high');
  assert.equal(oddsTier(1), null);
  const aligned = classifyRisk(0.7, 1.6);
  assert.equal(aligned.tier, 'low');
  assert.equal(aligned.mispriced, false);
  // Model likes this side heavily (70%) but the market is pricing it like a longshot (+300):
  // a real disagreement between the model's risk read and the market's, worth flagging.
  const mispriced = classifyRisk(0.7, 4);
  assert.equal(mispriced.tier, 'low');
  assert.equal(mispriced.byOdds, 'high');
  assert.equal(mispriced.mispriced, true);
  assert.deepEqual(classifyRisk(null, 1.6), { tier: null, byProbability: null, byOdds: 'low', mispriced: false });
});

test('kelly stake sizes edges and clamps negative edges to zero', () => {
  const positive = kellyStake(0.6, 2, 0.25);
  assert.ok(Math.abs(positive.fullKelly - 0.2) < 1e-9);
  assert.ok(Math.abs(positive.recommended - 0.05) < 1e-9);
  assert.ok(positive.edge > 0);
  const negative = kellyStake(0.3, 2, 0.25);
  assert.equal(negative.fullKelly, 0);
  assert.equal(negative.recommended, 0);
  assert.equal(kellyStake(1.1, 2), null);
  assert.equal(kellyStake(0.5, 1), null);
});

test('poisson pmf sums to one and matches a known value', () => {
  assert.ok(Math.abs(poissonPmf(2, 0) - Math.exp(-2)) < 1e-9);
  let total = 0;
  for (let k = 0; k <= 40; k += 1) total += poissonPmf(3, k);
  assert.ok(Math.abs(total - 1) < 1e-6);
  assert.equal(poissonPmf(-1, 0), null);
  assert.equal(poissonPmf(2, 1.5), null);
});

test('poisson matrix and derived distributions sum to one and respect goal advantage', () => {
  const matrix = poissonMatrix(1.8, 1.1, 6);
  const total = matrix.flat().reduce((sum, value) => sum + value, 0);
  assert.ok(Math.abs(total - 1) < 1e-6);
  const outcomes = matchupProbabilities(matrix);
  assert.ok(Math.abs(outcomes.home + outcomes.draw + outcomes.away - 1) < 1e-6);
  assert.ok(outcomes.home > outcomes.away);
  const distribution = totalGoalsDistribution(matrix);
  assert.ok(Math.abs(distribution.reduce((sum, value) => sum + value, 0) - 1) < 1e-6);
  const over = probabilityOverLine(distribution, 2.5);
  const under = distribution.slice(0, 3).reduce((sum, value) => sum + value, 0);
  assert.ok(Math.abs(over + under - 1) < 1e-6);
  assert.equal(poissonMatrix(-1, 1), null);
  assert.equal(matchupProbabilities(null), null);
});

test('expected goals averages scoring and conceding rates and requires a minimum sample', () => {
  const makeGame = (id, homeId, awayId, homeScore, awayScore, daysAgo) => ({
    id, completed: true, date: new Date(Date.now() - daysAgo * 86400000).toISOString(),
    home: { id: homeId, score: homeScore }, away: { id: awayId, score: awayScore },
  });
  const homeEvents = Array.from({ length: 6 }, (_, index) => makeGame(`h${index}`, 'home', 'opp', 2, 1, index + 1));
  const awayEvents = Array.from({ length: 6 }, (_, index) => makeGame(`a${index}`, 'away', 'opp2', 1, 1, index + 1));
  const result = expectedGoals(homeEvents, awayEvents, 'home', 'away', new Date().toISOString(), 10);
  assert.ok(Math.abs(result.homeGoals - (2 + 1) / 2) < 1e-9);
  assert.ok(Math.abs(result.awayGoals - (1 + 1) / 2) < 1e-9);
  assert.equal(result.sample.home, 6);
  assert.equal(expectedGoals(homeEvents.slice(0, 4), awayEvents, 'home', 'away'), null);
});

test('monte carlo matchup samples a distribution consistent with the underlying win rates', () => {
  const rng = mulberry32(42);
  const result = monteCarloMatchup({ wins: 8, sample: 10 }, { wins: 3, sample: 10 }, 3000, rng);
  assert.equal(result.iterations, 3000);
  assert.ok(result.mean > 0.6 && result.mean < 0.95);
  assert.ok(result.p10 < result.median && result.median < result.p90);
  assert.equal(result.buckets.reduce((sum, bucket) => sum + bucket.count, 0), 3000);
  assert.equal(monteCarloMatchup({ wins: 1, sample: 3 }, { wins: 3, sample: 10 }, 1000, rng), null);
});
