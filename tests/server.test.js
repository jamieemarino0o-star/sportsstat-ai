import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.js';
import { createFeeds } from '../src/feeds.js';
import { createLedger } from '../src/ledger.js';
import { createOddsCache } from '../src/odds-cache.js';

test('odds polling coalesces calls and enforces a shared budget without blocking ESPN', async () => {
  let paidCalls = 0;
  const feeds = createFeeds({ oddsKey: 'fixture-key', oddsCache: createOddsCache({ budgetLimit: 1 }), fetcher: async (url) => {
    if (url.includes('the-odds-api')) paidCalls += 1;
    return Response.json(url.includes('the-odds-api') ? [{ id: 'odds-event' }] : { events: [] });
  } });
  const [first, duplicate] = await Promise.all([feeds.odds('nfl'), feeds.odds('nfl')]);
  assert.deepEqual(duplicate, first);
  assert.equal(paidCalls, 1);
  assert.equal(feeds.status().odds.budget.used, 1);
  assert.equal(feeds.status().odds.budget.intervalMs, 43200000);
  await assert.rejects(feeds.odds('nba'), { code: 'ODDS_UNAVAILABLE' });
  assert.deepEqual(await feeds.odds('nfl'), first);
  assert.deepEqual((await feeds.scoreboard('nfl')).games, []);
  assert.equal(paidCalls, 1);
});

