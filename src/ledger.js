import { appendFileSync, readFileSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const MAX_ENTRIES_PER_SPORT = 4000;
const MAX_DECIMAL_PRICE = 1001; // +100000 American: anything above is a corrupt or fabricated quote
const STALE_PENDING_AGE = 120 * 24 * 60 * 60 * 1000;
const MIN_BIAS_SAMPLE = 20;
const MIN_WINDOW_SAMPLE = 15;
const MIN_DECAY_SAMPLE = 15;
const MIN_SOS_SAMPLE = 15;

const validDate = (value) => (value && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : null);

function actualOutcome(home, away) {
  if (home === away) return 0.5;
  return home > away ? 1 : 0;
}

// Ground-truth ledger of every pre-game win-probability prediction the model has made, plus the
// final result once ESPN reports the game as complete. This is what step 1 and 2 of the feedback
// loop need: an immutable record of what was predicted, and an automated reconciliation against
// the actual outcome (binary result + Brier score) once it is known.
// `notifier` (optional, e.g. createTelegramNotifier() from src/notifier.js) receives
// notifyNewBet(entry) the first time an event gets a priced pick and
// notifyResult(entry) when that event is reconciled. Notifier failures never affect the ledger.
export function createLedger({ file = null, notifier = null, logger = console, records = [], persist = null } = {}) {
  const entries = new Map(); // key: `${sport}:${eventId}`
  const openings = new Map(); // first priced pick per event (the announced bet), used for result notifications
  const priced = (record) => Boolean(record.selection && record.selectionPrice > 1);
  // A crash or full disk mid-write can leave a final line without its newline; the next append would
  // then be glued onto it and both records lost. Tracked so append() can terminate a torn tail first.
  let needsNewline = false;
  let lastWriteError = null;
  const notify = (method, entry) => {
    const failed = () => logger.error?.(`[ledger] ${method} failed for ${entry.sport}:${entry.eventId}; ledger recovery will retry`);
    try { notifier?.[method]?.(entry)?.catch?.(failed); } catch { failed(); }
  };

  function load() {
    let raw = '';
    if (file) { try { raw = readFileSync(file, 'utf8'); } catch {} }
    needsNewline = raw.length > 0 && !raw.endsWith('\n');
    for (const line of [...raw.split('\n'), ...records.map((record) => JSON.stringify(record))]) {
      if (!line.trim()) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      if (!record || typeof record !== 'object' || !record.sport || !record.eventId) continue;
      const key = `${record.sport}:${record.eventId}`;
      // Settled results are final: a stray later prediction line (e.g. written by a second server
      // process sharing the file) must not reopen a resolved event.
      if (record.type === 'prediction') {
        if (!openings.has(key) && priced(record)) openings.set(key, { ...record });
        if (!entries.get(key)?.resolved) entries.set(key, { ...record });
      }
      else if (record.type === 'result') {
        const existing = entries.get(key);
        if (existing) entries.set(key, { ...existing, ...record });
      }
    }
  }

  function append(record) {
    if (persist) return persist(record);
    if (!file) return;
    try {
      mkdirSync(dirname(file), { recursive: true });
      if (!existsSync(file)) writeFileSync(file, '');
      // One appendFileSync call per record: a single O_APPEND write that Node's single thread can't
      // interleave with another write from this process.
      appendFileSync(file, `${needsNewline ? '\n' : ''}${JSON.stringify(record)}\n`);
      needsNewline = false;
      lastWriteError = null;
    } catch (error) {
      // Never break a request, but never fail silently either: log once per distinct error code.
      if (lastWriteError !== error.code) logger.error?.(`[ledger] failed to persist ${record.type} for ${record.sport}:${record.eventId} (${error.code || error.message})`);
      lastWriteError = error.code;
    }
  }

  load();

  function record({ sport, eventId, homeTeam, awayTeam, gameDate, homeProbability, selection, window, decay, sosWeight, sample, expectedHome, expectedAway, marketImpliedHome, selectionPrice }) {
    if (!sport || !eventId || !Number.isFinite(homeProbability) || homeProbability < 0 || homeProbability > 1) return null;
    const key = `${sport}:${eventId}`;
    const existing = entries.get(key);
    if (existing?.resolved) return existing;
    const loggedAt = existing?.loggedAt || new Date().toISOString();
    const entry = {
      type: 'prediction', sport, eventId: String(eventId), homeTeam: homeTeam || existing?.homeTeam || null, awayTeam: awayTeam || existing?.awayTeam || null,
      // Scheduled kickoff/tip-off time (ISO), shown in the Audit Lab and used to bucket its win calendar.
      gameDate: validDate(gameDate) || existing?.gameDate || null,
      homeProbability, selection: selection === 'home' || selection === 'away' ? selection : null, window: window === 20 ? 20 : 10,
      decay: Number.isFinite(decay) && decay > 0 && decay <= 1 ? Number(decay.toFixed(4)) : 1,
      // The strength-of-schedule adjustment weight applied when this snapshot was generated (see
      // SOS_WEIGHT in public/js/model.js). Logged the same way as decay so src/optimize.js's live
      // A/B exploration can compare candidate weights against real reconciled outcomes.
      sosWeight: Number.isFinite(sosWeight) && sosWeight >= 0 && sosWeight <= 1 ? Number(sosWeight.toFixed(4)) : 0.3,
      sample: Number.isFinite(sample) ? sample : null, expectedHome: Number.isFinite(expectedHome) ? expectedHome : null,
      expectedAway: Number.isFinite(expectedAway) ? expectedAway : null, marketImpliedHome: Number.isFinite(marketImpliedHome) ? marketImpliedHome : null,
      // Decimal odds for the model's picked side, matched at the moment this snapshot was logged. Logged on
      // every refresh cycle up to kickoff so the append-only file below captures an opening and closing
      // price per event for the backtest script (src/backtest.js) to compute ROI and closing-line value from.
      selectionPrice: Number.isFinite(selectionPrice) && selectionPrice > 1 && selectionPrice <= MAX_DECIMAL_PRICE ? selectionPrice : null,
      loggedAt, updatedAt: new Date().toISOString(), resolved: false,
    };
    // record() runs on every refresh cycle up to kickoff, so announce each event at most once
    // (persisted, so restarts don't re-announce): re-announcing on side flips would let anyone
    // toggling `selection` through the public POST /api/predictions route spam the Telegram chat.
    const announceNow = Boolean(entry.selection && entry.selectionPrice && !existing?.announced);
    entry.announced = Boolean(existing?.announced || announceNow);
    const commit = () => {
      entries.set(key, entry);
      if (!openings.has(key) && priced(entry)) openings.set(key, entry);
      if (announceNow) notify('notifyNewBet', entry);
      return entry;
    };
    const saved = append(entry);
    return persist ? Promise.resolve(saved).then(commit) : commit();
  }

  function reconcile(sport, games) {
    const resolvedNow = [];
    const writes = [];
    for (const game of games || []) {
      if (!game.completed) continue;
      const key = `${sport}:${game.id}`;
      const entry = entries.get(key);
      if (!entry || entry.resolved) continue;
      const homeScore = game.home?.score;
      const awayScore = game.away?.score;
      // Never settle on a missing/garbled score: leave it pending for the next reconciliation pass.
      if (!Number.isFinite(homeScore) || !Number.isFinite(awayScore)) continue;
      const outcome = actualOutcome(homeScore, awayScore);
      const brier = (entry.homeProbability - outcome) ** 2;
      const favoriteCorrect = entry.selection ? (entry.selection === 'home' ? homeScore >= awayScore : awayScore >= homeScore) : null;
      const result = { type: 'result', sport, eventId: entry.eventId, gameDate: validDate(game.date) || entry.gameDate || null, resolved: true, homeScore, awayScore, outcome, brier, favoriteCorrect, resolvedAt: new Date().toISOString() };
      const updated = { ...entry, ...result };
      const commit = () => {
        entries.set(key, updated);
        resolvedNow.push(updated);
        notify('notifyResult', { ...updated, opening: openings.get(key) });
      };
      const saved = append(result);
      if (persist) writes.push(Promise.resolve(saved).then(commit));
      else commit();
    }
    if (persist) return Promise.allSettled(writes).then((results) => {
      const failed = results.find((result) => result.status === 'rejected');
      if (failed) throw failed.reason;
      prune();
      return resolvedNow;
    });
    prune();
    return resolvedNow;
  }

  function prune() {
    const cutoff = Date.now() - STALE_PENDING_AGE;
    for (const [key, entry] of entries) if (!entry.resolved && new Date(entry.loggedAt).getTime() < cutoff) entries.delete(key);
    const bySport = new Map();
    for (const [key, entry] of entries) {
      if (!bySport.has(entry.sport)) bySport.set(entry.sport, []);
      bySport.get(entry.sport).push(key);
    }
    for (const keys of bySport.values()) {
      const excess = keys.length - MAX_ENTRIES_PER_SPORT;
      for (let index = 0; index < excess; index += 1) entries.delete(keys[index]);
    }
    for (const key of openings.keys()) if (!entries.has(key)) openings.delete(key);
  }

  function summarize(list) {
    if (!list.length) return { sample: 0, brier: null, hitRate: null, bias: null };
    const brier = list.reduce((total, entry) => total + entry.brier, 0) / list.length;
    const withFavorite = list.filter((entry) => entry.favoriteCorrect !== null);
    const hitRate = withFavorite.length ? withFavorite.filter((entry) => entry.favoriteCorrect).length / withFavorite.length : null;
    const bias = list.reduce((total, entry) => total + (entry.homeProbability - entry.outcome), 0) / list.length;
    return { sample: list.length, brier, hitRate, bias };
  }

  // Buckets resolved entries by a per-prediction parameter (decay, sosWeight, ...) that the app
  // explores across a small fixed set of candidate values, and declares a winner (the lowest-Brier
  // candidate) once at least two candidates individually have enough resolved samples to compare
  // fairly. This generalizes the original bestDecay logic so any similarly-explored parameter (e.g.
  // strength-of-schedule weight) can reuse the exact same live A/B comparison.
  function bestByParam(resolved, paramName, defaultValue, minSample) {
    const values = [...new Set(resolved.map((entry) => entry[paramName] ?? defaultValue))];
    const buckets = Object.fromEntries(values.map((value) => [value, summarize(resolved.filter((entry) => (entry[paramName] ?? defaultValue) === value))]));
    const qualifying = values.filter((value) => buckets[value].sample >= minSample);
    const best = qualifying.length >= 2
      ? qualifying.reduce((current, value) => (buckets[value].brier <= buckets[current].brier ? value : current), qualifying[0]) : null;
    return { buckets, best };
  }

  function stats(sport) {
    const all = [...entries.values()].filter((entry) => entry.sport === sport);
    const resolved = all.filter((entry) => entry.resolved);
    const overall = summarize(resolved);
    const windows = { 10: summarize(resolved.filter((entry) => entry.window === 10)), 20: summarize(resolved.filter((entry) => entry.window === 20)) };
    const bestWindow = windows[10].sample >= MIN_WINDOW_SAMPLE && windows[20].sample >= MIN_WINDOW_SAMPLE
      ? (windows[10].brier <= windows[20].brier ? 10 : 20) : null;
    const biasFactor = overall.sample >= MIN_BIAS_SAMPLE ? Number(overall.bias.toFixed(4)) : 0;
    const { buckets: decays, best: bestDecay } = bestByParam(resolved, 'decay', 1, MIN_DECAY_SAMPLE);
    const { buckets: sosWeights, best: bestSosWeight } = bestByParam(resolved, 'sosWeight', 0.3, MIN_SOS_SAMPLE);
    return { sport, pending: all.length - resolved.length, ...overall, windows, bestWindow, biasFactor, decays, bestDecay, sosWeights, bestSosWeight };
  }

  // Pending predictions whose game should be over (kickoff + `graceMs`, or logged + `graceMs` for
  // entries written before gameDate was recorded). Used to settle games that dropped off the live
  // scoreboard before they could be reconciled there.
  function overdue(sport, { now = Date.now(), graceMs = 4 * 60 * 60 * 1000, limit = 5 } = {}) {
    return [...entries.values()]
      .filter((entry) => entry.sport === sport && !entry.resolved && new Date(entry.gameDate || entry.loggedAt).getTime() + graceMs < now)
      .sort((first, second) => new Date(first.gameDate || first.loggedAt) - new Date(second.gameDate || second.loggedAt))
      .slice(0, limit);
  }

  let pending = Promise.resolve();
  const serialize = (operation) => (...args) => {
    const next = pending.then(() => operation(...args));
    pending = next.catch(() => {});
    return next;
  };
  return { record: persist ? serialize(record) : record, reconcile: persist ? serialize(reconcile) : reconcile, overdue, stats, size: () => entries.size };
}
