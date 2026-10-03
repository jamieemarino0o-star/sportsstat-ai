import test from 'node:test';
import assert from 'node:assert/strict';
import { createTelegramNotifier, sendTelegramMessage, newBetMessageFromEntry, resultMessageFromEntry, expectedValuePercent, formatNotificationTime } from '../src/notifier.js';
import { createLedger } from '../src/ledger.js';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fakeFetch = (calls, { ok = true, status = 200, body = { ok: true } } = {}) => async (url, init) => {
  calls.push({ url, body: JSON.parse(init.body) });
  return { ok, status, json: async () => body };
};

const pick = { sport: 'nfl', eventId: '1', homeTeam: 'Buffalo Bills', awayTeam: 'Los Angeles Chargers', homeProbability: 0.6, selection: 'home', selectionPrice: 1.9, gameDate: '2026-10-02T00:15:00Z', updatedAt: '2026-10-01T14:00:00Z', resolvedAt: '2026-10-02T03:30:00Z' };

test('message formats match the required templates', () => {
  assert.equal(newBetMessageFromEntry(pick), '🚀 New Bet Detected!\nMatch: Los Angeles Chargers @ Buffalo Bills\nGame time: Oct 2, 2026, 12:15 AM UTC\nPick: Buffalo Bills\nModel pick probability: 60.0%\nOdds: 1.90\nEV: +14.0%');
  assert.ok(Math.abs(expectedValuePercent({ ...pick, selection: 'away', selectionPrice: 2 }) - -20) < 1e-9);
  const won = resultMessageFromEntry({ ...pick, resolved: true, homeScore: 24, awayScore: 16 });
  assert.equal(won, '🏁 Final Result - Los Angeles Chargers @ Buffalo Bills\nGame time: Oct 2, 2026, 12:15 AM UTC\nSettled: Oct 2, 2026, 3:30 AM UTC\nModel pick probability: 60.0%\nWinner: Buffalo Bills\nStatus: ✅ Won (Final 16-24)');
  assert.match(resultMessageFromEntry({ ...pick, resolved: true, homeScore: 10, awayScore: 20 }), /Winner: Los Angeles Chargers\nStatus: ❌ Lost/);
  assert.match(resultMessageFromEntry({ ...pick, resolved: true, homeScore: 1, awayScore: 1 }), /Winner: Draw\nStatus: Push/);
});

test('notifications show the selected side probability and omit detection dates', () => {
  for (const format of [newBetMessageFromEntry, resultMessageFromEntry]) {
    const message = format({ ...pick, selection: 'away', homeScore: 24, awayScore: 16 });
    assert.match(message, /Model pick probability: 40.0%/);
    assert.doesNotMatch(message, /\nDetected:/);
    for (const homeProbability of [null, NaN, -0.1, 1.1]) {
      assert.match(format({ ...pick, homeProbability }), /Model pick probability: Not available/);
    }
    assert.match(format({ ...pick, selection: null }), /Model pick probability: Not available/);
  }
});

test('notification timestamps handle local date boundaries, DST and missing dates', () => {
  assert.match(newBetMessageFromEntry(pick, { timeZone: 'America/New_York' }), /Game time: Oct 1, 2026, 8:15 PM EDT/);
  assert.match(resultMessageFromEntry({ ...pick, homeScore: 24, awayScore: 16 }, { timeZone: 'America/New_York' }), /Settled: Oct 1, 2026, 11:30 PM EDT/);
  assert.equal(formatNotificationTime('2026-12-02T00:15:00Z', 'America/New_York'), 'Dec 1, 2026, 7:15 PM EST');
  for (const value of [undefined, null, '', 'not-a-date']) assert.equal(formatNotificationTime(value), 'Not available');
  assert.match(newBetMessageFromEntry({ ...pick, gameDate: null }), /Game time: Not available\nPick:/);
  assert.throws(() => createTelegramNotifier({ timeZone: 'Invalid/Zone' }), RangeError);
});

