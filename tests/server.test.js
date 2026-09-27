import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.js';
import { createFeeds } from '../src/feeds.js';

test('proxy validates parameters and hides its implementation header', async (context) => {
  const app = createApp({ status: () => ({ espn: { state: 'idle' } }), scoreboard: async () => ({ games: [] }) });
  const server = app.listen(0, '127.0.0.1');
  context.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/api/scoreboard?sport=bad`)).status, 400);
  assert.equal((await fetch(`${base}/api/summary?sport=nfl&event=../../secret`)).status, 400);
  assert.equal((await fetch(`${base}/api/history?sport=nfl&team=1&season=no`)).status, 400);
  assert.equal((await fetch(`${base}/api/markets?sport=wnba&event=1&market=player_pass_yds`)).status, 400);
  assert.equal((await fetch(`${base}/api/markets?sport=wnba&event=1&market=player_points&window=100`)).status, 400);
  const response = await fetch(`${base}/api/scoreboard?sport=nfl`);
  assert.deepEqual(await response.json(), { games: [] });
  assert.equal(response.headers.get('x-powered-by'), null);
  assert.ok(response.headers.get('content-security-policy'));
});

test('unconfigured odds never return fabricated prices', async () => {
  const feeds = createFeeds({ oddsKey: '', fetcher: () => assert.fail('Should not fetch') });
  assert.deepEqual(await feeds.odds('nfl'), { configured: false, events: [], fetchedAt: null });
  assert.deepEqual((await feeds.markets('wnba', '1', 'player_threes')).signals, []);
});

test('WNBA/EPL feeds retain historical endpoint timestamps and normalized player identities', async () => {
  const urls = [];
  const feeds = createFeeds({ fetcher: async (url) => {
    urls.push(url);
    return new Response(JSON.stringify({ events: [], boxscore: { players: [{ team: { id: '8', displayName: 'Minnesota Lynx' }, statistics: [{ labels: ['PTS'], keys: ['points'], athletes: [{ athlete: { id: '1', displayName: 'A Player' }, stats: ['24'] }] }] }] } }));
  } });
  const history = await feeds.history('wnba', '8', 2026);
  assert.ok(history.sources.every((source) => source.url.includes('basketball/wnba/teams/8/schedule?season=')));
  const summary = await feeds.summary('wnba', '1');
  assert.equal(summary.players[0].groups[0].athletes[0].id, '1');
  assert.deepEqual(summary.players[0].groups[0].keys, ['points']);
  await feeds.scoreboard('epl');
  assert.ok(urls.some((url) => url.includes('soccer/eng.1/scoreboard')));
});

test('summary half scores accept ESPN display values without treating missing quarters as zero', async () => {
  const competitors = [
    { homeAway: 'home', team: { id: '8' }, linescores: [{ displayValue: '32' }, { displayValue: '30' }] },
    { homeAway: 'away', team: { id: '5' }, linescores: [{ value: 13 }, { value: 19 }] },
  ];
  const feeds = createFeeds({ fetcher: async () => new Response(JSON.stringify({ header: { competitions: [{ competitors }] } })) });
  const summary = await feeds.summary('wnba', '1');
  assert.equal(summary.game.home.firstHalfScore, 62);
  assert.equal(summary.game.away.firstHalfScore, 32);
  competitors[0].linescores[1] = { displayValue: '' };
  competitors[1].linescores[1] = {};
  const missing = await feeds.summary('wnba', '2');
  assert.equal(missing.game.home.firstHalfScore, null);
  assert.equal(missing.game.away.firstHalfScore, null);
});

test('advanced WNBA endpoint joins exact props to unique historical games and source records', async (context) => {
  const date = new Date(Date.now() + 86400000).toISOString();
  const competitors = [
    { homeAway: 'home', team: { id: '17', displayName: 'Las Vegas Aces' }, score: '90' },
    { homeAway: 'away', team: { id: '9', displayName: 'New York Liberty' }, score: '80' },
  ];
  const game = { id: '500', date, competitions: [{ competitors }], status: { type: { state: 'pre' } } };
  const history = Array.from({ length: 20 }, (_, index) => ({ ...game, id: String(1000 + index), date: new Date(Date.now() - (index + 1) * 86400000).toISOString(), status: { type: { completed: true, state: 'post' } } }));
  const oddsEvent = { id: 'odds-event', sport_key: 'basketball_wnba', home_team: 'Las Vegas Aces', away_team: 'New York Liberty', commence_time: date,
    bookmakers: [{ key: 'draftkings', title: 'DraftKings', markets: [{ key: 'player_threes', outcomes: [{ name: 'Over', description: 'A Player', point: 2.5, price: 2 }] }] }] };
  const requested = [];
  const feeds = createFeeds({ oddsKey: 'fixture-secret', fetcher: async (url) => {
    requested.push(url);
    const parsed = new URL(url);
    if (parsed.hostname === 'api.the-odds-api.com') return Response.json(parsed.pathname.includes('/events/') ? oddsEvent : [oddsEvent]);
    if (parsed.pathname.endsWith('/scoreboard')) return Response.json({ events: [game], leagues: [{ season: { year: 2026 } }] });
    if (parsed.pathname.endsWith('/schedule')) return Response.json({ events: [game, ...history] });
    if (parsed.pathname.endsWith('/summary')) return Response.json({ boxscore: { players: [{ team: { id: '17' }, statistics: [{ labels: ['3PT'], keys: ['threePointFieldGoalsMade-threePointFieldGoalsAttempted'], athletes: [
      { athlete: { id: 'player-1', displayName: 'A Player' }, stats: ['3-8'] },
      { athlete: { id: 'player-2', displayName: 'Another Player' }, stats: ['0-5'] },
    ] }] }] } });
    assert.fail(`Unexpected fixture URL: ${parsed.pathname}`);
  } });
  const server = createApp(feeds).listen(0, '127.0.0.1');
  context.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/markets?sport=wnba&event=500&market=player_threes`;
  for (const window of [10, 20]) {
    const response = await fetch(`${base}&window=${window}`);
    assert.equal(response.status, 200);
    const result = await response.json();
    const signal = result.signals[0];
    assert.equal(result.configured, true);
    assert.equal(result.partial, false);
    assert.equal(result.inspectedGames, window);
    assert.equal(signal.quote.line, 2.5);
    assert.equal(signal.analysis.sample, window);
    assert.equal(signal.analysis.wins, window);
    assert.equal(new Set(signal.analysis.provenance.sources.map((entry) => entry.eventId)).size, window);
    assert.ok(signal.analysis.provenance.sources.every((entry) => entry.value === 3 && entry.raw === '3-8' && entry.playerId === 'player-1' && entry.source.url.endsWith(`summary?event=${entry.eventId}`)));
    assert.ok(!JSON.stringify(result).includes('fixture-secret'));
  }
  const calls = requested.length;
  await fetch(`${base}&window=20`);
  assert.equal(requested.length, calls);
});

