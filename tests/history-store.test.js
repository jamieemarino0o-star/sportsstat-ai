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
    for (const role of ['anon', 'authenticated']) {
      await database.exec(`reset role; set role ${role};`);
      await assert.rejects(database.query('select * from prediction_records'), /permission denied/);
      await assert.rejects(database.query('insert into prediction_records (id, payload) values ($1, $2)', ['blocked', payload]), /permission denied/);
      await assert.rejects(database.query('select * from notification_state'), /permission denied/);
    }
  } finally { await database.close(); }
});