test('notifier applies configured time zone to both notification types', async () => {
  const calls = [];
  const notifier = createTelegramNotifier({ token: 't', chatId: 'c', minEv: null, fetcher: fakeFetch(calls), gapMs: 0, timeZone: 'America/New_York' });
  await notifier.notifyNewBet(pick);
  await notifier.notifyResult({ ...pick, resolved: true, homeScore: 24, awayScore: 16 });
  assert.ok(calls.every((call) => call.body.text.includes('Game time: Oct 1, 2026, 8:15 PM EDT')));
});

test('sender skips without credentials and reports API errors without throwing', async () => {
  const calls = [];
  assert.deepEqual(await sendTelegramMessage('hi', { token: '', chatId: '', fetcher: fakeFetch(calls) }), { ok: false, skipped: true });
  assert.equal(calls.length, 0);
  const failed = await sendTelegramMessage('hi', { token: 't', chatId: 'c', fetcher: fakeFetch(calls, { ok: false, status: 401, body: { description: 'Unauthorized' } }) });
  assert.deepEqual(failed, { ok: false, error: 'Unauthorized' });
  assert.equal(calls[0].url, 'https://api.telegram.org/bott/sendMessage');
  assert.equal(calls[0].body.chat_id, 'c');
  const thrown = await sendTelegramMessage('hi', { token: 't', chatId: 'c', fetcher: async () => { throw new Error('network down'); } });
  assert.deepEqual(thrown, { ok: false, error: 'network down' });
});

test('notifier honors the minimum EV filter', async () => {
  const calls = [];
  const notifier = createTelegramNotifier({ token: 't', chatId: 'c', minEv: 20, fetcher: fakeFetch(calls), gapMs: 0, logger: {} });
  assert.equal((await notifier.notifyNewBet(pick)).skipped, true);
  await notifier.notifyNewBet({ ...pick, selectionPrice: 2.2 });
  assert.equal(calls.length, 1);
});

test('ledger announces each new bet once and each final result once', async () => {
  const calls = [];
  const notifier = createTelegramNotifier({ token: 't', chatId: 'c', minEv: null, fetcher: fakeFetch(calls), gapMs: 0, logger: {} });
  const ledger = createLedger({ notifier });
  ledger.record({ ...pick, selectionPrice: undefined }); // no price yet: not a bet
  ledger.record(pick);
  ledger.record({ ...pick, selectionPrice: 1.85 }); // price refresh: same bet
  ledger.record({ ...pick, homeProbability: 0.4, selection: 'away', selectionPrice: 2.4 }); // flips are not re-announced (anti-spam)
  const game = { id: '1', completed: true, home: { score: 24 }, away: { score: 16 } };
  ledger.reconcile('nfl', [game]);
  ledger.reconcile('nfl', [game]);
  await notifier.flush();
  assert.deepEqual(calls.map((call) => call.body.text.split('\n')[0]), ['🚀 New Bet Detected!', '🏁 Final Result - Los Angeles Chargers @ Buffalo Bills']);
  assert.match(calls[0].body.text, /Pick: Buffalo Bills/);
  assert.match(calls[1].body.text, /Status: ❌ Lost/); // graded on the latest (flipped) pick
});

test('a failing notifier never breaks the ledger', () => {
  const ledger = createLedger({ logger: {}, notifier: { notifyNewBet() { throw new Error('boom'); }, notifyResult: () => Promise.reject(new Error('boom')) } });
  assert.ok(ledger.record(pick));
  assert.equal(ledger.reconcile('nfl', [{ id: '1', completed: true, home: { score: 3 }, away: { score: 0 } }]).length, 1);
});

test('outage retains more than 100 messages without dropping and later drains them', async () => {
  const warnings = [];
  let time = 0;
  let healthy = false;
  const calls = [];
  const notifier = createTelegramNotifier({ token: 't', chatId: 'c', minEv: null, schedule: false, now: () => time,
    fetcher: async (...args) => healthy ? fakeFetch(calls)(...args) : { ok: false, status: 503, json: async () => ({}) },
    gapMs: 0, logger: { warn: (message) => warnings.push(message) } });
  for (let index = 0; index < 105; index += 1) await notifier.notifyNewBet({ ...pick, eventId: String(index) });
  assert.equal(notifier.pendingCount(), 105);
  assert.equal(warnings.length, 105);
  healthy = true;
  time = 6000;
  await notifier.flush();
  assert.equal(notifier.pendingCount(), 0);
  assert.equal(calls.length, 105);
  notifier.close();
});

