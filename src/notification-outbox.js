import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

// Single-process outbox. Persist before sending and acknowledge only after Telegram accepts.
export function createNotificationOutbox({ file = null, send, gapMs = 1100, retryMs = 5000, now = Date.now, logger = console, schedule = true, initialState = null, saveState = null } = {}) {
  let state = initialState ? structuredClone(initialState) : { pending: [], sent: [] };
  if (file && existsSync(file)) {
    state = JSON.parse(readFileSync(file, 'utf8'));
  }
  if (!Array.isArray(state?.pending) || !Array.isArray(state?.sent)
    || state.pending.some((job) => typeof job.id !== 'string' || typeof job.text !== 'string'
      || !Number.isFinite(job.nextAt) || !Number.isInteger(job.attempts) || job.attempts < 0)
    || state.sent.some((id) => typeof id !== 'string')) throw new Error('Invalid Telegram outbox file');
  let running = null;
  let timer = null;
  let closed = false;
  let changes = Promise.resolve();

  function persist(nextState) {
    if (saveState) return saveState(structuredClone(nextState));
    if (!file) return;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, JSON.stringify(nextState), { flush: true });
    renameSync(`${file}.tmp`, file);
  }

  function update(transform) {
    const next = changes.then(async () => {
      const candidate = transform(state);
      if (candidate === state) return;
      await persist(candidate);
      state = candidate;
    });
    changes = next.catch(() => {});
    return next;
  }

  function arm() {
    clearTimeout(timer);
    if (!schedule || closed || !state.pending.length) return;
    const nextAt = state.pending.reduce((earliest, job) => Math.min(earliest, job.nextAt), Infinity);
    const delay = Math.max(0, nextAt - now());
    timer = setTimeout(() => { void flush(); }, Math.min(delay, 2147483647));
    timer.unref?.();
  }

  async function drain() {
    try {
      while (!closed) {
        await changes;
        const job = state.pending.find((item) => item.nextAt <= now());
        if (!job) break;
        let result;
        try { result = await send(job.text); } catch { result = { ok: false, error: 'sender failed' }; }
        if (result.ok) {
          await update((current) => ({ pending: current.pending.filter((item) => item.id !== job.id), sent: [...current.sent, job.id] }));
        } else {
          const attempts = job.attempts + 1;
          const backoff = Math.min(3600000, retryMs * 2 ** Math.min(attempts - 1, 10));
          const nextAt = now() + Math.max(backoff, result.retryAfterMs || 0);
          await update((current) => ({ ...current, pending: current.pending.map((item) => item.id === job.id ? { ...item, attempts, nextAt } : item) }));
          logger.warn?.(`[telegram] send failed; retained for retry (${result.error || 'unavailable'})`);
        }
        if (gapMs > 0) await new Promise((resolve) => setTimeout(resolve, gapMs));
      }
    } catch (error) {
      logger.error?.(`[telegram] outbox persistence failed (${error.code || error.name}); pending messages retained`);
      for (const job of state.pending) job.nextAt = Math.max(job.nextAt, now() + retryMs);
    }
  }

  function flush() {
    if (running) return running;
    clearTimeout(timer);
    running = drain().finally(() => { running = null; arm(); });
    return running;
  }

  return {
    enqueue(id, text) {
      return update((current) => current.sent.includes(id) || current.pending.some((job) => job.id === id)
        ? current : { ...current, pending: [...current.pending, { id, text, attempts: 0, nextAt: now() }] }).then(flush).catch((error) => {
        logger.error?.(`[telegram] could not queue notification (${error.code || error.name})`);
        throw error;
      });
    },
    flush,
    pendingCount: () => state.pending.length,
    close() { closed = true; clearTimeout(timer); },
  };
}
