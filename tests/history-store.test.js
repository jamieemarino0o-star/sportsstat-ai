import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import { createHistoryStore } from '../src/history-store.js';
import { createLedger } from '../src/ledger.js';
import { auditReport } from '../src/audit.js';
import { backtestFile } from '../src/backtest.js';
import { optimizeSport } from '../src/optimize.js';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { createOddsCache } from '../src/odds-cache.js';
import { createFeeds } from '../src/feeds.js';

test('durable odds cache survives restarts, shares the last credit and retains failed reservations', async () => {
  const database = new PGlite();
  let paidCalls = 0;
  let completionFailure = false;
  try {
    await database.exec('create role anon; create role authenticated; create role service_role bypassrls;');
    await database.exec(readFileSync(new URL('../supabase/schema.sql', import.meta.url), 'utf8'));
    await database.exec('set role service_role;');
    const client = createClient('https://fixture.supabase.co', 'fixture-server-key', {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: async (input, options) => {
        const name = new URL(input).pathname.split('/').at(-1);
        const parameters = JSON.parse(options.body);
        let response;
        if (name === 'claim_odds_request') response = await database.query('select public.claim_odds_request($1, $2, $3) as result', [parameters.cache_key, parameters.ttl_ms, parameters.max_credits]);
        else if (name === 'complete_odds_request') {
          if (completionFailure) return Response.json({ message: 'fixture-secret' }, { status: 400 });
          response = await database.query('select public.complete_odds_request($1, $2, $3, $4) as result', [parameters.cache_key, parameters.reservation, parameters.response_payload === null ? null : JSON.stringify(parameters.response_payload), parameters.remaining_credits]);
        } else assert.fail(`Unexpected RPC ${name}`);
        return Response.json(response.rows[0].result);
      } },
    });
    const freshFeeds = () => createFeeds({
      oddsKey: 'fixture-key',
      oddsCache: createOddsCache({ store: createHistoryStore({ client, env: {} }), budgetLimit: 3 }),
      fetcher: async () => { paidCalls += 1; return Response.json([{ id: 'event', bookmakers: [] }], { headers: { 'x-requests-remaining': '424' } }); },
    });
    const first = await freshFeeds().odds('nfl');
    const restored = freshFeeds();
    assert.deepEqual(await restored.odds('nfl'), first);
    assert.equal(paidCalls, 1);
    assert.equal(restored.status().odds.budget.durable, true);
    assert.equal(restored.status().odds.budget.used, 1);
    assert.equal(restored.status().odds.remaining, '424');
    await Promise.allSettled([freshFeeds().odds('nba'), freshFeeds().odds('nba')]);
    assert.equal(paidCalls, 2);
    const lastCredit = await Promise.allSettled([freshFeeds().odds('nhl'), freshFeeds().odds('mlb')]);
    assert.equal(lastCredit.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(lastCredit.find((result) => result.status === 'rejected').reason.code, 'ODDS_UNAVAILABLE');
    assert.equal(paidCalls, 3);
    await database.exec("update odds_cache set fetched_at = now() - interval '13 hours' where key = 'odds:nfl';");
    await assert.rejects(freshFeeds().odds('nfl'), /budget is exhausted/);
    assert.equal(paidCalls, 3);
    await database.exec("update odds_usage set reserved_at = now() - interval '32 days';");
    await freshFeeds().odds('nfl');
    assert.equal(paidCalls, 4);
    completionFailure = true;
    await assert.rejects(freshFeeds().odds('epl'), (error) => error.code === 'ODDS_STORAGE_UNAVAILABLE' && !error.message.includes('fixture-secret'));
    completionFailure = false;
    const restarted = freshFeeds();
    await assert.rejects(restarted.odds('epl'), /already reserved/);
    assert.equal(paidCalls, 5);
    assert.equal(restarted.status().odds.budget.used, 2);
  } finally { await database.close(); }
});

function fixture() {
  const rows = new Map();
  let fail = false;
  const ranges = [];
  const client = createClient('https://fixture.supabase.co', 'fixture-server-key', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: async (input, options) => {
      if (fail) return Response.json({ message: 'fixture-secret must never leak' }, { status: 503 });
      const url = new URL(input);
      if (options.method === 'POST') {
        const row = JSON.parse(options.body);
        if (!rows.has(row.id)) rows.set(row.id, row);
        return new Response(null, { status: 201 });
      }
      const offset = Number(url.searchParams.get('offset') || 0);
      const limit = Number(url.searchParams.get('limit') || 500);
      ranges.push(offset);
      return Response.json([...rows.values()].slice(offset, offset + limit));
    } },
  });
  return { rows, ranges, storage: () => createHistoryStore({ client, env: {} }), setFailure: (value) => { fail = value; } };
}

test('cloud history survives a fresh ledger, ignores unchanged polls and idempotently imports', async () => {
  const database = fixture();
  const storage = database.storage();
  const ledger = createLedger({ persist: storage.append });
  for (let index = 1; index <= 3; index += 1) {
    await ledger.record({ sport: 'mlb', eventId: String(index), gameDate: '2026-10-02T18:00:00Z', homeProbability: 0.6, selection: 'home', selectionPrice: 2 });
    await ledger.reconcile('mlb', [{ id: String(index), completed: true, home: { score: 3 }, away: { score: 1 } }]);
  }
  const archived = storage.cachedRecords();
  for (const record of archived) await storage.append(record, { importing: true });
  assert.equal(database.rows.size, 6);
  const freshStorage = database.storage();
  const records = await freshStorage.readRecords();
  const restarted = createLedger({ records, persist: freshStorage.append });
  await restarted.record({ sport: 'mlb', eventId: '4', homeProbability: 0.6 });
  await restarted.record({ sport: 'mlb', eventId: '4', homeProbability: 0.6 });
  assert.equal(database.rows.size, 7);
  assert.equal(restarted.stats('mlb').sample, 3);
  assert.equal(records.filter((record) => record.type === 'result').length, 3);
  const restored = await freshStorage.readRecords();
  assert.equal(auditReport(restored).calendar.days[0].fraction, '3/3');
  assert.equal(backtestFile(restored).sample, 3);
  assert.equal(optimizeSport(restored, 'mlb').kellyFraction.sample, 3);
});

