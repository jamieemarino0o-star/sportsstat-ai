import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEvent, historicalTrend, predictGame, expectedValue, impliedProbability, americanOdds, matchOdds } from '../public/js/model.js';

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

test('provenance contains the exact weighted sample and source references', () => {
  const source = { provider: 'ESPN', url: 'https://site.api.espn.com/schedule', fetchedAt: '2026-09-20T00:00:00Z' };
  const samples = history.map((entry) => ({ ...entry, source }));
  const prediction = predictGame({ ...game, date: '2030-01-01', completed: false }, samples, samples, 20);
  assert.equal(prediction.home.observations.length, prediction.home.sample);
  assert.equal(prediction.provenance.window, 20);
  assert.equal(prediction.home.observations[0].source.url, source.url);
  assert.ok(Math.abs(prediction.home.observations.reduce((total, item) => total + item.weight, 0) - 1) < 1e-10);
  assert.deepEqual(prediction.provenance.prior, { wins: 2, losses: 2 });
  assert.equal(predictGame({ ...game, sport: 'epl', completed: false }, samples, samples).probability, null);
});

test('predictions require both team samples and never predict completed games', () => {
  assert.equal(predictGame(game, history, history).probability, null);
  assert.equal(predictGame({ ...game, completed: false }, history, []).probability, null);
  const prediction = predictGame({ ...game, date: '2030-01-01', completed: false }, history, history);
  assert.equal(prediction.selection, 'home');
  assert.ok(prediction.probability > 0.5 && prediction.probability < 1);
});

test('decimal odds yield correct EV, implied probability, and American prices', () => {
  assert.ok(Math.abs(expectedValue(0.6, 1.9) - 14) < 1e-10);
  assert.equal(impliedProbability(2), 0.5);
  assert.equal(americanOdds(2.5), '+150');
  assert.equal(americanOdds(1.5), '-200');
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