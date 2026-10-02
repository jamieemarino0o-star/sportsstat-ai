import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEvent, historicalTrend, predictGame, expectedValue, impliedProbability, formatDecimalOdds, matchOdds } from '../public/js/model.js';

const game = { id: '1', date: '2026-09-27T20:00:00Z', home: { id: 'a', name: 'Boston Celtics', score: 110 }, away: { id: 'b', name: 'New York Knicks', score: 99 }, completed: true };
const history = Array.from({ length: 10 }, (_, index) => ({ ...game, id: String(index), date: `2026-09-${String(index + 1).padStart(2, '0')}T20:00:00Z` }));

test('normalizes home and away independently of provider ordering', () => {
  const result = normalizeEvent({ id: '5', date: game.date, competitions: [{ competitors: [
    { homeAway: 'away', score: '99', team: { id: 'b', displayName: 'Away' } },
    { homeAway: 'home', score: { value: 110 }, team: { id: 'a', displayName: 'Home' } },
  ], status: { type: { state: 'post', completed: true } } }] }, 'nba');
  assert.equal(result.home.score, 110);
  assert.equal(result.away.id, 'b');
  assert.equal(result.completed, true);
  assert.equal(normalizeEvent({}, 'nba'), null);
});

test('trend excludes future, incomplete, unrelated and duplicate events', () => {
  const trend = historicalTrend([...history, history[0], { ...game, id: 'future' }, { ...history[0], id: 'incomplete', completed: false }], 'a', '2026-09-20');
  assert.equal(trend.sample, 10);
  assert.equal(trend.frequency, 1);
  assert.equal(trend.probability, 12 / 14);
});

test('small samples do not produce a probability and ties count as half wins', () => {
  assert.equal(historicalTrend(history.slice(0, 4), 'a').probability, null);
  assert.equal(historicalTrend([], 'a').frequency, null);
  assert.equal(historicalTrend([{ ...history[0], away: { ...game.away, score: 110 } }], 'a').wins, 0.5);
});

test('exponential recency decay weights recent games more heavily than older ones', () => {
  // 10 games, most recent 5 are losses and the oldest 5 are wins; frequency is 0.5 either way,
  // but decay < 1 should pull the shrunk probability down since the losses are the recent evidence.
  const mixed = history.map((entry, index) => ({ ...entry, home: { ...entry.home, score: index < 5 ? 120 : 90 }, away: { ...entry.away, score: 100 } }));
  const flat = historicalTrend(mixed, 'a', '2026-09-20', 10, 1);
  const decayed = historicalTrend(mixed, 'a', '2026-09-20', 10, 0.5);
  assert.equal(flat.frequency, 0.5);
  assert.ok(decayed.probability < flat.probability);
  assert.equal(historicalTrend(mixed, 'a', '2026-09-20', 10, 0).decay, 1); // invalid decay falls back to equal weighting
});

test('the Bayesian prior shrinks toward a team\'s own longer-run baseline once enough older games exist', () => {
  const recentLosses = history.map((entry, index) => ({ ...entry, id: `recent-${index}`, home: { ...entry.home, score: 90 }, away: { ...entry.away, score: 100 } }));
  const olderWins = Array.from({ length: 10 }, (_, index) => ({ ...game, id: `older-${index}`, date: `2026-08-${String(index + 1).padStart(2, '0')}T20:00:00Z` }));
  const withoutBaseline = historicalTrend(recentLosses, 'a', '2026-09-20');
  const withBaseline = historicalTrend([...recentLosses, ...olderWins], 'a', '2026-09-20');
  assert.equal(withoutBaseline.baselineMean, null);
  assert.equal(withBaseline.baselineSample, 10);
  assert.equal(withBaseline.baselineMean, 1);
  assert.ok(withBaseline.probability > withoutBaseline.probability);
});

test('strength-of-schedule discounts wins over weak opponents and credits wins over strong opponents, using the record already on the schedule', () => {
  const noRecord = historicalTrend(history, 'a', '2026-09-20');
  assert.equal(noRecord.sos.averageOpponentWinPct, null);
  assert.equal(noRecord.sos.adjustment, 0);
  assert.equal(noRecord.probability, noRecord.rawProbability);
  const weakSchedule = history.map((entry) => ({ ...entry, away: { ...entry.away, record: '2-8' } }));
  const strongSchedule = history.map((entry) => ({ ...entry, away: { ...entry.away, record: '8-2' } }));
  const weak = historicalTrend(weakSchedule, 'a', '2026-09-20');
  const strong = historicalTrend(strongSchedule, 'a', '2026-09-20');
  assert.equal(weak.rawProbability, strong.rawProbability); // identical 10-0 raw record either way
  assert.ok(weak.sos.averageOpponentWinPct < 0.5);
  assert.ok(strong.sos.averageOpponentWinPct > 0.5);
  assert.ok(weak.probability < weak.rawProbability); // padding stats vs. weak teams is discounted
  assert.ok(strong.probability > strong.rawProbability); // beating strong teams is credited
  assert.ok(weak.probability < strong.probability);
  // Fewer than the minimum sample of parseable opponent records: no adjustment applied yet.
  const sparse = history.map((entry, index) => ({ ...entry, away: { ...entry.away, record: index < 2 ? '2-8' : undefined } }));
  assert.equal(historicalTrend(sparse, 'a', '2026-09-20').sos.averageOpponentWinPct, null);
});