test('odds fail closed on storage outages and retain reservations for failed calls', async (context) => {
  let calls = 0;
  const brokenStore = { claimOdds: async () => { throw Object.assign(new Error('Odds cache unavailable'), { code: 'ODDS_STORAGE_UNAVAILABLE' }); } };
  const feeds = createFeeds({ oddsKey: 'fixture-key', oddsCache: createOddsCache({ store: brokenStore }), fetcher: async () => { calls += 1; return Response.json([]); } });
  const server = createApp(feeds).listen(0, '127.0.0.1');
  context.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.once('listening', resolve));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/odds?sport=nfl`);
  assert.equal(response.status, 503);
  assert.equal(calls, 0);
  const failed = createFeeds({ oddsKey: 'fixture-key', oddsCache: createOddsCache({ budgetLimit: 1 }), fetcher: async () => { calls += 1; throw new Error('fixture-secret'); } });
  await assert.rejects(failed.odds('nfl'), /Upstream feed is unavailable/);
  await assert.rejects(failed.odds('nfl'), /temporarily paused/);
  await assert.rejects(failed.odds('nba'), /budget is exhausted/);
  assert.equal(calls, 1);
});

test('odds cache refreshes after twelve hours and releases budget after 31 days', async () => {
  let time = Date.parse('2026-10-01T00:00:00Z');
  let calls = 0;
  const cache = createOddsCache({ now: () => time, budgetLimit: 2 });
  const load = async () => { calls += 1; return { data: [], time, remaining: 425 - calls }; };
  await cache.get('odds:nfl', load);
  time += 12 * 60 * 60 * 1000 - 1;
  await cache.get('odds:nfl', load);
  assert.equal(calls, 1);
  time += 1;
  await cache.get('odds:nfl', load);
  assert.equal(calls, 2);
  time += 12 * 60 * 60 * 1000;
  await assert.rejects(cache.get('odds:nfl', load), /budget is exhausted/);
  time = Date.parse('2026-11-01T00:00:00Z');
  await cache.get('odds:nfl', load);
  assert.equal(calls, 3);
  assert.equal(cache.status().used, 2);
  assert.throws(() => createOddsCache({ budgetLimit: 401 }), /ODDS_CREDIT_LIMIT/);
  assert.throws(() => createOddsCache({ ttlMs: 0 }), /ODDS_POLL_INTERVAL_MS/);
});

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
  assert.equal((await (await fetch(`${base}/api/audit?tz=America%2FNew_York`)).json()).calendar.timeZone, 'America/New_York');
  assert.equal((await (await fetch(`${base}/api/audit?tz=bogus%2Fzone`)).json()).calendar.timeZone, 'UTC');
  const response = await fetch(`${base}/api/scoreboard?sport=nfl`);
  assert.deepEqual(await response.json(), { games: [] });
  const injuryResponse = await fetch(`${base}/api/injuries?sport=nfl`);
  assert.deepEqual(await injuryResponse.json(), { teams: [] });
  assert.equal(response.headers.get('x-powered-by'), null);
  assert.ok(response.headers.get('content-security-policy'));
});

test('cloud audit and raw export use durable records; storage outages are explicit 503 errors', async (context) => {
  let fail = false;
  const records = [
    { type: 'prediction', sport: 'mlb', eventId: 'cloud', selection: 'home', selectionPrice: 2, homeProbability: 0.6, gameDate: '2026-10-02T18:00:00Z', loggedAt: '2026-10-02T12:00:00Z' },
    { type: 'result', sport: 'mlb', eventId: 'cloud', resolved: true, outcome: 1, homeScore: 3, awayScore: 1, brier: 0.16, resolvedAt: '2026-10-02T22:00:00Z' },
  ];
  const historyStore = { status: () => ({ backend: 'supabase', durable: true }), readRecords: async () => {
    if (fail) throw Object.assign(new Error('History storage unavailable'), { code: 'HISTORY_STORAGE_UNAVAILABLE' });
    return records;
  } };
  const server = createApp({}, { historyStore }).listen(0, '127.0.0.1');
  context.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const report = await (await fetch(`${base}/api/audit`)).json();
  assert.equal(report.sample, 1);
  assert.equal(report.calendar.days[0].fraction, '1/1');
  assert.equal(report.storage.backend, 'supabase');
  const exported = await fetch(`${base}/api/ledger/export`);
  assert.equal(exported.headers.get('cache-control'), 'no-store');
  assert.deepEqual((await exported.text()).trim().split('\n').map(JSON.parse), records);
  fail = true;
  const response = await fetch(`${base}/api/audit`);
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /storage unavailable/);
});

test('scheduled work requires its secret, reports trigger status and rejects browser prediction writes', async (context) => {
  let runs = 0;
  const token = 'fixture-background-token-at-least-32-characters';
  const backgroundJobs = { run: async () => { runs += 1; }, status: () => ({ enabled: true, sports: ['nfl'] }) };
  const server = createApp({}, { backgroundJobs, jobToken: token }).listen(0, '127.0.0.1');
  context.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/api/jobs/scan`, { method: 'POST' })).status, 401);
  assert.equal((await fetch(`${base}/api/jobs/scan`, { method: 'POST', headers: { Authorization: 'Bearer incorrect' } })).status, 401);
  assert.equal(runs, 0);
  const before = await (await fetch(`${base}/api/jobs/status`)).json();
  assert.equal(before.lastExternalTriggerAt, null);
  assert.equal(before.externalTriggerEnabled, true);
  assert.equal((await fetch(`${base}/api/jobs/scan`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } })).status, 202);
  const response = await fetch(`${base}/api/jobs/status`);
  const after = await response.json();
  assert.ok(after.lastExternalTriggerAt);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(runs, 1);
  assert.doesNotMatch(JSON.stringify(after), /fixture-background-token/);
  assert.equal((await fetch(`${base}/api/predictions?sport=nfl`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ eventId: '1', homeProbability: 0.6 }) })).status, 409);
  assert.throws(() => createApp({}, { jobToken: 'short' }), /at least 32/);
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
  assert.equal(feeds.status().odds.budget.used, 2);
  assert.equal(requested.filter((url) => new URL(url).hostname === 'api.the-odds-api.com').length, 2);
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
test('hardening: in-play writes are rejected and overdue predictions are settled from the event summary', async () => {
  const competitors = (home, away) => [
    { homeAway: 'home', team: { id: '17', displayName: 'Kansas City Chiefs' }, score: String(home) },
    { homeAway: 'away', team: { id: '9', displayName: 'Buffalo Bills' }, score: String(away) },
  ];
  const live = { id: '600', date: new Date().toISOString(), competitions: [{ competitors: competitors(7, 3) }], status: { type: { state: 'in' } } };
  const ledger = createLedger();
  const fetched = [];
  const fetcher = async (url) => {
    fetched.push(url);
    if (url.includes('summary?event=42')) return Response.json({ header: { competitions: [{ date: '2026-09-01T17:00:00Z', competitors: competitors(10, 24), status: { type: { state: 'post', completed: true } } }] } });
    return Response.json({ events: [live] });
  };
  const feeds = createFeeds({ fetcher, ledger });
  ledger.record({ sport: 'nfl', eventId: '42', homeTeam: 'Kansas City Chiefs', awayTeam: 'Buffalo Bills', gameDate: '2026-09-01T17:00:00Z', homeProbability: 0.7, selection: 'home' });
  assert.equal((await feeds.recordPrediction('nfl', { eventId: '600', homeProbability: 0.6 })).recorded, false); // in play
  await new Promise((resolve) => setTimeout(resolve, 20));
  const summaryFetches = () => fetched.filter((url) => url.includes('summary?event=42')).length;
  await feeds.scoreboard('nfl');
  assert.equal(summaryFetches(), 1, 'sweeps are throttled per sport');
  assert.ok(fetched.some((url) => url.includes('summary?event=42')));
  const stats = ledger.stats('nfl');
  assert.equal(stats.sample, 1);
  assert.equal(stats.pending, 0);
});

test('hardening: malformed or oversized JSON gets a 4xx, not a 502', async () => {
  const server = createApp(createFeeds({ fetcher: async () => Response.json({ events: [] }) })).listen(0);
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/predictions?sport=nfl`;
    const malformed = await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"eventId":' });
    assert.equal(malformed.status, 400);
    assert.deepEqual(await malformed.json(), { error: 'Malformed request.' });
    const large = await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pad: 'x'.repeat(8000) }) });
    assert.equal(large.status, 413);
    assert.equal((await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '[1,2]' })).status, 400);
    assert.equal((await fetch(base.replace('predictions?sport=nfl', 'audit'))).headers.get('cache-control'), 'no-store');
  } finally { server.close(); }
});