test('persistent outbox recovers failures after restart, respects retry_after, and deduplicates success', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sportsstat-notifier-'));
  const file = join(dir, 'outbox.json');
  let time = 0;
  let notifier;
  try {
    notifier = createTelegramNotifier({ file, token: 't', chatId: 'c', minEv: null, gapMs: 0, schedule: false, now: () => time, logger: {},
      fetcher: async () => ({ ok: false, status: 429, json: async () => ({ description: 'Too Many Requests', parameters: { retry_after: 30 } }) }) });
    await notifier.notifyNewBet(pick);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).pending.length, 1);
    notifier.close();
    const calls = [];
    notifier = createTelegramNotifier({ file, token: 't', chatId: 'c', minEv: null, gapMs: 0, schedule: false, now: () => time, fetcher: fakeFetch(calls) });
    time = 10000;
    await notifier.flush();
    assert.equal(calls.length, 0);
    time = 30000;
    await notifier.flush();
    assert.equal(calls.length, 1);
    assert.equal(notifier.pendingCount(), 0);
    notifier.close();
    notifier = createTelegramNotifier({ file, token: 't', chatId: 'c', minEv: null, gapMs: 0, schedule: false, fetcher: fakeFetch(calls) });
    await notifier.notifyNewBet(pick);
    assert.equal(calls.length, 1);
    assert.doesNotMatch(readFileSync(file, 'utf8'), /"token"|"chatId"/);
  } finally { notifier?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('ledger recovery fills enqueue gaps and daily summaries wait for every game and end of local date', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sportsstat-notifier-day-'));
  const file = join(dir, 'ledger.jsonl');
  const outboxFile = join(dir, 'outbox.json');
  let notifier;
  let time = Date.parse('2026-10-02T02:00:00Z'); // Oct 1 in New York
  try {
    const ledger = createLedger({ file });
    for (let index = 1; index <= 4; index += 1) {
      ledger.record({ ...pick, eventId: String(index), gameDate: '2026-10-01T23:00:00Z' });
    }
    const calls = [];
    notifier = createTelegramNotifier({ file: outboxFile, token: 't', chatId: 'c', minEv: null, gapMs: 0, schedule: false, now: () => time,
      timeZone: 'America/New_York', fetcher: fakeFetch(calls) });
    await notifier.syncLedger(file);
    assert.equal(calls.length, 4); // ledger saved but original enqueue never happened
    ledger.reconcile('nfl', [1, 2, 3].map((id) => ({ id: String(id), completed: true, home: { score: id === 3 ? 10 : 24 }, away: { score: 16 } })));
    await notifier.syncLedger(file);
    assert.equal(calls.filter((call) => call.body.text.includes('Daily Closing')).length, 0);
    time = Date.parse('2026-10-02T05:00:00Z');
    await notifier.syncLedger(file);
    assert.equal(calls.filter((call) => call.body.text.includes('Daily Closing')).length, 0); // fourth game still pending
    ledger.reconcile('nfl', [{ id: '4', completed: true, home: { score: 16 }, away: { score: 16 } }]);
    await notifier.syncLedger(file);
    const summary = calls.find((call) => call.body.text.includes('Daily Closing'))?.body.text;
    assert.match(summary, /Date: 2026-10-01 \(America\/New_York\)/);
    assert.match(summary, /Wins: 2\/3\nWin rate: 66.7%\nLosses: 1\nPushes: 1/);
    notifier.close();
    notifier = createTelegramNotifier({ file: outboxFile, token: 't', chatId: 'c', minEv: null, gapMs: 0, schedule: false, now: () => time,
      timeZone: 'America/New_York', fetcher: fakeFetch(calls) });
    await notifier.syncLedger(file);
    assert.equal(calls.length, 9); // four bets, four results, one daily summary
  } finally { notifier?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('daily summary does not close early even if every currently tracked game is settled', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sportsstat-notifier-close-'));
  let notifier;
  try {
    const file = join(dir, 'ledger.jsonl');
    const ledger = createLedger({ file });
    ledger.record(pick);
    ledger.reconcile('nfl', [{ id: '1', completed: true, home: { score: 1 }, away: { score: 1 } }]);
    const calls = [];
    let time = Date.parse('2026-10-02T04:00:00Z');
    notifier = createTelegramNotifier({ token: 't', chatId: 'c', minEv: null, gapMs: 0, schedule: false, now: () => time, fetcher: fakeFetch(calls), timeZone: 'UTC' });
    await notifier.syncLedger(file);
    assert.ok(!calls.some((call) => call.body.text.includes('Daily Closing')));
    time = Date.parse('2026-10-03T00:00:00Z');
    await notifier.syncLedger(file);
    assert.match(calls.at(-1).body.text, /Wins: 0\/0\nWin rate: Not available \(pushes only\)/);
  } finally { notifier?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('cloud outbox waits for persistence, retains concurrent messages and restores acknowledgements', async () => {
  let saved = { pending: [], sent: [] };
  let fail = true;
  const sent = [];
  const options = { token: 'fixture', chatId: 'fixture', minEv: null, gapMs: 0, schedule: false, logger: {},
    persistOutbox: async (state) => { if (fail) throw new Error('Unavailable'); saved = structuredClone(state); },
    fetcher: async (url, options) => { sent.push(JSON.parse(options.body).text); return Response.json({ ok: true }); } };
  let notifier = createTelegramNotifier({ ...options, outboxState: saved });
  const entry = { sport: 'mlb', eventId: '1', selection: 'home', selectionPrice: 2, homeProbability: 0.6 };
  await assert.rejects(notifier.notifyNewBet(entry), /Unavailable/);
  assert.equal(sent.length, 0);
  fail = false;
  await Promise.all([notifier.notifyNewBet(entry), notifier.notifyNewBet({ ...entry, eventId: '2' })]);
  assert.equal(sent.length, 2);
  assert.equal(saved.pending.length, 0);
  assert.equal(saved.sent.length, 2);
  notifier.close();
  notifier = createTelegramNotifier({ ...options, outboxState: saved });
  await notifier.notifyNewBet(entry);
  assert.equal(sent.length, 2);
  notifier.close();
});

test('a corrupt outbox fails explicitly instead of silently losing queued messages', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sportsstat-notifier-corrupt-'));
  try {
    const file = join(dir, 'outbox.json');
    writeFileSync(file, '{"pending":false,"sent":[]}');
    assert.throws(() => createTelegramNotifier({ file }), /Invalid Telegram outbox/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('unacknowledged HTTP success and network errors are failures, not delivered messages', async () => {
  const failed = await sendTelegramMessage('hi', { token: 't', chatId: 'c', fetcher: fakeFetch([], { body: { ok: false } }) });
  assert.equal(failed.ok, false);
  const malformed = await sendTelegramMessage('hi', { token: 't', chatId: 'c', fetcher: async () => ({ ok: true, json: async () => { throw new SyntaxError('invalid JSON'); } }) });
  assert.equal(malformed.ok, false);
});

test('failed acknowledgement persistence retains the queued message for retry', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sportsstat-notifier-write-'));
  const file = join(dir, 'outbox.json');
  let notifier;
  let time = 0;
  const errors = [];
  const calls = [];
  try {
    notifier = createTelegramNotifier({ file, token: 't', chatId: 'c', minEv: null, gapMs: 0, schedule: false, now: () => time,
      logger: { error: (message) => errors.push(message) },
      fetcher: async (...args) => {
        if (!calls.length) mkdirSync(`${file}.tmp`);
        return fakeFetch(calls)(...args);
      } });
    await notifier.notifyNewBet(pick);
    assert.equal(notifier.pendingCount(), 1);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).pending.length, 1);
    assert.equal(errors.length, 1);
    rmSync(`${file}.tmp`, { recursive: true });
    time = 6000;
    await notifier.flush();
    assert.equal(notifier.pendingCount(), 0);
    assert.equal(calls.length, 2); // at-least-once: retry ambiguous delivery rather than lose it
  } finally { notifier?.close(); rmSync(dir, { recursive: true, force: true }); }
});
