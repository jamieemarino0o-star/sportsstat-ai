import test from 'node:test';
import assert from 'node:assert/strict';
import { createTelegramNotifier, sendTelegramMessage, newBetMessageFromEntry, resultMessageFromEntry, expectedValuePercent } from '../src/notifier.js';
import { createLedger } from '../src/ledger.js';

const fakeFetch = (calls, { ok = true, status = 200, body = { ok: true } } = {}) => async (url, init) => {
  calls.push({ url, body: JSON.parse(init.body) });
  return { ok, status, json: async () => body };
};

const pick = { sport: 'nfl', eventId: '1', homeTeam: 'Buffalo Bills', awayTeam: 'Los Angeles Chargers', homeProbability: 0.6, selection: 'home', selectionPrice: 1.9 };

test('message formats match the required templates', () => {
  assert.equal(newBetMessageFromEntry(pick), '🚀 New Bet Detected!\nMatch: Los Angeles Chargers @ Buffalo Bills\nPick: Buffalo Bills\nOdds: 1.90\nEV: +14.0%');
  assert.ok(Math.abs(expectedValuePercent({ ...pick, selection: 'away', selectionPrice: 2 }) - -20) < 1e-9);
  const won = resultMessageFromEntry({ ...pick, resolved: true, homeScore: 24, awayScore: 16 });
  assert.equal(won, '🏁 Final Result - Los Angeles Chargers @ Buffalo Bills\nWinner: Buffalo Bills\nStatus: ✅ Won (Final 16-24)');
  assert.match(resultMessageFromEntry({ ...pick, resolved: true, homeScore: 10, awayScore: 20 }), /Winner: Los Angeles Chargers\nStatus: ❌ Lost/);
  assert.match(resultMessageFromEntry({ ...pick, resolved: true, homeScore: 1, awayScore: 1 }), /Winner: Draw\nStatus: Push/);
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
