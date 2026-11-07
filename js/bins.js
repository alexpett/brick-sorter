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

// Decides where qty pieces of one part and colour go. If one active bin can take them all, the
// most complete such set gets them all (no split). Otherwise the most complete set is filled
// first, equally complete sets in bin-number order. A bin never takes more than its set still
// needs; anything left over goes to storage.
export function allocate(ctx, partNum, colorId, qty) {
  const key = `${partNum}|${colorId}`;
  let candidates = ctx.active
    .map((a) => ({ a, remaining: (a.need.get(key) || 0) - (a.held.get(key) || 0) }))
    .filter((c) => c.remaining > 0)
    .sort((x, y) => y.a.frac - x.a.frac || x.a.bin.number - y.a.bin.number);
  const whole = candidates.find((c) => c.remaining >= qty);
  if (whole) candidates = [whole];
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

// ---------- colour rules ----------
// A storage bin may hold only certain colours (its `palette`, a list of colour ids). No palette = any colour.
export const binPalette = (bin) => (Array.isArray(bin?.palette) ? bin.palette.filter((x) => Number.isInteger(x)) : []);
export const acceptsColour = (bin, colorId) => {
  const p = binPalette(bin);
  return !p.length || colorId === null || colorId === undefined || p.includes(colorId);
};

export async function setBinPalette(binId, ids) {
  const bin = await db.get('bins', binId);
  if (!bin || bin.deleted || bin.type !== 'storage' || bin.locked) throw new Error('That bin cannot have a colour rule.');
  const list = [...new Set((ids || []).filter((x) => Number.isInteger(x)))];
  await db.put('bins', { ...bin, palette: list.length ? list : null, updated: nowIso() });
}

// How many pieces of each category are in each storage bin (what the bin already holds).
function catHeld(ctx) {
  if (!ctx._catHeld) {
    const m = new Map();
    for (const [binId, lines] of ctx.byBin) {
      const c = new Map();
      for (const l of lines) if (l.cat_id != null) c.set(l.cat_id, (c.get(l.cat_id) || 0) + l.qty);
      m.set(binId, c);
    }
    ctx._catHeld = m;
  }
  return ctx._catHeld;
}

// Storage bin for a part (in a colour). A rule for that exact part wins, then bins whose colour rule
// lists this colour and that already hold the category, then the category’s usual bin, then any bin
// whose colour rule lists this colour. A bin whose colour rule leaves the colour out is never chosen.
// Returns null when nothing fits, so the app can ask.
export function resolveStorage(ctx, part, colorId = null) {
  const stores = ctx.bins.filter((b) => b.type === 'storage' && !b.deleted && !b.locked && !b.full);
  const ok = (b) => acceptsColour(b, colorId);
  const byId = (id) => stores.find((b) => b.id === id);
  const ob = byId(ctx.overrides[part.part_num]);
  if (ob && ok(ob)) return ob.id;
  const cat = part.cat_id ?? null;
  const catBinId = cat !== null ? ctx.catMap[String(cat)] : null;
  const held = (b) => (cat !== null ? (catHeld(ctx).get(b.id)?.get(cat) || 0) : 0);
  const fits = colorId !== null && colorId !== undefined ? stores.filter((b) => binPalette(b).includes(colorId)) : [];
  const related = fits.filter((b) => b.id === catBinId || held(b) > 0)
    .sort((x, y) => (y.id === catBinId) - (x.id === catBinId) || held(y) - held(x) || binPalette(x).length - binPalette(y).length);
  if (related.length) return related[0].id;
  const cb = byId(catBinId);
  if (cb && ok(cb)) return cb.id;
  const pure = fits.sort((x, y) => binPalette(x).length - binPalette(y).length);
  return pure.length ? pure[0].id : null;
}

// The bin a rule points at even if it is full (so the app can say "X is full").
export function ruleBinId(ctx, part) {
  const ok = (id) => !!id && ctx.bins.some((b) => b.id === id && b.type === 'storage' && !b.locked);
  const byPart = ctx.overrides[part.part_num];
  if (ok(byPart)) return byPart;
  const byCat = part.cat_id != null ? ctx.catMap[String(part.cat_id)] : null;
  return ok(byCat) ? byCat : null;
}

// Mark a storage bin full (nothing more is suggested or accepted) or open it again.
export async function setBinFull(binId, full) {
  const bin = await db.get('bins', binId);
  if (!bin || bin.deleted || bin.type !== 'storage' || bin.locked) throw new Error('That bin cannot be marked full.');
  await db.put('bins', { ...bin, full: !!full, updated: nowIso() });
}

const RECENT_WINDOW = 5; // how many recent choices in a category are looked at
const RECENT_NEEDED = 3; // how many of them must agree before the category rule changes

// Called after pieces are saved into one storage bin. Keeps a small history of choices and lets
// the rules follow what you actually do:
//  - no rule yet: remember the choice for the category
//  - you chose a different bin from the suggestion: that part now goes there, and if most of the
//    recent pieces in the category went there too, the category rule moves as well
//  - you chose the category’s usual bin again: the part’s own exception is dropped
// Returns a short sentence for the "Saved" toast, or ''.
export async function learnStorage({ part, chosenId, suggestedId, ctx, catName, colorId = null }) {
  const chosen = ctx.bins.find((b) => b.id === chosenId);
  if (!part?.part_num || !chosen || chosen.type !== 'storage' || chosen.locked) return '';
  const label = chosen.label;
  const log = ((await db.getSetting('storageLog')) || []).slice(-299);
  log.push({ t: nowIso(), cat: part.cat_id ?? null, part: part.part_num, col: colorId, bin: chosenId, sug: suggestedId || null });
  await db.setSetting('storageLog', log);
  // A bin with a colour rule that lists this colour is simply the right place for it: nothing to learn.
  if (colorId !== null && binPalette(chosen).includes(colorId)) return '';
  const catKey = part.cat_id != null ? String(part.cat_id) : null;
  const named = catName ? `“${catName}”` : 'this part';

  if (!suggestedId) {
    await rememberStorage({ part, binId: chosenId, scope: catKey ? 'category' : 'part', ctx });
    return ` Remembered for ${catKey ? named : 'this part'}.`;
  }
  if (chosenId === suggestedId) return '';

  // An override. The category’s usual bin (valid ones only) decides whether this is a one-off.
  const usual = catKey ? ctx.catMap[catKey] : null;
  if (usual === chosenId) {
    await removeRule('part', part.part_num);
    return ` Back to the usual bin for ${named}.`;
  }
  await rememberStorage({ part, binId: chosenId, scope: 'part', ctx });
  let msg = ` This part will go to ${label} from now on.`;
  if (catKey) {
    const recent = log.filter((e) => String(e.cat) === catKey).slice(-RECENT_WINDOW);
    if (recent.filter((e) => e.bin === chosenId).length >= RECENT_NEEDED) {
      await rememberStorage({ part, binId: chosenId, scope: 'category', ctx });
      msg = ` ${named} now goes to ${label} (${recent.filter((e) => e.bin === chosenId).length} of the last ${recent.length}).`;
    }
  }
  return msg;
}

// What has been chosen lately for a category, for the rules screen: [{ bin, n }] most first.
export function recentChoices(log, catId, limit = 10) {
  const recent = (log || []).filter((e) => String(e.cat) === String(catId)).slice(-limit);
  const counts = new Map();
  for (const e of recent) counts.set(e.bin, (counts.get(e.bin) || 0) + 1);
  return [...counts.entries()].map(([bin, n]) => ({ bin, n })).sort((a, b) => b.n - a.n);
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
  const receipt = { log: [], inv: [] }; // enough to put everything back (see undoSave)
  if (log) {
    for (const it of items) {
      const row = { id: uid(), t: now, qty: it.qty, part_num: part.part_num || '', bin_id: it.binId, updated: now, deleted: false };
      await db.put('log', row);
      receipt.log.push(row.id);
    }
  }
  for (const it of items) {
    const lines = await binLines(it.binId);
    const same = lines.find((l) => l.part_num === part.part_num && l.color_id === color.id
      && !!l.sticker === !!flags.sticker && !!l.printed === !!flags.printed && !!l.other === !!flags.other
      && (l.note || '') === (note || ''));
    if (same) {
      await db.put('inventory', { ...same, qty: same.qty + it.qty, updated: now });
      receipt.inv.push({ id: same.id, before: same });
    } else {
      const row = {
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
      };
      await db.put('inventory', row);
      receipt.inv.push({ id: row.id, before: null, row });
    }
  }
  return receipt;
}

// The storage rules and history, so an undo can put them back as they were.
export async function rulesSnapshot() {
  const out = {};
  for (const k of ['storageLog', 'categoryMap', 'partOverrides']) out[k] = (await db.getSetting(k)) ?? null;
  return out;
}

// Reverses one saveToBins (and optionally the rules learnt from it). Nothing is ever hard-deleted.
export async function undoSave(receipt, rules = null) {
  const now = nowIso();
  for (const id of receipt.log) {
    const r = await db.get('log', id);
    if (r) await db.put('log', { ...r, deleted: true, updated: now });
  }
  for (const c of receipt.inv.slice().reverse()) {
    const cur = await db.get('inventory', c.id);
    if (!cur) continue;
    if (c.before) await db.put('inventory', { ...cur, qty: c.before.qty, updated: now });
    else await db.put('inventory', { ...cur, deleted: true, updated: now });
  }
  if (rules) for (const [k, v] of Object.entries(rules)) await db.setSetting(k, v ?? (k === 'storageLog' ? [] : {}));
}

// A copy of every inventory and log row, so a whole action (Found, Take, Move, Remove) can be put back.
export async function snapshotAll() {
  return { inv: new Map((await db.all('inventory')).map((r) => [r.id, r])), log: new Map((await db.all('log')).map((r) => [r.id, r])) };
}

// Puts every row back as it was in the snapshot. Rows made since are marked removed; nothing is hard-deleted.
export async function restoreSnapshot(snap) {
  const now = nowIso();
  for (const [store, before] of [['inventory', snap.inv], ['log', snap.log]]) {
    for (const cur of await db.all(store)) {
      const old = before.get(cur.id);
      if (!old) { if (!cur.deleted) await db.put(store, { ...cur, deleted: true, updated: now }); continue; }
      if (JSON.stringify({ ...old, updated: 0 }) !== JSON.stringify({ ...cur, updated: 0 })) await db.put(store, { ...old, updated: now });
    }
  }
}

// Which active bins still want each part+colour: Map 'part|colour' -> [{ bin, rem }].
export function wantedMap(ctx) {
  const m = new Map();
  for (const a of ctx.active) {
    for (const [k, need] of a.need) {
      const rem = need - (a.held.get(k) || 0);
      if (rem <= 0) continue;
      if (!m.has(k)) m.set(k, []);
      m.get(k).push({ bin: a.bin, rem });
    }
  }
  for (const list of m.values()) list.sort((x, y) => x.bin.number - y.bin.number);
  return m;
}

// Moves qty of an existing line into another bin (not new sorting, so no activity-log entry).
// An active bin only accepts what its set still needs.
export async function moveLine(ctx, line, toBinId, qty) {
  const to = ctx.bins.find((b) => b.id === toBinId && !b.deleted);
  if (!to || to.id === line.bin_id) throw new Error('Choose a different bin.');
  if (!Number.isInteger(qty) || qty < 1 || qty > line.qty) throw new Error(`Enter a number from 1 to ${line.qty}.`);
  if (to.type === 'active' && line.part_num) {
    const a = ctx.active.find((x) => x.bin.id === to.id);
    const k = `${line.part_num}|${line.color_id}`;
    const rem = a ? (a.need.get(k) || 0) - (a.held.get(k) || 0) : 0;
    if (rem <= 0) throw new Error(`Bin ${to.number}'s set doesn’t need this piece in that colour.`);
    if (qty > rem) throw new Error(`Bin ${to.number} only needs ${rem} more of this piece.`);
  }
  const now = nowIso();
  await db.put('inventory', qty === line.qty ? { ...line, qty: 0, deleted: true, updated: now } : { ...line, qty: line.qty - qty, updated: now });
  await saveToBins({
    part: { part_num: line.part_num, name: line.name, cat_id: line.cat_id },
    color: { id: line.color_id, name: line.color_name, rgb: line.rgb },
    flags: { sticker: !!line.sticker, printed: !!line.printed, other: !!line.other },
    note: line.note || '',
    items: [{ binId: to.id, qty }],
    log: false,
  });
  return to;
}

// Moves whole lines, in bulk, between storage bins.
export async function moveLines(ctx, lines, toBinId) {
  const to = ctx.bins.find((b) => b.id === toBinId && !b.deleted);
  if (!to || to.type !== 'storage') throw new Error('Choose a storage bin.');
  if (to.full) throw new Error(`${to.label} is marked as full.`);
  for (const line of lines) {
    if (line.bin_id === to.id) continue;
    await moveLine(ctx, line, to.id, line.qty);
  }
  return to;
}

// The short name on a storage bin’s tile: whatever was chosen, else the first two letters.
export function binShort(bin) {
  const s = String(bin?.short || '').trim().slice(0, 3);
  return (s || String(bin?.label || '').slice(0, 2)).toUpperCase();
}

export async function setBinShort(binId, short) {
  const bin = await db.get('bins', binId);
  if (!bin || bin.deleted) throw new Error('Bin not found.');
  await db.put('bins', { ...bin, short: String(short || '').trim().slice(0, 3) || null, updated: nowIso() });
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
  const now = nowIso();
  const lines = await binLines(binId);
  // The bricks go with the bin (marked removed, never hard-deleted).
  await db.putMany('inventory', lines.map((l) => ({ ...l, deleted: true, updated: now })));
  await db.put('bins', { ...bin, deleted: true, updated: now });
  return { bricks: sumQty(lines) };
}

// How much of a set’s parts list is already sitting in storage bins (for the pick list).
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

const HEX = /^#[0-9a-f]{6}$/i;

// Up to four colours for a bin. Older bins only have the single `color`.
export function binColors(bin) {
  const list = Array.isArray(bin?.colors) ? bin.colors.filter((h) => HEX.test(h || '')) : [];
  if (list.length) return list.slice(0, 4);
  return HEX.test(bin?.color || '') ? [bin.color] : [];
}

const lum = (hex) => { const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)); return 0.299 * r + 0.587 * g + 0.114 * b; };

