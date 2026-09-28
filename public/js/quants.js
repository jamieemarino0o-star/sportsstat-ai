import { recentGames } from './model.js';

export function noVigProbabilities(prices) {
  if (!Array.isArray(prices) || prices.length < 2 || prices.some((price) => !Number.isFinite(price) || price <= 1)) return null;
  const implied = prices.map((price) => 1 / price);
  const overround = implied.reduce((total, value) => total + value, 0);
  if (!Number.isFinite(overround) || overround <= 0) return null;
  return { probabilities: implied.map((value) => value / overround), overround: overround - 1 };
}

// Shin's method (Shin, 1992/1993) models the bookmaker's margin as protection against informed
// ("insider") bettors rather than a flat proportional tax. It solves for z, the market's implied
// share of insider money, then derives true probabilities from it. This corrects a known bias in
// simple multiplicative de-vigging: it under-favorites and over-dogs longshots, because a flat
// margin split ignores that bookmakers shade longshot odds more heavily to protect against sharps.
// Reference implementation: https://github.com/mberk/shin (closed form for two-way markets; fixed-point
// iteration from Shin's own equation for three-way-plus markets).
export function shinProbabilities(prices, { maxIterations = 100, tolerance = 1e-12 } = {}) {
  if (!Array.isArray(prices) || prices.length < 2 || prices.some((price) => !Number.isFinite(price) || price <= 1)) return null;
  const inverseOdds = prices.map((price) => 1 / price);
  const sumInverseOdds = inverseOdds.reduce((total, value) => total + value, 0);
  if (!Number.isFinite(sumInverseOdds) || sumInverseOdds <= 1) return null;
  let z;
  if (prices.length === 2) {
    const diff = inverseOdds[0] - inverseOdds[1];
    const denominator = sumInverseOdds * (diff ** 2 - 1);
    z = denominator !== 0 ? ((sumInverseOdds - 1) * (diff ** 2 - sumInverseOdds)) / denominator : 0;
  } else {
    z = 0;
    for (let iteration = 0; iteration < maxIterations; iteration += 1) {
      const next = (inverseOdds.reduce((total, io) => total + Math.sqrt(Math.max(0, z ** 2 + (4 * (1 - z) * io ** 2) / sumInverseOdds)), 0) - 2) / (prices.length - 2);
      if (Math.abs(next - z) < tolerance) { z = next; break; }
      z = next;
    }
  }
  if (!Number.isFinite(z)) return null;
  z = Math.max(0, Math.min(z, 0.999999));
  const raw = inverseOdds.map((io) => (Math.sqrt(Math.max(0, z ** 2 + (4 * (1 - z) * io ** 2) / sumInverseOdds)) - z) / (2 * (1 - z)));
  const total = raw.reduce((sum, value) => sum + value, 0);
  if (!Number.isFinite(total) || total <= 0) return null;
  return { probabilities: raw.map((value) => value / total), z, overround: sumInverseOdds - 1 };
}

export function fairOdds(probability) {
  return Number.isFinite(probability) && probability > 0 && probability <= 1 ? 1 / probability : null;
}

export function kellyStake(probability, decimalOdds, fraction = 0.25) {
  if (!Number.isFinite(probability) || probability <= 0 || probability >= 1
    || !Number.isFinite(decimalOdds) || decimalOdds <= 1 || !Number.isFinite(fraction) || fraction <= 0 || fraction > 1) return null;
  const b = decimalOdds - 1;
  const edge = probability * decimalOdds - 1;
  const fullKelly = Math.max(0, Math.min(1, (b * probability - (1 - probability)) / b));
  return { edge, fullKelly, recommended: fullKelly * fraction };
}

// Risk & Edge Classification: segments a signal by model probability (variance/stability profile)
// and cross-checks it against the market's own implied risk tier (from the price). When the two
// disagree, the market is pricing this side very differently from how the model reads its chances -
// a signal worth double-checking (it may be a genuine mispricing, or a sign the model is missing
// context like injuries). Boundaries follow standard book conventions: -200/-125 for favorites,
// +100/+175 for the pick'em band, +200+ for longshots.
export function probabilityTier(probability) {
  if (!Number.isFinite(probability)) return null;
  if (probability >= 0.65) return 'low';
  if (probability >= 0.45) return 'medium';
  return 'high';
}

export function oddsTier(decimalOdds) {
  if (!Number.isFinite(decimalOdds) || decimalOdds <= 1) return null;
  if (decimalOdds <= 1.8) return 'low';
  if (decimalOdds <= 2.75) return 'medium';
  return 'high';
}

export function classifyRisk(probability, decimalOdds) {
  const byProbability = probabilityTier(probability);
  const byOdds = oddsTier(decimalOdds);
  if (!byProbability || !byOdds) return { tier: byProbability, byProbability, byOdds, mispriced: false };
  return { tier: byProbability, byProbability, byOdds, mispriced: byProbability !== byOdds };
}

function factorial(k) {
  let result = 1;
  for (let value = 2; value <= k; value += 1) result *= value;
  return result;
}

export function poissonPmf(lambda, k) {
  if (!Number.isFinite(lambda) || lambda < 0 || !Number.isInteger(k) || k < 0) return null;
  if (lambda === 0) return k === 0 ? 1 : 0;
  return Math.exp(-lambda + k * Math.log(lambda) - Math.log(factorial(k)));
}

