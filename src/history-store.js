import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const PAGE_SIZE = 500;
const canonical = (record) => JSON.stringify(record, Object.keys(record).sort());
const recordId = (record) => createHash('sha256').update(canonical(record)).digest('hex');
const signature = ({ updatedAt, ...record }) => canonical(record);
const recordTime = (record) => Date.parse(record.resolvedAt || record.updatedAt || record.loggedAt) || 0;
const chronological = (records) => [...records].sort((first, second) => recordTime(first) - recordTime(second)
  || Number(first.type === 'result') - Number(second.type === 'result'));

export function readLocalRecords(file) {
  return readFileSync(file, 'utf8').split('\n').filter((line) => line.trim()).map((line, index) => {
    let record;
    try { record = JSON.parse(line); } catch { throw new Error(`Invalid ledger JSON at record ${index + 1}`); }
    if (!record?.sport || !record.eventId || !['prediction', 'result'].includes(record.type)) throw new Error(`Invalid ledger record ${index + 1}`);
    return record;
  });
}

export function createHistoryStore({ env = process.env, client = null } = {}) {
  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url && !key && !client) {
    if (env.RENDER === 'true') throw new Error('Durable history is required on Render. Configure SUPABASE_URL and SUPABASE_SECRET_KEY before deploying.');
    return null;
  }
  if (!client && (!url || !key)) throw new Error('Set both SUPABASE_URL and SUPABASE_SECRET_KEY on the server.');
  const database = client || createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: (input, options = {}) => fetch(input, { ...options, signal: options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) }) },
  });
  let records = [];
  let lastError = null;
  let lastSavedAt = null;
  let lastLoadedAt = null;
  const latest = new Map();
  let pending = Promise.resolve();
  const serialize = (operation) => (...args) => {
    const next = pending.then(() => operation(...args));
    pending = next.catch(() => {});
    return next;
  };

  async function request(operation) {
    try {
      const response = await operation();
      if (response.error) throw new Error('Database request failed');
      lastError = null;
      return response.data;
    } catch {
      lastError = 'History storage unavailable. Check Supabase project status, credentials, schema and quota.';
      throw Object.assign(new Error(lastError), { status: 503, code: 'HISTORY_STORAGE_UNAVAILABLE' });
    }
  }

  return {
    status: () => ({ backend: 'supabase', durable: true, lastSavedAt, lastLoadedAt, error: lastError }),
    cachedRecords: () => [...records],
    readRecords: serialize(async () => {
      const loaded = [];
      for (let offset = 0; ; offset += PAGE_SIZE) {
        const page = await request(() => database.from('prediction_records').select('payload').order('sequence', { ascending: true }).range(offset, offset + PAGE_SIZE - 1));
        if (!Array.isArray(page)) throw new Error('Invalid history storage response');
        loaded.push(...page.map((row) => row.payload));
        if (page.length < PAGE_SIZE) break;
      }
      records = chronological(loaded);
      latest.clear();
      for (const record of records) latest.set(`${record.sport}:${record.eventId}`, record);
      lastLoadedAt = new Date().toISOString();
      return [...records];
    }),
    append: serialize(async (record, { importing = false } = {}) => {
      const eventKey = `${record.sport}:${record.eventId}`;
      const previous = latest.get(eventKey);
      if (!importing && previous && signature(previous) === signature(record)) return;
      await request(() => database.from('prediction_records').upsert({ id: recordId(record), payload: record }, { onConflict: 'id', ignoreDuplicates: true }));
      records.push(record);
      if (!previous || recordTime(record) >= recordTime(previous)) latest.set(eventKey, record);
      lastSavedAt = new Date().toISOString();
    }),
    async readOutbox() {
      const row = await request(() => database.from('notification_state').select('payload').eq('id', 'telegram').maybeSingle());
      return row?.payload || { pending: [], sent: [] };
    },
    async saveOutbox(state) {
      await request(() => database.from('notification_state').upsert({ id: 'telegram', payload: state }));
    },
  };
}

export async function configuredLedgerSource(file) {
  const storage = createHistoryStore();
  return storage ? storage.readRecords() : file;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, filename] = process.argv.slice(2);
    if (!['import', 'export'].includes(command) || !filename) throw new Error('Usage: npm run history:import -- path/to/predictions.jsonl OR npm run history:export -- path/to/backup.jsonl');
    const storage = createHistoryStore();
    if (!storage) throw new Error('Configure Supabase in .env before importing or exporting cloud history.');
    if (command === 'import') {
      const records = chronological(readLocalRecords(filename));
      for (const record of records) await storage.append(record, { importing: true });
      console.log(`Imported ${records.length} records. Repeating this import is safe; identical records are not duplicated.`);
    } else {
      const records = await storage.readRecords();
      writeFileSync(filename, records.map((record) => JSON.stringify(record)).join('\n') + (records.length ? '\n' : ''), { flag: 'wx', mode: 0o600 });
      console.log(`Exported ${records.length} records to ${filename}.`);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}