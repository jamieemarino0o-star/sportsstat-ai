import test from 'node:test';
import assert from 'node:assert/strict';
import { createPredictionScanner } from '../src/prediction-scanner.js';
import { createLedger } from '../src/ledger.js';
import { predictionSettings } from '../public/js/model.js';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

function fixture() {
  const now = Date.now();
  const game = { id: '1', sport: 'nfl', date: new Date(now + 3600000).toISOString(), state: 'pre', completed: false, home: { id: 'home', name: 'Home' }, away: { id: 'away', name: 'Away' } };
  const events = Array.from({ length: 10 }, (_, index) => ({ ...game, id: `past-${index}`, date: new Date(now - (index + 1) * 86400000).toISOString(), completed: true, home: { ...game.home, score: 24 }, away: { ...game.away, score: 14 } }));
  const announced = [];
  const records = [];
  const ledger = createLedger({ persist: async (record) => { records.push(record); }, notifier: { notifyNewBet: (entry) => { announced.push(entry); } } });
  let boards = 0;
  const feeds = {
    scoreboard: async () => { boards += 1; return { season: new Date(now).getUTCFullYear(), games: [game, { ...game, id: 'live', state: 'in' }, { ...game, id: 'late', date: new Date(now - 1).toISOString() }] }; },
    history: async () => ({ events, partial: false }),
    odds: async () => ({ configured: true, events: [{ home_team: 'Home', away_team: 'Away', commence_time: game.date, bookmakers: [{ key: 'draftkings', title: 'DraftKings', markets: [{ key: 'h2h', outcomes: [{ name: 'Home', price: 2 }, { name: 'Away', price: 2 }] }] }] }] }),
    predictionStats: (sport) => ledger.stats(sport),
    recordPrediction: async (sport, entry) => ({ recorded: true, entry: await ledger.record({ ...entry, sport, gameDate: game.date }) }),
  };
  return { feeds, records, announced, boards: () => boards, now };
}

test('background scan persists and announces a priced pick without a browser, coalesces overlap and throttles refresh', async () => {
  const data = fixture();
  let now = data.now;
  const scanner = createPredictionScanner({ feeds: data.feeds, now: () => now, logger: {} });
  await Promise.all([scanner.run(), scanner.run()]);
  assert.equal(data.boards(), 1);
  assert.equal(data.records.length, 1);
  assert.equal(data.announced.length, 1);
  assert.equal(data.records[0].selectionPrice, 2);
  assert.equal(scanner.status().recorded, 1);
  assert.equal(scanner.status().running, false);
  await scanner.run();
  assert.equal(data.boards(), 1);
  now += 600001;
  await scanner.run();
  assert.equal(data.boards(), 2);
  assert.equal(data.announced.length, 1);
});

test('background scan skips missing prices and incomplete history without fabricating bets', async () => {
  const data = fixture();
  data.feeds.odds = async () => ({ configured: false, events: [] });
  const scanner = createPredictionScanner({ feeds: data.feeds, logger: {} });
  await scanner.run();
  assert.equal(data.records.length, 0);
  assert.match(scanner.status().errors[0], /odds/);
  const partial = fixture();
  partial.feeds.history = async () => ({ events: [], partial: true });
  await createPredictionScanner({ feeds: partial.feeds, logger: {} }).run();
  assert.equal(partial.records.length, 0);
});

test('background scan isolates failures and does not expose provider secrets', async () => {
  const data = fixture();
  const scoreboard = data.feeds.scoreboard;
  data.feeds.scoreboard = async (sport) => {
    if (sport === 'nba') throw new Error('private-token');
    return scoreboard();
  };
  const scanner = createPredictionScanner({ feeds: data.feeds, sports: ['nba', 'nfl'], logger: {} });
  await scanner.run();
  assert.equal(data.records.length, 1);
  assert.match(scanner.status().errors[0], /nba/);
  assert.doesNotMatch(JSON.stringify(scanner.status()), /private-token/);
  assert.throws(() => createPredictionScanner({ feeds: data.feeds, sports: ['epl'] }), /supported moneyline sports/);
});

test('shared parameter selection preserves calibrated values and stable per-game exploration', () => {
  assert.deepEqual(predictionSettings('1'), { biasFactor: 0, decay: 0.85, sosWeight: 0.375 });
  assert.deepEqual(predictionSettings('1', { biasFactor: 0.02, bestDecay: 1, bestSosWeight: 0.125 }), { biasFactor: 0.02, decay: 1, sosWeight: 0.125 });
});

test('Cron SQL validates Vault setup and builds an authenticated request without embedding secrets in the job', async () => {
  const database = new PGlite();
  try {
    await database.exec(`
      create schema vault; create schema cron; create schema net;
      create table vault.decrypted_secrets (name text primary key, decrypted_secret text);
      create table cron.jobs (name text primary key, schedule text, command text);
      create table net.requests (url text, headers jsonb, body jsonb, timeout_ms integer);
      create function cron.schedule(job_name text, job_schedule text, job_command text) returns bigint language plpgsql as $$
      begin
        insert into cron.jobs values (job_name, job_schedule, job_command)
          on conflict (name) do update set schedule = excluded.schedule, command = excluded.command;
        return 1;
      end; $$;
      create function net.http_post(url text, headers jsonb, body jsonb, timeout_milliseconds integer) returns bigint language plpgsql as $$
      begin
        insert into net.requests values (url, headers, body, timeout_milliseconds);
        return 1;
      end; $$;
    `);
    const source = readFileSync(new URL('../supabase/background-jobs.sql', import.meta.url), 'utf8');
    const script = source.slice(source.indexOf('do $validation$'));
    await assert.rejects(database.exec(script), /Create sportsstat_app_url/);
    const token = 'fixture-job-secret-at-least-32-characters';
    await database.query('insert into vault.decrypted_secrets values ($1, $2), ($3, $4)', ['sportsstat_app_url', 'https://example.test/', 'sportsstat_job_token', token]);
    await database.exec(script);
    await database.exec(script);
    const jobs = (await database.query('select * from cron.jobs')).rows;
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].schedule, '*/10 * * * *');
    assert.ok(!jobs[0].command.includes(token));
    await database.exec(jobs[0].command);
    const request = (await database.query('select * from net.requests')).rows[0];
    assert.equal(request.url, 'https://example.test/api/jobs/scan');
    assert.equal(request.headers.Authorization, `Bearer ${token}`);
    assert.equal(request.timeout_ms, 90000);
  } finally { await database.close(); }
});