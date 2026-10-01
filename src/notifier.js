// Telegram notifications for new model picks and final results. Uses Node's built-in fetch, so no
// extra dependency is needed. Every send is fire-and-forget: a Telegram outage, bad token or rate
// limit is logged (without the token) and never propagates into the prediction/ledger pipeline.

const TELEGRAM_API = 'https://api.telegram.org';
const SEND_TIMEOUT_MS = 10000;
// Telegram allows roughly one message per second to a single chat; space sends so a scoreboard
// refresh that resolves many games at once doesn't trigger 429s.
const MIN_SEND_GAP_MS = 1100;
const MAX_QUEUE = 100;

const matchLabel = (entry) => `${entry.awayTeam || 'Away'} @ ${entry.homeTeam || 'Home'}`;
const pickTeam = (entry) => (entry.selection === 'home' ? entry.homeTeam : entry.selection === 'away' ? entry.awayTeam : null);
const pickProbability = (entry) => (entry.selection === 'home' ? entry.homeProbability : 1 - entry.homeProbability);

// Expected value (in %) of a 1-unit stake on the model's pick at the matched decimal odds.
export function expectedValuePercent(entry) {
  if (!entry?.selection || !Number.isFinite(entry.selectionPrice) || !Number.isFinite(entry.homeProbability)) return null;
  return (pickProbability(entry) * entry.selectionPrice - 1) * 100;
}

export function formatNewBetMessage({ match, pick, odds, ev }) {
  return `🚀 New Bet Detected!\nMatch: ${match}\nPick: ${pick}\nOdds: ${odds}\nEV: ${ev}%`;
}

export function formatResultMessage({ match, winner, status }) {
  return `🏁 Final Result - ${match}\nWinner: ${winner}\nStatus: ${status}`;
}

export function newBetMessageFromEntry(entry) {
  const ev = expectedValuePercent(entry);
  return formatNewBetMessage({
    match: matchLabel(entry),
    pick: pickTeam(entry) || 'n/a',
    odds: Number.isFinite(entry.selectionPrice) ? entry.selectionPrice.toFixed(2) : 'n/a',
    ev: ev === null ? 'n/a' : `${ev >= 0 ? '+' : ''}${ev.toFixed(1)}`,
  });
}

export function resultMessageFromEntry(entry) {
  const draw = entry.homeScore === entry.awayScore;
  const winner = draw ? 'Draw' : entry.homeScore > entry.awayScore ? entry.homeTeam : entry.awayTeam;
  const score = `Final ${entry.awayScore}-${entry.homeScore}`;
  let status;
  if (!entry.selection) status = `No pick (${score})`;
  else if (draw) status = `Push (${score})`;
  else status = `${winner === pickTeam(entry) ? '✅ Won' : '❌ Lost'} (${score})`;
  return formatResultMessage({ match: matchLabel(entry), winner: winner || 'n/a', status });
}

// Low-level sender. Returns { ok, skipped?, error? } instead of throwing.
export async function sendTelegramMessage(text, { token = process.env.TELEGRAM_BOT_TOKEN, chatId = process.env.TELEGRAM_CHAT_ID, fetcher = fetch } = {}) {
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
      try { description = (await response.json()).description || description; } catch { /* non-JSON error body */ }
      return { ok: false, error: description };
    }
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
  chatId = process.env.TELEGRAM_CHAT_ID,
  minEv = process.env.TELEGRAM_MIN_EV === undefined || process.env.TELEGRAM_MIN_EV === '' ? null : Number(process.env.TELEGRAM_MIN_EV),
  fetcher = fetch,
  gapMs = MIN_SEND_GAP_MS,
  logger = console,
} = {}) {
  const enabled = Boolean(token && chatId);
  let queue = Promise.resolve();

  let queued = 0;
  function enqueue(text) {
    if (!enabled) return Promise.resolve({ ok: false, skipped: true });
    // Bound the backlog so a long Telegram outage can't grow memory without limit.
    if (queued >= MAX_QUEUE) {
      logger.warn?.('[telegram] queue full, dropping notification');
      return Promise.resolve({ ok: false, skipped: true, error: 'queue full' });
    }
    queued += 1;
    const job = queue.then(async () => {
      const result = await sendTelegramMessage(text, { token, chatId, fetcher });
      if (!result.ok && !result.skipped) logger.warn?.(`[telegram] notification failed: ${result.error}`);
      if (gapMs > 0) await new Promise((resolve) => setTimeout(resolve, gapMs));
      return result;
    }).finally(() => { queued -= 1; });
    queue = job.catch(() => {});
    return job;
  }

  return {
    enabled,
    notifyNewBet(entry) {
      if (!entry?.selection || !Number.isFinite(entry.selectionPrice)) return Promise.resolve({ ok: false, skipped: true });
      const ev = expectedValuePercent(entry);
      if (Number.isFinite(minEv) && (ev === null || ev < minEv)) return Promise.resolve({ ok: false, skipped: true });
      return enqueue(newBetMessageFromEntry(entry));
    },
    notifyResult(entry) {
      if (!entry?.resolved || !Number.isFinite(entry.homeScore) || !Number.isFinite(entry.awayScore)) return Promise.resolve({ ok: false, skipped: true });
      return enqueue(resultMessageFromEntry(entry));
    },
    // Resolves once every queued message has been attempted (useful for tests and CLI scripts).
    flush: () => queue,
  };
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