test('NFL summaries include previous and current drive plays without duplicates', async () => {
  const previous = { id: '1', text: 'Previous drive', clock: { displayValue: '10:00' }, period: { number: 1 } };
  const latest = { id: '2', text: 'Current drive', clock: { displayValue: '09:00' }, period: { number: 1 } };
  const feeds = createFeeds({ fetcher: async () => new Response(JSON.stringify({ drives: { previous: [{ plays: [previous] }], current: { plays: [previous, latest] } } })) });
  const summary = await feeds.summary('nfl', '1');
  assert.deepEqual(summary.plays.map((play) => play.id), ['2', '1']);
  assert.equal(summary.plays[0].clock, '09:00');
});

test('feed caching coalesces requests and reports upstream errors without secrets', async () => {
  let calls = 0;
  const feeds = createFeeds({ fetcher: async () => { calls += 1; return new Response(JSON.stringify({ events: [] })); } });
  await Promise.all([feeds.scoreboard('nfl'), feeds.scoreboard('nfl')]);
  await feeds.scoreboard('nfl');
  assert.equal(calls, 1);
  assert.equal(feeds.status().espn.state, 'connected');
  const failed = createFeeds({ oddsKey: 'secret-test-key', fetcher: async () => { throw new Error('URL containing secret-test-key'); } });
  await assert.rejects(failed.odds('nfl'), /Upstream feed is unavailable/);
  assert.ok(!JSON.stringify(failed.status()).includes('secret-test-key'));
});