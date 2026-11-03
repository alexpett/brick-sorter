// Bin logic: active bins (one per set being rebuilt), storage bins, and where each piece goes.
import * as db from './db.js';

const nowIso = () => new Date().toISOString();
const EPOCH = '1970-01-01T00:00:00.000Z';

export const uid = () => globalThis.crypto?.randomUUID?.()
  ?? `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

export const STORAGE_DEFAULTS = [
  { id: 'dots', label: 'Dots', desc: '1x1 plates and flowers', order: 1 },
  { id: 'plates', label: 'Plates', desc: 'Other flat plates', order: 2 },
  { id: 'bricks', label: 'Bricks', desc: 'Bricks, slopes and arches', order: 3 },
  { id: 'oddments', label: 'Oddments', desc: 'Anything that does not fit elsewhere', order: 4 },
  { id: 'unrecognised', label: 'Unrecognised', desc: 'Pieces you could not identify', order: 5, locked: true },
];

export async function ensureDefaultBins() {
  const existing = await db.all('bins');
  const have = new Set(existing.map((b) => b.id));
  const now = nowIso();
  // A wipe soft-deletes the default bins; bring them back.
  const revive = existing.filter((b) => b.deleted && STORAGE_DEFAULTS.some((d) => d.id === b.id))
    .map((b) => ({ ...b, deleted: false, updated: now }));
  if (revive.length) await db.putMany('bins', revive);
  const missing = STORAGE_DEFAULTS.filter((d) => !have.has(d.id)).map((d) => ({
    id: d.id,
    type: 'storage',
    label: d.label,
    desc: d.desc,
    order: d.order,
    locked: !!d.locked,
    number: null,
    set_num: null,
    created: now,
    updated: EPOCH, // oldest possible, so a version restored from the sheet always wins
    deleted: false,
  }));
  if (missing.length) await db.putMany('bins', missing);
}

export async function getBins() {
  return (await db.all('bins')).filter((b) => !b.deleted);
}

export function binLabel(bin, setsByNum) {
  if (bin.type !== 'active') return bin.label;
  const s = setsByNum?.get(bin.set_num);
  return s ? `Bin ${bin.number} · ${s.name}` : `Bin ${bin.number}`;
}

export const sumQty = (lines) => lines.reduce((n, l) => n + l.qty, 0);

// Active bins are only created when a set is activated. The lowest free number is used.
export async function activateSet(setNum) {
  const rec = await db.get('sets', setNum);
  if (!rec || rec.deleted) throw new Error('Set not found.');
  if (rec.status === 'active') throw new Error('This set already has a bin.');
  const used = new Set((await getBins()).filter((b) => b.type === 'active').map((b) => b.number));
  let number = 1;
  while (used.has(number)) number++;
  const now = nowIso();
  const bin = {
    id: `act-${uid()}`,
    type: 'active',
    number,
    label: `Bin ${number}`,
    set_num: setNum,
    order: number,
    locked: false,
    created: now,
    updated: now,
    deleted: false,
  };
  await db.put('bins', bin);
  await db.put('sets', { ...rec, status: 'active', active_bin: number, bin_id: bin.id, priority: number, updated: now });
  return bin;
}

export async function binLines(binId) {
  return (await db.byIndex('inventory', 'bin_id', binId)).filter((l) => !l.deleted);
}

// Deletes every piece sorted into an active bin, removes the bin, and returns the set to the catalogue.
export async function abandonBin(binId) {
  const bin = await db.get('bins', binId);
  if (!bin || bin.deleted || bin.type !== 'active') throw new Error('Bin not found.');
  const now = nowIso();
  const lines = await binLines(binId);
  await db.putMany('inventory', lines.map((l) => ({ ...l, deleted: true, updated: now })));
  await db.put('bins', { ...bin, deleted: true, updated: now });
  const rec = await db.get('sets', bin.set_num);
  if (rec && !rec.deleted) {
    await db.put('sets', { ...rec, status: 'catalogued', active_bin: null, bin_id: null, priority: null, updated: now });
  }
  return { pieces: sumQty(lines), lines: lines.length };
}

// Everything the sorting rules need, read once.
export async function loadContext() {
  const [bins, sets, inv, catMap, overrides] = await Promise.all([
    getBins(),
    db.all('sets'),
    db.all('inventory'),
    db.getSetting('categoryMap'),
    db.getSetting('partOverrides'),
  ]);
  const live = inv.filter((l) => !l.deleted);
  const byBin = new Map();
  for (const l of live) {
    if (!byBin.has(l.bin_id)) byBin.set(l.bin_id, []);
    byBin.get(l.bin_id).push(l);
  }
  const setsByNum = new Map(sets.filter((s) => !s.deleted).map((s) => [s.set_num, s]));
  const active = [];
  for (const bin of bins.filter((b) => b.type === 'active').sort((a, b) => a.number - b.number)) {
    const set = setsByNum.get(bin.set_num);
    if (!set) continue;
    const need = new Map();
    let neededTotal = 0;
    for (const l of await db.byIndex('setParts', 'set_num', bin.set_num)) {
      need.set(`${l.part_num}|${l.color_id}`, l.qty);
      neededTotal += l.qty;
    }
    const held = new Map();
    for (const l of byBin.get(bin.id) || []) {
      const k = `${l.part_num}|${l.color_id}`;
      held.set(k, (held.get(k) || 0) + l.qty);
    }
    let heldTotal = 0;
    for (const [k, q] of held) heldTotal += Math.min(q, need.get(k) || 0);
    active.push({ bin, set, need, held, neededTotal, heldTotal, frac: neededTotal ? heldTotal / neededTotal : 0 });
  }
  return { bins, sets, setsByNum, byBin, active, catMap: catMap || {}, overrides: overrides || {} };
}

// Decides where qty pieces of one part and colour go. The most complete set is filled first,
// and equally complete sets are filled in bin-number order. A bin never takes more than its
// set still needs; anything left over goes to storage.
export function allocate(ctx, partNum, colorId, qty) {
  const key = `${partNum}|${colorId}`;
  const candidates = ctx.active
    .map((a) => ({ a, remaining: (a.need.get(key) || 0) - (a.held.get(key) || 0) }))
    .filter((c) => c.remaining > 0)
    .sort((x, y) => y.a.frac - x.a.frac || x.a.bin.number - y.a.bin.number);
  let left = qty;
  const allocations = [];
  for (const c of candidates) {
    if (left <= 0) break;
    const take = Math.min(left, c.remaining);
    allocations.push({
      bin: c.a.bin,
      set: c.a.set,
      qty: take,
      need: c.a.need.get(key),
      heldBefore: c.a.held.get(key) || 0,
    });
    left -= take;
  }
  return { allocations, storageQty: left };
}

// Storage bin for a part: a rule for that exact part wins, then the rule for its category.
// Returns null when nothing has been chosen yet, so the app can ask.
export function resolveStorage(ctx, part) {
  const valid = (id) => !!id && ctx.bins.some((b) => b.id === id && b.type === 'storage' && !b.locked);
  const byPart = ctx.overrides[part.part_num];
  if (valid(byPart)) return byPart;
  const byCat = part.cat_id != null ? ctx.catMap[String(part.cat_id)] : null;
  return valid(byCat) ? byCat : null;
}

export async function rememberStorage({ part, binId, scope, ctx }) {
  if (scope === 'category' && part.cat_id != null) {
    ctx.catMap = { ...ctx.catMap, [String(part.cat_id)]: binId };
    await db.setSetting('categoryMap', ctx.catMap);
  } else {
    ctx.overrides = { ...ctx.overrides, [part.part_num]: binId };
    await db.setSetting('partOverrides', ctx.overrides);
  }
}

export async function removeRule(kind, key) {
  const name = kind === 'category' ? 'categoryMap' : 'partOverrides';
  const map = { ...((await db.getSetting(name)) || {}) };
  delete map[key];
  await db.setSetting(name, map);
}

// items: [{ binId, qty }]. Identical pieces in the same bin are merged into one line.
export async function saveToBins({ part, color, flags, note, items, log = true }) {
  const now = nowIso();
  if (log) {
    for (const it of items) {
      await db.put('log', { id: uid(), t: now, qty: it.qty, part_num: part.part_num || '', bin_id: it.binId, updated: now, deleted: false });
    }
  }
  for (const it of items) {
    const lines = await binLines(it.binId);
    const same = lines.find((l) => l.part_num === part.part_num && l.color_id === color.id
      && !!l.sticker === !!flags.sticker && !!l.printed === !!flags.printed && !!l.other === !!flags.other
      && (l.note || '') === (note || ''));
    if (same) {
      await db.put('inventory', { ...same, qty: same.qty + it.qty, updated: now });
    } else {
      await db.put('inventory', {
        id: uid(),
        part_num: part.part_num,
        name: part.name,
        cat_id: part.cat_id ?? null,
        color_id: color.id,
        color_name: color.name,
        rgb: color.rgb,
        qty: it.qty,
        bin_id: it.binId,
        sticker: !!flags.sticker,
        printed: !!flags.printed,
        other: !!flags.other,
        note: note || '',
        created: now,
        updated: now,
        deleted: false,
      });
    }
  }
}

export async function addStorageBin(label) {
  const clean = label.trim().slice(0, 30);
  if (!clean) throw new Error('Give the bin a name.');
  const bins = await getBins();
  if (bins.some((b) => b.type === 'storage' && b.label.toLowerCase() === clean.toLowerCase())) {
    throw new Error('A storage bin with that name already exists.');
  }
  const now = nowIso();
  const order = Math.max(0, ...bins.filter((b) => b.type === 'storage').map((b) => b.order || 0)) + 1;
  const bin = { id: `st-${uid()}`, type: 'storage', label: clean, desc: '', order, locked: false, number: null, set_num: null, created: now, updated: now, deleted: false };
  await db.put('bins', bin);
  return bin;
}

export async function renameStorageBin(binId, label) {
  const clean = label.trim().slice(0, 30);
  if (!clean) throw new Error('Give the bin a name.');
  const bin = await db.get('bins', binId);
  if (!bin || bin.type !== 'storage' || bin.locked) throw new Error('That bin cannot be renamed.');
  await db.put('bins', { ...bin, label: clean, updated: nowIso() });
}

export async function deleteStorageBin(binId) {
  const bin = await db.get('bins', binId);
  if (!bin || bin.type !== 'storage' || bin.locked) throw new Error('That bin cannot be deleted.');
  if ((await binLines(binId)).length) throw new Error('Empty the bin before deleting it.');
  await db.put('bins', { ...bin, deleted: true, updated: nowIso() });
}

// How much of a set's parts list is already sitting in storage bins (for the pick list).
export async function storageMatches(ctx, setNum) {
  const stock = new Map();
  for (const b of ctx.bins.filter((x) => x.type === 'storage')) {
    for (const l of ctx.byBin.get(b.id) || []) {
      if (!l.part_num) continue;
      const k = `${l.part_num}|${l.color_id}`;
      stock.set(k, (stock.get(k) || 0) + l.qty);
    }
  }
  let lines = 0;
  let pieces = 0;
  for (const p of await db.byIndex('setParts', 'set_num', setNum)) {
    const have = Math.min(p.qty, stock.get(`${p.part_num}|${p.color_id}`) || 0);
    if (have > 0) { lines++; pieces += have; }
  }
  return { lines, pieces };
}

// ---------- bin colours ----------

export const BIN_COLORS = ['#b3261e', '#d9622b', '#e0a800', '#2e8b4f', '#1f9a9a', '#2a6fc4', '#6a4fc4', '#b0489c', '#7a5a3a', '#5b6b7a', '#222222', '#8a8f98'];

export function chipStyle(bin) {
  const hex = bin?.color;
  if (!/^#[0-9a-f]{6}$/i.test(hex || '')) return '';
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const light = (0.299 * r + 0.587 * g + 0.114 * b) > 160;
  return ` style="background:${hex};color:${light ? '#1d1b1a' : '#ffffff'}"`;
}

export async function setBinColor(binId, hex) {
  const bin = await db.get('bins', binId);
  if (!bin || bin.deleted) throw new Error('Bin not found.');
  await db.put('bins', { ...bin, color: hex || null, updated: nowIso() });
}
