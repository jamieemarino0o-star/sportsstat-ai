const DAY = 24 * 60 * 60 * 1000;

export function createOddsCache({ store = null, ttlMs = Number(process.env.ODDS_POLL_INTERVAL_MS || 12 * 60 * 60 * 1000), budgetLimit = Number(process.env.ODDS_CREDIT_LIMIT || 400), now = Date.now } = {}) {
  if (!Number.isInteger(ttlMs) || ttlMs < 60000 || ttlMs > 7 * DAY) throw new Error('ODDS_POLL_INTERVAL_MS must be an integer between 60000 and 604800000.');
  if (!Number.isInteger(budgetLimit) || budgetLimit < 0 || budgetLimit > 400) throw new Error('ODDS_CREDIT_LIMIT must be an integer between 0 and 400.');
  const cache = new Map();
  let usage = [];
  let budget = { limit: budgetLimit, windowDays: 31, used: store ? null : 0, remaining: store ? null : budgetLimit, nextReleaseAt: null };
  const unavailable = (message) => Object.assign(new Error(message), { code: 'ODDS_UNAVAILABLE', status: 503 });
  const resultFrom = (result) => ({ data: result.data, time: Date.parse(result.time), remaining: result.providerRemaining });

  function localClaim(key) {
    const time = now();
    usage = usage.filter((timestamp) => timestamp > time - 31 * DAY);
    for (const [cachedKey, value] of cache) if (Math.max(value.time || 0, value.retryAt || 0) < time - 7 * DAY) cache.delete(cachedKey);
    const summarize = () => ({ limit: budgetLimit, windowDays: 31, used: usage.length, remaining: Math.max(0, budgetLimit - usage.length), nextReleaseAt: usage.length ? new Date(usage[0] + 31 * DAY).toISOString() : null });
    const hit = cache.get(key);
    if (hit?.time != null && time - hit.time < ttlMs) return { state: 'cached', budget: summarize(), data: hit.data, time: new Date(hit.time).toISOString(), providerRemaining: hit.remaining };
    if (hit?.retryAt > time) return { state: 'waiting', budget: summarize() };
    if (usage.length >= budgetLimit) return { state: 'budget', budget: summarize() };
    usage.push(time);
    cache.set(key, { retryAt: time + 2 * 60 * 1000 });
    return { state: 'reserved', budget: summarize() };
  }

  return {
    ttlMs,
    status: () => ({ durable: Boolean(store), intervalMs: ttlMs, ...budget }),
    async get(key, load) {
      const claim = store ? await store.claimOdds(key, ttlMs, budgetLimit) : localClaim(key);
      budget = claim.budget;
      if (claim.state === 'cached') return resultFrom(claim);
      if (claim.state === 'budget') throw unavailable('Odds refresh paused: the 31-day credit budget is exhausted.');
      if (claim.state === 'waiting') throw unavailable('Odds refresh already reserved or temporarily paused after a failure.');
      if (claim.state !== 'reserved') throw unavailable('Odds reservation unavailable.');
      let loaded = false;
      try {
        const result = await load();
        loaded = true;
        if (store) return resultFrom(await store.completeOdds(key, claim.reservationId, result.data, result.remaining));
        cache.set(key, result);
        return result;
      } catch (error) {
        if (!loaded) {
          if (store) {
            try { await store.completeOdds(key, claim.reservationId, null, null); } catch {}
          } else cache.set(key, { retryAt: now() + 15 * 60 * 1000 });
        }
        throw error;
      }
    },
  };
}