export function poissonMatrix(homeLambda, awayLambda, maxGoals = 6) {
  if (!Number.isFinite(homeLambda) || !Number.isFinite(awayLambda) || homeLambda < 0 || awayLambda < 0 || !Number.isInteger(maxGoals) || maxGoals < 1) return null;
  const homeProbs = Array.from({ length: maxGoals + 1 }, (_, k) => poissonPmf(homeLambda, k));
  const awayProbs = Array.from({ length: maxGoals + 1 }, (_, k) => poissonPmf(awayLambda, k));
  homeProbs[maxGoals] += Math.max(0, 1 - homeProbs.reduce((total, value) => total + value, 0));
  awayProbs[maxGoals] += Math.max(0, 1 - awayProbs.reduce((total, value) => total + value, 0));
  return homeProbs.map((homeP) => awayProbs.map((awayP) => homeP * awayP));
}

export function matchupProbabilities(matrix) {
  if (!Array.isArray(matrix) || !matrix.length) return null;
  let home = 0;
  let draw = 0;
  let away = 0;
  let btts = 0;
  for (let i = 0; i < matrix.length; i += 1) {
    for (let j = 0; j < matrix[i].length; j += 1) {
      const value = matrix[i][j];
      if (i > j) home += value; else if (i === j) draw += value; else away += value;
      if (i > 0 && j > 0) btts += value;
    }
  }
  return { home, draw, away, btts };
}

export function totalGoalsDistribution(matrix) {
  if (!Array.isArray(matrix) || !matrix.length) return null;
  const distribution = new Array((matrix.length - 1) * 2 + 1).fill(0);
  for (let i = 0; i < matrix.length; i += 1) {
    for (let j = 0; j < matrix[i].length; j += 1) distribution[i + j] += matrix[i][j];
  }
  return distribution;
}

export function probabilityOverLine(distribution, line) {
  if (!Array.isArray(distribution) || !Number.isFinite(line)) return null;
  let over = 0;
  for (let total = 0; total < distribution.length; total += 1) if (total > line) over += distribution[total];
  return over;
}

export function expectedGoals(homeEvents, awayEvents, homeId, awayId, before = new Date().toISOString(), window = 10) {
  const homeGames = recentGames(homeEvents, homeId, before, window);
  const awayGames = recentGames(awayEvents, awayId, before, window);
  if (homeGames.length < 5 || awayGames.length < 5) return null;
  const split = (games, teamId) => {
    const average = (values) => values.reduce((total, value) => total + value, 0) / values.length;
    return {
      scored: average(games.map((game) => (game.home.id === teamId ? game.home.score : game.away.score))),
      allowed: average(games.map((game) => (game.home.id === teamId ? game.away.score : game.home.score))),
      sample: games.length,
    };
  };
  const home = split(homeGames, homeId);
  const away = split(awayGames, awayId);
  return {
    homeGoals: Math.max(0.1, (home.scored + away.allowed) / 2),
    awayGoals: Math.max(0.1, (away.scored + home.allowed) / 2),
    sample: { home: home.sample, away: away.sample },
    provenance: {
      version: 'poisson-goals-v1', window,
      method: 'Average of each team\u2019s own scoring rate and the opponent\u2019s conceding rate over the recent window. No league-wide attack/defense normalization or schedule-strength adjustment is applied.',
    },
  };
}

function sampleNormal(rng) {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function sampleGamma(shape, rng) {
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x;
    let v;
    do {
      x = sampleNormal(rng);
      v = 1 + c * x;
    } while (v <= 0);
    v **= 3;
    const u = rng();
    if (u < 1 - 0.0331 * x ** 4) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

function sampleBeta(alpha, beta, rng) {
  const x = sampleGamma(alpha, rng);
  const y = sampleGamma(beta, rng);
  return x / (x + y);
}

export function monteCarloMatchup(home, away, iterations = 4000, rng = Math.random) {
  if (!Number.isFinite(home?.wins) || !Number.isFinite(home?.sample) || home.sample < 5
    || !Number.isFinite(away?.wins) || !Number.isFinite(away?.sample) || away.sample < 5
    || !Number.isInteger(iterations) || iterations < 100) return null;
  const results = new Array(iterations);
  for (let index = 0; index < iterations; index += 1) {
    const homeStrength = sampleBeta(home.wins + 2, home.sample - home.wins + 2, rng);
    const awayStrength = sampleBeta(away.wins + 2, away.sample - away.wins + 2, rng);
    const homeOdds = homeStrength / (1 - homeStrength);
    const awayOdds = awayStrength / (1 - awayStrength);
    results[index] = homeOdds / (homeOdds + awayOdds);
  }
  results.sort((first, second) => first - second);
  const percentile = (p) => results[Math.min(results.length - 1, Math.floor(p * results.length))];
  const bucketSize = 0.05;
  const buckets = Array.from({ length: Math.round(1 / bucketSize) }, (_, index) => ({ from: index * bucketSize, to: (index + 1) * bucketSize, count: 0 }));
  for (const value of results) buckets[Math.min(buckets.length - 1, Math.floor(value / bucketSize))].count += 1;
  return {
    iterations,
    mean: results.reduce((total, value) => total + value, 0) / results.length,
    median: percentile(0.5),
    p10: percentile(0.1),
    p90: percentile(0.9),
    buckets,
    provenance: { version: 'monte-carlo-beta-v1', method: 'Samples each team\u2019s Beta(wins+2, losses+2) posterior and normalizes odds ratios per draw; visualizes sampling uncertainty already implied by the recent-form model, not new information.' },
  };
}
