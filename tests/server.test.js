import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.js';
import { createFeeds } from '../src/feeds.js';

test('proxy validates parameters and hides its implementation header', async (context) => {
  const app = createApp({ status: () => ({ espn: { state: 'idle' } }), scoreboard: async () => ({ games: [] }), injuries: async () => ({ teams: [] }) });
  const server = app.listen(0, '127.0.0.1');
  context.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/api/scoreboard?sport=bad`)).status, 400);
  assert.equal((await fetch(`${base}/api/injuries?sport=bad`)).status, 400);
  assert.equal((await fetch(`${base}/api/summary?sport=nfl&event=../../secret`)).status, 400);
  assert.equal((await fetch(`${base}/api/history?sport=nfl&team=1&season=no`)).status, 400);
  assert.equal((await fetch(`${base}/api/markets?sport=wnba&event=1&market=player_pass_yds`)).status, 400);
  assert.equal((await fetch(`${base}/api/markets?sport=wnba&event=1&market=player_points&window=100`)).status, 400);
  assert.equal((await fetch(`${base}/api/odds/history?sport=nfl`)).status, 400);
  assert.equal((await fetch(`${base}/api/predictions?sport=nfl`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ eventId: 'abc', homeProbability: 2 }) })).status, 400);
  assert.equal((await fetch(`${base}/api/predictions/stats?sport=bad`)).status, 400);
  // /api/optimized-params never requires a sport query param (it can report every sport at once),
  // and reads best-effort from disk: with no generated file yet it degrades to an empty payload.
  const optimizedParams = await (await fetch(`${base}/api/optimized-params`)).json();
  assert.deepEqual(optimizedParams, { generatedAt: null, sports: {} });
  const filtered = await (await fetch(`${base}/api/optimized-params?sport=nfl`)).json();
  assert.deepEqual(filtered, { generatedAt: null, sport: null });
  // /api/audit reads the real, append-only ledger file straight off disk (like /api/optimized-params
  // above), so its exact numbers vary with live data -- only the response shape is asserted here.
  const audit = await (await fetch(`${base}/api/audit`)).json();
  assert.equal(typeof audit.sample, 'number');
  assert.ok(Array.isArray(audit.insights) && audit.insights.length > 0);
  assert.ok(Array.isArray(audit.history));
  assert.ok(Array.isArray(audit.byRiskTier) && Array.isArray(audit.byOddsBracket) && Array.isArray(audit.bySport));
  assert.equal(audit.sport, null);
  const auditFiltered = await (await fetch(`${base}/api/audit?sport=nfl`)).json();
  assert.equal(auditFiltered.sport, 'nfl');
  assert.equal((await fetch(`${base}/api/audit?sport=bad`)).status, 200); // an invalid sport is silently ignored, not rejected, since this route spans every sport by default
  const response = await fetch(`${base}/api/scoreboard?sport=nfl`);
  assert.deepEqual(await response.json(), { games: [] });
  const injuryResponse = await fetch(`${base}/api/injuries?sport=nfl`);
  assert.deepEqual(await injuryResponse.json(), { teams: [] });
  assert.equal(response.headers.get('x-powered-by'), null);
  assert.ok(response.headers.get('content-security-policy'));
});

test('injury reports normalize team/player details and cache the league endpoint', async () => {
  const urls = [];
  const feeds = createFeeds({ fetcher: async (url) => {
    urls.push(url);
    return Response.json({ injuries: [
      { id: 12, displayName: 'Kansas City Chiefs', injuries: [
        { id: 44, athlete: { id: 900, displayName: 'Player One' }, status: 'Questionable', date: '2026-09-27T12:00Z', shortComment: 'Limited practice.' },
        { athlete: { id: 900, displayName: 'Player Two' }, status: 'Out', longComment: 'Long report.' },
        { id: 45, status: 'Out' },
      ] },
      { id: 33, displayName: 'Baltimore Ravens', injuries: [] },
    ] });
  } });
  const [first, second] = await Promise.all([feeds.injuries('nfl'), feeds.injuries('nfl')]);
  assert.deepEqual(second, first);
  assert.equal(urls.length, 1);
  assert.ok(urls[0].endsWith('/football/nfl/injuries'));
  assert.deepEqual(first.teams, [
    { teamId: '12', team: 'Kansas City Chiefs', injuries: [
      { id: '44', athlete: 'Player One', status: 'Questionable', date: '2026-09-27T12:00Z', comment: 'Limited practice.' },
      { id: '900', athlete: 'Player Two', status: 'Out', date: null, comment: 'Long report.' },
    ] },
    { teamId: '33', team: 'Baltimore Ravens', injuries: [] },
  ]);
  assert.equal(first.source.url, 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/injuries');
  assert.ok(first.fetchedAt);
});

test('unconfigured odds never return fabricated prices', async () => {
  const feeds = createFeeds({ oddsKey: '', fetcher: () => assert.fail('Should not fetch') });
  assert.deepEqual(await feeds.odds('nfl'), { configured: false, events: [], fetchedAt: null });
  assert.deepEqual((await feeds.markets('wnba', '1', 'player_threes')).signals, []);
  assert.deepEqual(await feeds.lineHistory('nfl', '1'), { configured: false, eventId: null, snapshots: [] });
});

test('line movement history snapshots best moneyline prices per book and does not duplicate cached fetches', async () => {
  const date = new Date(Date.now() + 86400000).toISOString();
  const competitors = [
    { homeAway: 'home', team: { id: '17', displayName: 'Kansas City Chiefs' }, score: '0' },
    { homeAway: 'away', team: { id: '9', displayName: 'Buffalo Bills' }, score: '0' },
  ];
  const game = { id: '700', date, competitions: [{ competitors }], status: { type: { state: 'pre' } } };
  const oddsEvent = { id: 'odds-event-1', sport_key: 'americanfootball_nfl', home_team: 'Kansas City Chiefs', away_team: 'Buffalo Bills', commence_time: date,
    bookmakers: [
      { key: 'draftkings', title: 'DraftKings', markets: [{ key: 'h2h', outcomes: [{ name: 'Kansas City Chiefs', price: 1.9 }, { name: 'Buffalo Bills', price: 2.05 }] }] },
      { key: 'fanduel', title: 'FanDuel', markets: [{ key: 'h2h', outcomes: [{ name: 'Kansas City Chiefs', price: 1.95 }, { name: 'Buffalo Bills', price: 2.0 }] }] },
    ] };
  const feeds = createFeeds({ oddsKey: 'fixture-secret', fetcher: async (url) => {
    const parsed = new URL(url);
    if (parsed.hostname === 'api.the-odds-api.com') return Response.json([oddsEvent]);
    if (parsed.pathname.endsWith('/scoreboard')) return Response.json({ events: [game], leagues: [{ season: { year: 2026 } }] });
    assert.fail(`Unexpected fixture URL: ${parsed.pathname}`);
  } });
  const first = await feeds.lineHistory('nfl', '700');
  assert.equal(first.configured, true);
  assert.equal(first.eventId, 'odds-event-1');
  assert.equal(first.snapshots.length, 1);
  assert.equal(first.snapshots[0].home, 1.95);
  assert.equal(first.snapshots[0].away, 2.05);
  assert.deepEqual(first.snapshots[0].books.draftkings, { home: 1.9, away: 2.05 });
  const second = await feeds.lineHistory('nfl', '700');
  assert.equal(second.snapshots.length, 1);
  assert.equal((await feeds.lineHistory('nfl', 'unknown-event')).eventId, null);
});

test('prediction ledger only accepts predictions for events currently on the scoreboard and reports pending/reconciled stats', async () => {
  const competitors = [
    { homeAway: 'home', team: { id: '17', displayName: 'Kansas City Chiefs' }, score: '0' },
    { homeAway: 'away', team: { id: '9', displayName: 'Buffalo Bills' }, score: '0' },
  ];
  const game = { id: '500', date: new Date().toISOString(), competitions: [{ competitors }], status: { type: { state: 'pre' } } };
  const feeds = createFeeds({ fetcher: async () => Response.json({ events: [game], leagues: [{ season: { year: 2026 } }] }) });
  const rejected = await feeds.recordPrediction('nfl', { eventId: '999', homeProbability: 0.5 });
  assert.equal(rejected.recorded, false);
  const accepted = await feeds.recordPrediction('nfl', { eventId: '500', homeProbability: 0.62, selection: 'home', window: 10, sample: 12 });
  assert.equal(accepted.recorded, true);
  assert.equal(accepted.entry.homeTeam, 'Kansas City Chiefs');
  assert.equal(accepted.entry.awayTeam, 'Buffalo Bills');
  assert.equal(accepted.entry.resolved, false);
  const stats = await feeds.predictionStats('nfl');
  assert.equal(stats.pending, 1);
  assert.equal(stats.sample, 0);
  assert.equal(stats.biasFactor, 0);
});

test('scoreboard fetches automatically reconcile pending predictions once ESPN reports a game complete', async () => {
  const calls = [];
  const stubLedger = { record: () => null, reconcile: (sport, games) => { calls.push({ sport, games }); return []; }, stats: () => ({}) };
  const game = { id: '501', date: new Date().toISOString(), competitions: [{ competitors: [
    { homeAway: 'home', team: { id: '1', displayName: 'Home' }, score: '20' },
    { homeAway: 'away', team: { id: '2', displayName: 'Away' }, score: '17' },
  ] }], status: { type: { state: 'post', completed: true } } };
  const feeds = createFeeds({ ledger: stubLedger, fetcher: async () => Response.json({ events: [game], leagues: [{ season: { year: 2026 } }] }) });
  await feeds.scoreboard('nfl');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sport, 'nfl');
  assert.equal(calls[0].games[0].id, '501');
  assert.equal(calls[0].games[0].completed, true);
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