test('sosWeight is an explorable parameter: it scales the adjustment magnitude and defaults to the historic 0.3 weight', () => {
  const weakSchedule = history.map((entry) => ({ ...entry, away: { ...entry.away, record: '2-8' } }));
  const zeroWeight = historicalTrend(weakSchedule, 'a', '2026-09-20', 10, 1, 0);
  const halfWeight = historicalTrend(weakSchedule, 'a', '2026-09-20', 10, 1, 0.5);
  const defaulted = historicalTrend(weakSchedule, 'a', '2026-09-20');
  assert.equal(zeroWeight.sos.adjustment, 0); // a weight of 0 disables the SOS adjustment entirely
  assert.equal(zeroWeight.probability, zeroWeight.rawProbability);
  assert.ok(Math.abs(halfWeight.sos.adjustment) > Math.abs(defaulted.sos.adjustment)); // 0.5 > the 0.3 default
  assert.equal(defaulted.sos.weight, 0.3);
  assert.equal(zeroWeight.sos.weight, 0);
  // Out-of-range weights fall back to the module default, exactly like an invalid decay does.
  assert.equal(historicalTrend(weakSchedule, 'a', '2026-09-20', 10, 1, 2).sos.weight, 0.3);
});

test('provenance contains the exact weighted sample and source references', () => {
  const source = { provider: 'ESPN', url: 'https://site.api.espn.com/schedule', fetchedAt: '2026-09-20T00:00:00Z' };
  const samples = history.map((entry) => ({ ...entry, source }));
  const prediction = predictGame({ ...game, date: '2030-01-01', completed: false }, samples, samples, 20);
  assert.equal(prediction.home.observations.length, prediction.home.sample);
  assert.equal(prediction.provenance.window, 20);
  assert.equal(prediction.provenance.sosWeight, 0.3);
  assert.equal(predictGame({ ...game, date: '2030-01-01', completed: false }, samples, samples, 20, 0, 1, 0.5).provenance.sosWeight, 0.5);
  assert.equal(prediction.home.observations[0].source.url, source.url);
  assert.ok(Math.abs(prediction.home.observations.reduce((total, item) => total + item.weight, 0) - 1) < 1e-10);
  assert.deepEqual(prediction.provenance.prior, { strength: 4, homeBaseline: null, homeBaselineSample: 0, awayBaseline: null, awayBaselineSample: 0 });
  assert.equal(predictGame({ ...game, sport: 'epl', completed: false }, samples, samples).probability, null);
});

test('predictions require both team samples and never predict completed games', () => {
  assert.equal(predictGame(game, history, history).probability, null);
  assert.equal(predictGame({ ...game, completed: false }, history, []).probability, null);
  const prediction = predictGame({ ...game, date: '2030-01-01', completed: false }, history, history);
  assert.equal(prediction.selection, 'home');
  assert.ok(prediction.probability > 0.5 && prediction.probability < 1);
});

test('decimal odds yield correct EV, implied probability, and decimal display prices', () => {
  assert.ok(Math.abs(expectedValue(0.6, 1.9) - 14) < 1e-10);
  assert.equal(impliedProbability(2), 0.5);
  assert.equal(formatDecimalOdds(2.5), '2.50');
  assert.equal(formatDecimalOdds(1.5), '1.50');
  assert.equal(formatDecimalOdds(1.9091), '1.91');
  for (const invalid of [null, undefined, NaN, Infinity, 1, -200, '2.5']) {
    assert.equal(formatDecimalOdds(invalid), '--');
  }
  assert.equal(expectedValue(null, 2), null);
  assert.equal(expectedValue(1.1, 2), null);
  assert.equal(expectedValue(0.6, 1), null);
});

test('odds matching requires the same teams, kickoff window and supported book', () => {
  const event = { home_team: game.home.name, away_team: game.away.name, commence_time: game.date, bookmakers: [
    { key: 'draftkings', title: 'DraftKings', markets: [{ key: 'h2h', outcomes: [{ name: game.home.name, price: 1.9 }] }] },
    { key: 'other', title: 'Other', markets: [{ key: 'h2h', outcomes: [{ name: game.home.name, price: 2.1 }] }] },
  ] };
  assert.equal(matchOdds(game, [event]).length, 1);
  assert.deepEqual(matchOdds(game, [{ ...event, commence_time: '2025-01-01' }]), []);
  assert.deepEqual(matchOdds(game, [{ ...event, home_team: 'Wrong team' }]), []);
});