// Backs the app up to a Google Sheet through an Apps Script web app (see apps-script/).
// Sets, bins, sorted pieces, each set's parts list (in compact chunks) and a few settings are synced,
// so a new device or a cleared browser restores without asking Rebrickable again.
// Newest "updated" time wins per record.
import * as db from './db.js';

const TABLES = ['sets', 'bins', 'inventory'];
const SETTING_KEYS = ['categoryMap', 'partOverrides', 'recentColors', 'lastColor', 'dailyGoal', 'badgesSeen', 'goalDay', 'swatch', 'swatchDefault', 'includeFigs', 'orderFormat'];
const CHUNK = 400;
const CELL = 38000; // a sheet cell holds 50,000 characters; parts chunks stay well under
const BATCH_BYTES = 2_000_000;

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

// Sends any request to the user's Apps Script (used by the camera as a fallback route).
export async function callScript(payload) {
  const cfg = await getConfig();
  if (!cfg.url || !cfg.token) throw new Error('Google Sheet backup is not set up.');
  return call(cfg, payload);
}

export async function test(cfg) {
  return call(cfg, { action: 'ping' });
}

// The activity log needs the newer script. Until the script says it understands it (v >= 2),
// log entries are held back, not sent and not marked as sent.
const scriptHasLog = async () => Number((await db.getSetting('scriptV')) || 0) >= 2;
const scriptHasParts = async () => Number((await db.getSetting('scriptV')) || 0) >= 3;

// ---------- parts lists ----------

const defaultImg = (pn, cid) => `https://cdn.rebrickable.com/media/parts/ldraw/${cid}/${encodeURIComponent(pn)}.png`;
const packLine = (l) => [l.part_num, l.name, l.cat_id ?? null, l.color_id, l.qty, l.element_id || 0, l.sticker ? 1 : 0, l.img && l.img !== defaultImg(l.part_num, l.color_id) ? l.img : 0, l.figs?.length ? [l.fig_qty || 0, ...l.figs] : 0];

// A set's parts as chunk records, each small enough for one sheet cell.
function chunkParts(setNum, at, rows) {
  const groups = [];
  let cur = [];
  let size = 0;
  for (const l of rows) {
    const a = packLine(l);
    const n = JSON.stringify(a).length + 1;
    if (cur.length && size + n > CELL - 3000) { groups.push(cur); cur = []; size = 0; } // room for the colour and category names
    cur.push([a, l]); size += n;
  }
  if (cur.length) groups.push(cur);
  return groups.map((g, i) => {
    const colors = {};
    const cats = {};
    for (const [, l] of g) {
      colors[l.color_id] = [l.color_name, l.rgb, l.is_trans ? 1 : 0];
      if (l.cat_id != null) cats[l.cat_id] = l.cat_name;
    }
    return { id: `${setNum}#${i}`, set_num: setNum, chunk: i, chunks: groups.length, parts_at: at, updated: at, deleted: false, colors, cats, lines: g.map(([a]) => a) };
  });
}

async function pendingParts() {
  if (!(await scriptHasParts())) return [];
  const synced = (await db.getSetting('partsSynced')) || {};
  const out = [];
  for (const s of (await db.all('sets')).filter((x) => !x.deleted)) {
    const at = s.parts_at || s.added || '';
    if (!at || synced[s.set_num] === at) continue;
    const rows = await db.byIndex('setParts', 'set_num', s.set_num);
    if (!rows.length) continue;
    out.push({ set_num: s.set_num, at, recs: chunkParts(s.set_num, at, rows) });
  }
  return out;
}

// Rebuilds parts lists from chunks pulled from the sheet, for sets that have none here.
async function applyParts(recs) {
  const partial = (await db.getSetting('partsPartial')) || {};
  for (const r of recs) partial[r.id] = r;
  const bySet = new Map();
  for (const r of Object.values(partial)) {
    if (!bySet.has(r.set_num)) bySet.set(r.set_num, []);
    bySet.get(r.set_num).push(r);
  }
  const synced = (await db.getSetting('partsSynced')) || {};
  let restored = 0;
  for (const [setNum, all] of bySet) {
    const at = all.reduce((m, r) => (r.parts_at > m ? r.parts_at : m), '');
    const mine = all.filter((r) => r.parts_at === at);
    const total = mine[0].chunks;
    const set = await db.get('sets', setNum);
    if (!set || set.deleted) { for (const r of all) delete partial[r.id]; continue; }
    if (new Set(mine.map((r) => r.chunk)).size < total) continue; // the rest has not arrived yet
    for (const r of all) delete partial[r.id];
    if ((await db.byIndex('setParts', 'set_num', setNum)).length) continue; // already have it
    const lines = [];
    for (const r of mine.sort((a, b) => a.chunk - b.chunk)) {
      for (const [part_num, name, cat_id, color_id, qty, element_id, sticker, img, fig] of r.lines) {
        const [cname, rgb, trans] = (r.colors && r.colors[color_id]) || [`Colour ${color_id}`, '999999', 0];
        lines.push({
          id: `${setNum}|${part_num}|${color_id}`, set_num: setNum, part_num, name, cat_id,
          cat_name: (r.cats && r.cats[cat_id]) || 'Other', img: img || null, color_id,
          color_name: cname, rgb: /^[0-9a-f]{6}$/i.test(rgb || '') ? rgb : '999999',
          is_trans: !!trans, qty, element_id: element_id || null, sticker: !!sticker,
          ...(Array.isArray(fig) ? { fig_qty: fig[0], figs: fig.slice(1) } : {}),
        });
      }
    }
    await db.putMany('setParts', lines);
    synced[setNum] = at;
    restored++;
  }
  await db.setSetting('partsPartial', partial);
  await db.setSetting('partsSynced', synced);
  return restored;
}

