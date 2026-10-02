import test from 'node:test';
import assert from 'node:assert/strict';
import { createTelegramNotifier, sendTelegramMessage, newBetMessageFromEntry, resultMessageFromEntry, expectedValuePercent, formatNotificationTime } from '../src/notifier.js';
import { createLedger } from '../src/ledger.js';

const fakeFetch = (calls, { ok = true, status = 200, body = { ok: true } } = {}) => async (url, init) => {
  calls.push({ url, body: JSON.parse(init.body) });
  return { ok, status, json: async () => body };
};

const pick = { sport: 'nfl', eventId: '1', homeTeam: 'Buffalo Bills', awayTeam: 'Los Angeles Chargers', homeProbability: 0.6, selection: 'home', selectionPrice: 1.9, gameDate: '2026-10-02T00:15:00Z', updatedAt: '2026-10-01T14:00:00Z', resolvedAt: '2026-10-02T03:30:00Z' };

test('message formats match the required templates', () => {
  assert.equal(newBetMessageFromEntry(pick), '🚀 New Bet Detected!\nMatch: Los Angeles Chargers @ Buffalo Bills\nGame time: Oct 2, 2026, 12:15 AM UTC\nDetected: Oct 1, 2026, 2:00 PM UTC\nPick: Buffalo Bills\nOdds: 1.90\nEV: +14.0%');
  assert.ok(Math.abs(expectedValuePercent({ ...pick, selection: 'away', selectionPrice: 2 }) - -20) < 1e-9);
  const won = resultMessageFromEntry({ ...pick, resolved: true, homeScore: 24, awayScore: 16 });
  assert.equal(won, '🏁 Final Result - Los Angeles Chargers @ Buffalo Bills\nGame time: Oct 2, 2026, 12:15 AM UTC\nSettled: Oct 2, 2026, 3:30 AM UTC\nWinner: Buffalo Bills\nStatus: ✅ Won (Final 16-24)');
  assert.match(resultMessageFromEntry({ ...pick, resolved: true, homeScore: 10, awayScore: 20 }), /Winner: Los Angeles Chargers\nStatus: ❌ Lost/);
  assert.match(resultMessageFromEntry({ ...pick, resolved: true, homeScore: 1, awayScore: 1 }), /Winner: Draw\nStatus: Push/);
});

test('notification timestamps handle local date boundaries, DST and missing dates', () => {
  assert.match(newBetMessageFromEntry(pick, { timeZone: 'America/New_York' }), /Game time: Oct 1, 2026, 8:15 PM EDT/);
  assert.match(resultMessageFromEntry({ ...pick, homeScore: 24, awayScore: 16 }, { timeZone: 'America/New_York' }), /Settled: Oct 1, 2026, 11:30 PM EDT/);
  assert.equal(formatNotificationTime('2026-12-02T00:15:00Z', 'America/New_York'), 'Dec 1, 2026, 7:15 PM EST');
  for (const value of [undefined, null, '', 'not-a-date']) assert.equal(formatNotificationTime(value), 'Not available');
  assert.match(newBetMessageFromEntry({ ...pick, gameDate: null, updatedAt: null, loggedAt: '2026-10-01T14:00:00Z' }), /Game time: Not available\nDetected: Oct 1, 2026, 2:00 PM UTC/);
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
  const ledger = createLedger({ notifier: { notifyNewBet() { throw new Error('boom'); }, notifyResult: () => Promise.reject(new Error('boom')) } });
  assert.ok(ledger.record(pick));
  assert.equal(ledger.reconcile('nfl', [{ id: '1', completed: true, home: { score: 3 }, away: { score: 0 } }]).length, 1);
});

test('notifier queue is bounded during an outage', async () => {
  const warnings = [];
  const notifier = createTelegramNotifier({ token: 't', chatId: 'c', minEv: null, fetcher: () => new Promise(() => {}), gapMs: 0, logger: { warn: (message) => warnings.push(message) } });
  for (let index = 0; index < 101; index += 1) notifier.notifyNewBet({ ...pick, eventId: String(index) });
  assert.equal((await notifier.notifyNewBet(pick)).error, 'queue full');
  assert.ok(warnings.some((message) => message.includes('queue full')));
});