// The background for a bin’s chip: one colour solid; two split diagonally in half; three as a half and
// two quarters; four as quarters. The first colour chosen gets the largest share.
export function binBackground(colors) {
  if (colors.length === 1) return colors[0];
  const cuts = { 2: [50], 3: [50, 75], 4: [25, 50, 75] }[colors.length];
  const stops = colors.map((c, i) => `${c} ${i === 0 ? 0 : cuts[i - 1]}% ${i === colors.length - 1 ? 100 : cuts[i]}%`);
  return `linear-gradient(135deg, ${stops.join(', ')})`;
}

export function chipStyle(bin) {
  const colors = binColors(bin);
  if (!colors.length) return '';
  const light = colors.reduce((n, c) => n + lum(c), 0) / colors.length > 160;
  const shadow = colors.length > 1 ? `;text-shadow:0 0 3px ${light ? 'rgba(255,255,255,.9)' : 'rgba(0,0,0,.7)'}` : '';
  return ` style="background:${binBackground(colors)};color:${light ? '#1d1b1a' : '#ffffff'}${shadow};box-shadow:inset 0 0 0 1px rgba(0,0,0,.22)"`;
}

// A small square showing the bin’s colours, for page headings ('' if none chosen).
export function colorSquare(bin) {
  const colors = binColors(bin);
  return colors.length ? `<span class="binsquare" aria-hidden="true" style="background:${binBackground(colors)}"></span>` : '';
}

export async function setBinColors(binId, hexes) {
  const bin = await db.get('bins', binId);
  if (!bin || bin.deleted) throw new Error('Bin not found.');
  const list = (hexes || []).filter((h) => HEX.test(h)).slice(0, 4);
  await db.put('bins', { ...bin, colors: list.length ? list : null, color: list[0] || null, updated: nowIso() });
}

export async function setBinColor(binId, hex) {
  const bin = await db.get('bins', binId);
  if (!bin || bin.deleted) throw new Error('Bin not found.');
  await db.put('bins', { ...bin, color: hex || null, colors: hex ? [hex] : null, updated: nowIso() });
}
