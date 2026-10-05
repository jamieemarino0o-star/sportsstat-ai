import { formatDecimalOdds } from '../public/js/model.js';
import { createNotificationOutbox } from './notification-outbox.js';
import { readFileSync } from 'node:fs';
import { parseLedgerLines } from './backtest.js';
import { buildLedgerRows, buildWinCalendar, dayKey } from './audit.js';

// Telegram notifications for new model picks and final results. Uses Node's built-in fetch, so no
// extra dependency is needed. Every send is fire-and-forget: a Telegram outage, bad token or rate
// limit is logged (without the token) and never propagates into the prediction/ledger pipeline.

const TELEGRAM_API = 'https://api.telegram.org';
const SEND_TIMEOUT_MS = 10000;
// Telegram allows roughly one message per second to a single chat; space sends so a scoreboard
// refresh that resolves many games at once doesn't trigger 429s.
const MIN_SEND_GAP_MS = 1100;
export const QUEBEC_TIME_ZONE = 'America/Toronto';

const matchLabel = (entry) => `${entry.awayTeam || 'Away'} @ ${entry.homeTeam || 'Home'}`;
const pickTeam = (entry) => (entry.selection === 'home' ? entry.homeTeam : entry.selection === 'away' ? entry.awayTeam : null);
const pickProbability = (entry) => (entry.selection === 'home' ? entry.homeProbability : 1 - entry.homeProbability);
const probabilityLabel = (entry) => ['home', 'away'].includes(entry.selection)
  && Number.isFinite(entry.homeProbability) && entry.homeProbability >= 0 && entry.homeProbability <= 1
  ? `${(pickProbability(entry) * 100).toFixed(1)}%` : 'Not available';

// Expected value (in %) of a 1-unit stake on the model's pick at the matched decimal odds.
export function expectedValuePercent(entry) {
  if (!entry?.selection || !Number.isFinite(entry.selectionPrice) || !Number.isFinite(entry.homeProbability)) return null;
  return (pickProbability(entry) * entry.selectionPrice - 1) * 100;
}

export function formatNotificationTime(value, timeZone = QUEBEC_TIME_ZONE, { zoneLabel = true } = {}) {
  if (!value || Number.isNaN(Date.parse(value))) return 'Not available';
  return new Intl.DateTimeFormat('en-US', {
    timeZone, month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', ...(zoneLabel ? { timeZoneName: 'short' } : {}),
  }).format(new Date(value));
}

export function formatNewBetMessage({ match, pick, odds, ev, probability = 'Not available', gameTime = 'Not available' }) {
  return `🚀 New Bet Detected!\nMatch: ${match}\nGame time: ${gameTime}\nPick: ${pick}\nModel pick probability: ${probability}\nOdds: ${odds}\nEV: ${ev}%`;
}

export function formatResultMessage({ league, match, status, score, openingOdds = 'n/a', probability = 'Not available', gameTime = 'Not available' }) {
  return `🏁 Final Result - ${league}\n${match}\n${status}\n🥇 (${score})\nOpening Odds ${openingOdds}\nGame time: ${gameTime}\nModel pick probability: ${probability}`;
}

export function newBetMessageFromEntry(entry, { timeZone = QUEBEC_TIME_ZONE } = {}) {
  const ev = expectedValuePercent(entry);
  return formatNewBetMessage({
    match: matchLabel(entry),
    pick: pickTeam(entry) || 'n/a',
    odds: Number.isFinite(entry.selectionPrice) && entry.selectionPrice > 1 ? formatDecimalOdds(entry.selectionPrice) : 'n/a',
    ev: ev === null ? 'n/a' : `${ev >= 0 ? '+' : ''}${ev.toFixed(1)}`,
    gameTime: formatNotificationTime(entry.gameDate, timeZone),
    probability: probabilityLabel(entry),
  });
}

// Grades the first priced pick (the announced bet), not later side flips.
export function resultMessageFromEntry(entry, { timeZone = QUEBEC_TIME_ZONE } = {}) {
  const { opening, ...settled } = entry;
  const bet = { ...settled, ...(opening ? { selection: opening.selection, homeProbability: opening.homeProbability, selectionPrice: opening.selectionPrice } : {}) };
  const draw = bet.homeScore === bet.awayScore;
  const winner = draw ? null : bet.homeScore > bet.awayScore ? bet.homeTeam : bet.awayTeam;
  const pick = pickTeam(bet);
  let status;
  if (!pick) status = 'No pick';
  else if (draw) status = `➖ Push ${pick}`;
  else status = `${winner === pick ? '✅ Won' : '❌ Lost'} ${pick}`;
  return formatResultMessage({
    league: String(bet.sport || '').toUpperCase() || 'n/a',
    match: matchLabel(bet), status,
    score: `Final ${bet.awayScore}-${bet.homeScore}`,
    openingOdds: Number.isFinite(bet.selectionPrice) && bet.selectionPrice > 1 ? formatDecimalOdds(bet.selectionPrice) : 'n/a',
    gameTime: formatNotificationTime(bet.gameDate, timeZone, { zoneLabel: false }),
    probability: probabilityLabel(bet),
  });
}

