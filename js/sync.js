// Backs the app up to a Google Sheet through an Apps Script web app (see apps-script/).
// Sets, bins, sorted pieces and a few settings are synced. Parts lists are not: they are
// re-downloaded from Rebrickable on a new device. Newest "updated" time wins per record.
import * as db from './db.js';

const TABLES = ['sets', 'bins', 'inventory'];
const SETTING_KEYS = ['categoryMap', 'partOverrides', 'recentColors', 'lastColor'];
const CHUNK = 400;

export const state = { running: false, error: '', lastAt: '', pending: 0 };
const listeners = new Set();
export const onState = (fn) => { listeners.add(fn); };
const emit = () => { for (const fn of listeners) { try { fn(state); } catch { /* ignore */ } } };

export async function getConfig() {
  return {
    url: (await db.getSetting('syncUrl')) || '',
    token: (await db.getSetting('syncToken')) || '',
  };
}

export async function isConfigured() {
  const c = await getConfig();
  return !!(c.url && c.token);
}

export function makeSecretCode() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function call(cfg, payload) {
  let res;
  try {
    // text/plain avoids a CORS pre-flight request, which Apps Script cannot answer.
    res = await fetch(cfg.url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ token: cfg.token, ...payload }),
    });
  } catch {
    throw new Error("Couldn't reach the sheet. Check your connection and the web app address.");
  }
  let json;
  try {
    json = await res.json();
  } catch {
    throw new Error('The address did not answer like the Brick Sorter script. Check you copied the web app URL and that access is set to Anyone.');
  }
  if (!json.ok) throw new Error(json.error || 'The sheet reported an error.');
  return json;
}

export async function test(cfg) {
  return call(cfg, { action: 'ping' });
}

async function pendingRecords(since) {
  const out = { sets: [], bins: [], inventory: [], settings: [] };
  for (const t of TABLES) out[t] = (await db.all(t)).filter((r) => (r.updated || '') > since);
  for (const k of SETTING_KEYS) {
    const row = await db.get('kv', k);
    if (row && (row.updated || '') > since) out.settings.push(row);
  }
  return out;
}

export async function countPending() {
  const since = (await db.getSetting('lastPushAt')) || '';
  const p = await pendingRecords(since);
  state.pending = p.sets.length + p.bins.length + p.inventory.length + p.settings.length;
  return state.pending;
}

async function apply(pulled) {
  let n = 0;
  db.setQuiet(true);
  try {
    for (const t of TABLES) {
      for (const rec of pulled[t] || []) {
        const key = t === 'sets' ? rec.set_num : rec.id;
        const local = await db.get(t, key);
        if (local && (local.updated || '') >= (rec.updated || '')) continue;
        await db.put(t, rec);
        if (t === 'sets' && rec.deleted) await db.delByIndex('setParts', 'set_num', rec.set_num);
        n++;
      }
    }
    for (const rec of pulled.settings || []) {
      if (!SETTING_KEYS.includes(rec.key)) continue;
      const local = await db.get('kv', rec.key);
      if (local && (local.updated || '') >= (rec.updated || '')) continue;
      await db.put('kv', rec);
      n++;
    }
  } finally {
    db.setQuiet(false);
  }
  return n;
}

// One full round trip: send what changed here, receive what changed elsewhere.
// Returns { pushed, pulled }.
export async function syncNow() {
  if (state.running) return null;
  const cfg = await getConfig();
  if (!cfg.url || !cfg.token) throw new Error('Set up the Google Sheet in Settings first.');
  state.running = true;
  state.error = '';
  emit();
  try {
    const startedAt = new Date().toISOString();
    const since = (await db.getSetting('lastPushAt')) || '';
    let seq = Number((await db.getSetting('syncSeq')) || 0);
    const pending = await pendingRecords(since);

    const flat = [];
    for (const t of [...TABLES, 'settings']) for (const rec of pending[t]) flat.push([t, rec]);
    const batches = [];
    for (let i = 0; i < flat.length; i += CHUNK) batches.push(flat.slice(i, i + CHUNK));
    if (!batches.length) batches.push([]);

    let pushed = 0;
    let pulledCount = 0;
    for (const batch of batches) {
      const changes = { sets: [], bins: [], inventory: [], settings: [] };
      for (const [t, rec] of batch) changes[t].push(rec);
      const res = await call(cfg, { since: Number((await db.getSetting('syncSeq')) || 0), changes });
      pushed += batch.length;
      pulledCount += await apply(res.changes || {});
      seq = res.seq;
      await db.setSetting('syncSeq', seq);
    }
    await db.setSetting('lastPushAt', startedAt);
    state.lastAt = new Date().toISOString();
    await db.setSetting('lastSyncAt', state.lastAt);
    await countPending();
    return { pushed, pulled: pulledCount };
  } catch (e) {
    state.error = e.message || String(e);
    throw e;
  } finally {
    state.running = false;
    emit();
  }
}

// Forget the sync position so the next sync sends everything and pulls everything.
export async function resetCursor() {
  await db.setSetting('lastPushAt', '');
  await db.setSetting('syncSeq', 0);
}

// ---------- automatic syncing ----------

let timer = null;
let onDone = null;

export function startAuto(afterSync) {
  onDone = afterSync || null;
  db.onChange((store) => {
    if (store === 'kv') return; // only real changes; settings ride along on the next sync
    schedule(4000);
  });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') schedule(500); });
  window.addEventListener('online', () => schedule(1000));
  schedule(1500);
}

export function schedule(ms) {
  clearTimeout(timer);
  timer = setTimeout(runAuto, ms);
}

async function runAuto() {
  if (state.running || !navigator.onLine || !(await isConfigured())) { await countPending().catch(() => {}); emit(); return; }
  try {
    const r = await syncNow();
    if (r && onDone) await onDone(r);
  } catch { /* the error is kept in state for the header and Settings */ }
}