async function pendingRecords(since) {
  const out = { sets: [], bins: [], inventory: [], settings: [], log: [], setparts: [] };
  for (const t of TABLES) out[t] = (await db.all(t)).filter((r) => (r.updated || '') > since);
  if (await scriptHasLog()) {
    const logSince = (await db.getSetting('lastLogPushAt')) || '';
    out.log = (await db.all('log')).filter((r) => (r.updated || '') > logSince);
  }
  out.partsSets = await pendingParts();
  out.setparts = out.partsSets.flatMap((x) => x.recs);
  for (const k of SETTING_KEYS) {
    const row = await db.get('kv', k);
    if (row && (row.updated || '') > since) out.settings.push(row);
  }
  return out;
}

export async function countPending() {
  const since = (await db.getSetting('lastPushAt')) || '';
  const p = await pendingRecords(since);
  state.pending = p.sets.length + p.bins.length + p.inventory.length + p.settings.length + p.log.length + p.partsSets.length;
  return state.pending;
}

let restoredParts = 0;
async function apply(pulled) {
  let n = 0;
  db.setQuiet(true);
  try {
    for (const t of [...TABLES, 'log']) {
      for (const rec of pulled[t] || []) {
        const key = t === 'sets' ? rec.set_num : rec.id;
        const local = await db.get(t, key);
        if (local && (local.updated || '') >= (rec.updated || '')) continue;
        await db.put(t, rec);
        if (t === 'sets' && rec.deleted) await db.delByIndex('setParts', 'set_num', rec.set_num);
        n++;
      }
    }
    if ((pulled.setparts || []).length || Object.keys((await db.getSetting('partsPartial')) || {}).length) {
      const k = await applyParts(pulled.setparts || []);
      restoredParts += k;
      n += k;
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
    const hadLog = await scriptHasLog();

    const flat = [];
    for (const t of [...TABLES, 'settings', 'log', 'setparts']) for (const rec of pending[t]) flat.push([t, rec]);
    const batches = [];
    let cur = [];
    let bytes = 0;
    for (const item of flat) {
      const n = item[0] === 'setparts' ? JSON.stringify(item[1]).length : 600;
      if (cur.length && (cur.length >= CHUNK || bytes + n > BATCH_BYTES)) { batches.push(cur); cur = []; bytes = 0; }
      cur.push(item); bytes += n;
    }
    if (cur.length) batches.push(cur);
    if (!batches.length) batches.push([]);
    restoredParts = 0;

    let pushed = 0;
    let pulledCount = 0;
    for (const batch of batches) {
      const changes = { sets: [], bins: [], inventory: [], settings: [], log: [], setparts: [] };
      for (const [t, rec] of batch) changes[t].push(rec);
      const res = await call(cfg, { since: Number((await db.getSetting('syncSeq')) || 0), changes });
      pushed += batch.length;
      pulledCount += await apply(res.changes || {});
      seq = res.seq;
      if (res.v > Number((await db.getSetting('scriptV')) || 0)) { await db.setSetting('scriptV', res.v); schedule(500); }
      await db.setSetting('syncSeq', seq);
    }
    if (pending.partsSets.length && (await scriptHasParts())) {
      const synced = (await db.getSetting('partsSynced')) || {};
      for (const x of pending.partsSets) synced[x.set_num] = x.at;
      await db.setSetting('partsSynced', synced);
    }
    await db.setSetting('lastPushAt', startedAt);
    if (hadLog) await db.setSetting('lastLogPushAt', startedAt);
    state.lastAt = new Date().toISOString();
    await db.setSetting('lastSyncAt', state.lastAt);
    await countPending();
    return { pushed, pulled: pulledCount, partsRestored: restoredParts };
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
  await db.setSetting('lastLogPushAt', '');
  await db.setSetting('syncSeq', 0);
  await db.setSetting('partsSynced', {});
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
