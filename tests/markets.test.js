import test from 'node:test';
import assert from 'node:assert/strict';
import { SPORT_MARKETS, analyzeMarket, bestQuotes, marketQuotes, readPlayerStat, gameMarketValue, gradeValue } from '../public/js/markets.js';
import { betMetrics, createSlip, settleSlip, suggestedResult } from '../public/js/bets.js';
import { createDemo, createDemoMarkets } from '../public/js/demo.js';

const game = { id: '1', sport: 'wnba', date: '2030-05-01', home: { id: '1', name: 'Las Vegas Aces', score: 90, firstHalfScore: 43 }, away: { id: '2', name: 'New York Liberty', score: 86, firstHalfScore: 40 } };
const quote = { market: 'player_points', subject: 'A Player', direction: 'Over', line: 20, price: 1.9 };
const observations = Array.from({ length: 10 }, (_, index) => ({ eventId: String(index), date: `2025-01-${String(index + 1).padStart(2, '0')}`, value: index < 6 ? 25 : index < 8 ? 19 : 20 }));

test('all advertised demo markets have finite values, auditable samples and explicit fixture sources', () => {
  for (const sport of Object.keys(SPORT_MARKETS)) {
    const demo = createDemo(sport);
    for (const market of SPORT_MARKETS[sport].filter((key) => key !== 'h2h')) {
      const result = createDemoMarkets(demo.games[0], demo.history, market, 20);
      assert.ok(result.signals.length > 0, `${sport}: ${market}`);
      for (const signal of result.signals) {
        assert.equal(signal.analysis.sample, 20);
        assert.ok(signal.analysis.provenance.sources.every((entry) => Number.isFinite(entry.value) && entry.source.provider.includes('simulated')));
      }
    }
  }
});

test('market analysis respects pushes, minimum samples, cutoff and weights', () => {
  const result = analyzeMarket([...observations, observations[0], { eventId: 'future', date: '2031-01-01', value: 30 }], quote);
  assert.equal(result.sample, 10);
  assert.equal(result.wins, 6);
  assert.equal(result.losses, 2);
  assert.equal(result.pushes, 2);
  assert.ok(Math.abs(result.probability - (8 / 12) * 0.8) < 1e-10);
  assert.ok(Math.abs(result.ev - (result.probability * 1.9 + 0.2 - 1) * 100) < 1e-10);
  assert.equal(analyzeMarket(observations.slice(0, 4), quote).probability, null);
  assert.equal(result.provenance.sources[0].weight, 0.1);
});

test('WNBA prop quotes preserve player, direction and exact line across books', () => {
  const event = { id: 'odds1', home_team: game.home.name, away_team: game.away.name, commence_time: game.date, bookmakers: ['draftkings', 'fanduel'].map((key, index) => ({ key, title: key, markets: [{ key: 'player_points', outcomes: [{ description: 'A Player', name: 'Over', point: 20 + index, price: 1.9 + index * 0.1 }] }] })) };
  const quotes = marketQuotes(game, [event], 'player_points');
  assert.equal(bestQuotes(quotes).length, 2);
  assert.equal(quotes[0].subject, 'A Player');
  assert.deepEqual(marketQuotes(game, [{ ...event, home_team: 'Wrong Team' }], 'player_points'), []);
  assert.ok(SPORT_MARKETS.wnba.includes('player_threes'));
  assert.ok(SPORT_MARKETS.epl.includes('btts'));
});

test('player stat extraction uses exact identity, excludes DNP and parses made threes', () => {
  const summary = { players: [{ teamId: '1', groups: [{ labels: ['PTS', '3PT'], names: ['points', 'threePointFieldGoalsMade-threePointFieldGoalsAttempted'], athletes: [{ id: '4', name: 'A Player', stats: ['24', '3-8'] }] }] }] };
  assert.equal(readPlayerStat(summary, 'A Player', 'player_points').value, 24);
  assert.equal(readPlayerStat(summary, 'A Player', 'player_threes').value, 3);
  assert.equal(readPlayerStat(summary, 'Other Player', 'player_points'), null);
  summary.players[0].groups[0].athletes[0].didNotPlay = true;
  assert.equal(readPlayerStat(summary, 'A Player', 'player_points'), null);
});

test('spreads, half spreads, team totals, BTTS and missing values are distinct', () => {
  assert.equal(gameMarketValue(game, { market: 'spreads' }, '1'), 4);
  assert.equal(gameMarketValue(game, { market: 'spreads_h1' }, '1'), 3);
  assert.equal(gameMarketValue(game, { market: 'team_totals' }, '2'), 86);
  assert.equal(gradeValue(4, { market: 'spreads', line: -4 }), 'push');
  assert.equal(gradeValue(4, { market: 'spreads', line: -4.5 }), 'lost');
  assert.equal(gradeValue(1, { market: 'btts', direction: 'Yes' }), 'won');
  assert.equal(gradeValue(null, quote), null);
});

test('ledger conserves bankroll and calculates win rate/ROI without active or void bets', () => {
  const signal = { game, quote, label: 'A Player over 20 points', analysis: analyzeMarket(observations, quote) };
  const slip = createSlip(signal, 10, 2.5, 10000, 'demo');
  assert.equal(slip.model.ev, (signal.analysis.probability * 2.5 + signal.analysis.pushProbability - 1) * 100);
  assert.notEqual(slip.model.ev, signal.analysis.ev);
  assert.deepEqual(slip.model.provenance, signal.analysis.provenance);
  assert.notEqual(slip.model.provenance, signal.analysis.provenance);
  assert.equal(betMetrics([slip], 10000).availableCents, 9000);
  const won = settleSlip(slip, 'won');
  assert.equal(betMetrics([won], 10000).profitCents, 1500);
  assert.equal(betMetrics([won], 10000).roi, 1.5);
  assert.equal(betMetrics([won], 10000).winRate, 1);
  assert.equal(settleSlip(won, 'won'), won);
  assert.equal(betMetrics([settleSlip(won, 'void')], 10000).availableCents, 10000);
  assert.equal(betMetrics([settleSlip(won, 'push')], 10000).winRate, null);
  assert.equal(betMetrics([settleSlip(won, 'active')], 10000).availableCents, 9000);
  assert.throws(() => createSlip(signal, -1, 2, 10000, 'live'));
  assert.throws(() => createSlip(signal, 101, 2, 10000, 'live'));
  assert.throws(() => createSlip(signal, 10, 1, 10000, 'live'));
  assert.equal(slip.model.provenance.sources.length, 10);
});

test('result suggestions require a final matching event and never guess absent stats', () => {
  const slip = { eventId: '1', sport: 'wnba', game, quote: { market: 'spreads', side: 'home', line: -3.5 } };
  assert.equal(suggestedResult(slip, { game }), null);
  assert.equal(suggestedResult(slip, { game: { ...game, completed: true } }).status, 'won');
  assert.equal(suggestedResult({ ...slip, quote }, { game: { ...game, completed: true }, players: [] }), null);
});