test('cloud reads paginate beyond the Supabase default row cap', async () => {
  const database = fixture();
  for (let index = 0; index < 1005; index += 1) database.rows.set(String(index), { payload: { type: 'prediction', sport: 'mlb', eventId: String(index) } });
  assert.equal((await database.storage().readRecords()).length, 1005);
  assert.deepEqual(database.ranges, [0, 500, 1000]);
});

test('cloud outages reject reads and writes without leaking secrets or falling back to local storage', async () => {
  const database = fixture();
  database.setFailure(true);
  const storage = database.storage();
  await assert.rejects(storage.readRecords(), (error) => error.status === 503 && !error.message.includes('fixture-secret'));
  await assert.rejects(storage.append({ type: 'prediction', sport: 'mlb', eventId: '1' }), { code: 'HISTORY_STORAGE_UNAVAILABLE' });
  assert.equal(storage.cachedRecords().length, 0);
  assert.ok(storage.status().error);
  assert.equal(createHistoryStore({ env: {} }), null);
  assert.throws(() => createHistoryStore({ env: { RENDER: 'true' } }), /Durable history is required/);
  assert.throws(() => createHistoryStore({ env: { SUPABASE_URL: 'https://fixture.supabase.co' } }), /Set both/);
});

test('Postgres schema is repeatable, denies browser roles and keeps prediction records append-only', async () => {
  const database = new PGlite();
  try {
    await database.exec('create role anon; create role authenticated; create role service_role bypassrls;');
    const schema = readFileSync(new URL('../supabase/schema.sql', import.meta.url), 'utf8');
    await database.exec(schema);
    await database.exec(schema);
    await database.exec('set role service_role;');
    const payload = JSON.stringify({ type: 'prediction', sport: 'mlb', eventId: '1' });
    await database.query('insert into prediction_records (id, payload) values ($1, $2) on conflict (id) do nothing', ['one', payload]);
    await database.query('insert into prediction_records (id, payload) values ($1, $2) on conflict (id) do nothing', ['one', payload]);
    assert.equal((await database.query('select * from prediction_records')).rows.length, 1);
    await assert.rejects(database.query('delete from prediction_records'), /permission denied/);
    await assert.rejects(database.query('update prediction_records set payload = $1', [payload]), /permission denied/);
    await assert.rejects(database.query('insert into prediction_records (id, payload) values ($1, $2)', ['invalid', '{}']), /check constraint/);
    await database.query('insert into notification_state values ($1, $2)', ['telegram', JSON.stringify({ pending: [], sent: [] })]);
    await database.query('update notification_state set payload = $1', [JSON.stringify({ pending: [], sent: ['bet:mlb:1'] })]);
    const claim = async (key, limit = 2) => (await database.query('select public.claim_odds_request($1, $2, $3) as result', [key, 43200000, limit])).rows[0].result;
    const first = await claim('odds:nfl');
    assert.equal(first.state, 'reserved');
    assert.equal(first.budget.used, 1);
    assert.equal((await claim('odds:nfl')).state, 'waiting');
    const oddsPayload = JSON.stringify([{ id: 'event', bookmakers: [] }]);
    await database.query('select public.complete_odds_request($1, $2, $3, $4)', ['odds:nfl', first.reservationId, oddsPayload, 424]);
    const cached = await claim('odds:nfl');
    assert.equal(cached.state, 'cached');
    assert.equal(cached.budget.used, 1);
    assert.equal(cached.providerRemaining, 424);
    assert.deepEqual(cached.data, JSON.parse(oddsPayload));
    const second = await claim('odds:nba');
    assert.equal(second.state, 'reserved');
    assert.equal((await claim('odds:mlb')).state, 'budget');
    assert.equal((await claim('odds:nfl')).state, 'cached');
    await database.query('select public.complete_odds_request($1, $2, $3)', ['odds:nba', second.reservationId, null]);
    assert.equal((await claim('odds:nba')).state, 'waiting');
    await assert.rejects(database.query('select public.complete_odds_request($1, $2, $3)', ['odds:nfl', first.reservationId, '[]']), /expired or replaced/);
    await database.exec("update public.odds_usage set reserved_at = now() - interval '32 days'; update public.odds_cache set fetched_at = now() - interval '13 hours' where key = 'odds:nfl';");
    const expired = await claim('odds:nfl');
    assert.equal(expired.state, 'reserved');
    assert.equal(expired.budget.used, 1);
    assert.equal((await claim('odds:nhl', 0)).state, 'budget');
    for (const role of ['anon', 'authenticated']) {
      await database.exec(`reset role; set role ${role};`);
      await assert.rejects(database.query('select * from prediction_records'), /permission denied/);
      await assert.rejects(database.query('insert into prediction_records (id, payload) values ($1, $2)', ['blocked', payload]), /permission denied/);
      await assert.rejects(database.query('select * from notification_state'), /permission denied/);
      await assert.rejects(database.query('select * from odds_cache'), /permission denied/);
      await assert.rejects(database.query('select * from odds_usage'), /permission denied/);
      await assert.rejects(database.query("select public.claim_odds_request('odds:nfl', 43200000, 400)"), /permission denied/);
      await assert.rejects(database.query('select public.odds_budget_status(400)'), /permission denied/);
    }
  } finally { await database.close(); }
});