// Low-level sender. Returns { ok, skipped?, error? } instead of throwing.
export async function sendTelegramMessage(text, { token = process.env.TELEGRAM_BOT_TOKEN, chatId = process.env.TELEGRAM_CHAT_ID?.trim(), fetcher = fetch } = {}) {
  if (!token || !chatId) return { ok: false, skipped: true };
  try {
    const response = await fetcher(`${TELEGRAM_API}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (!response.ok) {
      let description = `HTTP ${response.status}`;
      let retryAfterMs = 0;
      try {
        const body = await response.json();
        description = body.description || description;
        if (Number.isFinite(body.parameters?.retry_after)) retryAfterMs = body.parameters.retry_after * 1000;
      } catch { /* non-JSON error body */ }
      return { ok: false, error: description, ...(retryAfterMs > 0 ? { retryAfterMs } : {}) };
    }
    const body = await response.json();
    if (body.ok !== true) return { ok: false, error: 'Telegram did not acknowledge the message' };
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.name === 'TimeoutError' ? 'request timed out' : error.message };
  }
}

// High-level notifier consumed by the ledger. Options:
// - minEv: only announce new bets whose EV% is >= this value (env TELEGRAM_MIN_EV; unset = all picks).
// - gapMs: spacing between queued sends.
export function createTelegramNotifier({
  token = process.env.TELEGRAM_BOT_TOKEN,
  chatId = process.env.TELEGRAM_CHAT_ID?.trim(),
  minEv = process.env.TELEGRAM_MIN_EV === undefined || process.env.TELEGRAM_MIN_EV === '' ? null : Number(process.env.TELEGRAM_MIN_EV),
  fetcher = fetch,
  gapMs = MIN_SEND_GAP_MS,
  logger = console,
  timeZone = QUEBEC_TIME_ZONE,
  file = null,
  retryMs = 5000,
  now = Date.now,
  schedule = true,
  outboxState = null,
  persistOutbox = null,
} = {}) {
  // Reject a bad configuration at startup rather than dropping notifications later.
  new Intl.DateTimeFormat('en-US', { timeZone });
  const enabled = Boolean(token && chatId);
  const outbox = createNotificationOutbox({
    file, gapMs, retryMs, now, logger, schedule, initialState: outboxState, saveState: persistOutbox,
    send: (text) => sendTelegramMessage(text, { token, chatId, fetcher }),
  });

  const notifier = {
    enabled,
    notifyNewBet(entry) {
      if (!entry?.selection || !Number.isFinite(entry.selectionPrice)) return Promise.resolve({ ok: false, skipped: true });
      const ev = expectedValuePercent(entry);
      if (Number.isFinite(minEv) && (ev === null || ev < minEv)) return Promise.resolve({ ok: false, skipped: true });
      if (!enabled) return Promise.resolve({ ok: false, skipped: true });
      return outbox.enqueue(`bet:${entry.sport}:${entry.eventId}`, newBetMessageFromEntry(entry, { timeZone }));
    },
    notifyResult(entry) {
      if (!entry?.resolved || !Number.isFinite(entry.homeScore) || !Number.isFinite(entry.awayScore)) return Promise.resolve({ ok: false, skipped: true });
      if (!enabled) return Promise.resolve({ ok: false, skipped: true });
      return outbox.enqueue(`result:${entry.sport}:${entry.eventId}`, resultMessageFromEntry(entry, { timeZone }));
    },
    async syncLedger(ledgerFile) {
      if (!enabled) return;
      await outbox.flush();
      let raw;
      try { raw = Array.isArray(ledgerFile) ? ledgerFile.map((record) => JSON.stringify(record)).join('\n') : readFileSync(ledgerFile, 'utf8'); }
      catch (error) { if (error.code === 'ENOENT') return; throw error; }
      const groups = parseLedgerLines(raw.split('\n'));
      for (const group of groups.values()) {
        const announced = group.predictions.find((entry) => entry.announced && entry.selection && entry.selectionPrice > 1);
        if (announced) await notifier.notifyNewBet(announced);
        if (group.result && group.predictions.length) {
          const opening = [...group.predictions].sort((first, second) => new Date(first.updatedAt || first.loggedAt) - new Date(second.updatedAt || second.loggedAt))
            .find((entry) => entry.selection && entry.selectionPrice > 1);
          await notifier.notifyResult({ ...group.predictions.at(-1), ...group.result, opening });
        }
      }
      const rows = buildLedgerRows(groups, { limit: Infinity });
      const today = dayKey(new Date(now()).toISOString(), timeZone);
      const days = buildWinCalendar(rows, { timeZone });
      const known = outbox.knownIds();
      // Dates already summarized under a previous time zone must not be replayed in the new one.
      const previousZoneDate = known.filter((id) => id.startsWith('day:') && !id.startsWith(`day:${timeZone}:`)).map((id) => id.slice(-10)).sort().at(-1) || '';
      for (const day of days) {
        if (day.date <= previousZoneDate) continue;
        if (day.date >= today || rows.some((row) => dayKey(row.gameDate || row.resolvedAt || row.loggedAt, timeZone) === day.date && !row.resolved)) continue;
        const rate = day.decided ? `${(day.winRate * 100).toFixed(1)}%` : 'Not available (pushes only)';
        await outbox.enqueue(`day:${timeZone}:${day.date}`,
          `📊 Daily Closing Results\nDate: ${day.date} (${timeZone})\nWins: ${day.fraction}\nWin rate: ${rate}\nLosses: ${day.losses}\nPushes: ${day.pushes}\nAll tracked games settled.`);
      }
    },
    flush: () => enabled ? outbox.flush() : Promise.resolve(),
    pendingCount: outbox.pendingCount,
    close: outbox.close,
  };
  return notifier;
}

if (process.argv[1] && process.argv[1].endsWith('notifier.js')) {
  const text = process.argv.slice(2).join(' ') || '✅ SportsStat AI Predictor: Telegram notifications are configured.';
  sendTelegramMessage(text).then((result) => {
    if (result.skipped) console.error('Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env first.');
    else if (!result.ok) console.error(`Telegram send failed: ${result.error}`);
    else console.log('Test message sent.');
    process.exitCode = result.ok ? 0 : 1;
  });
}
