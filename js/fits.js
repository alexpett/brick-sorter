// Which tyres go with a wheel. Rebrickable has no fit table, and the part names don’t say what a tyre’s inner
// diameter is, so this looks for evidence instead: sets that contain the wheel and a tyre in equal numbers.
// Evidence comes from the sets already in the app, plus a few small sets fetched from Rebrickable (cached).
import * as db from './db.js';
import * as rb from './rebrickable.js';
import * as refdata from './data.js';

const isTyre = (num) => {
  const i = refdata.ref.byNum.get(String(num).toLowerCase());
  return i !== undefined && refdata.ref.parts[i][2] === 29 && /^Tyre\b/i.test(refdata.ref.parts[i][1]);
};

// Counts, per tyre, the sets where its quantity equals the wheel’s.
function tally(rows, wheelNum, found) {
  const wheel = rows.filter((r) => r.part_num === wheelNum).reduce((n, r) => n + (r.qty ?? r.quantity ?? 0), 0);
  if (!wheel) return;
  const tyres = new Map();
  for (const r of rows) {
    if (r.part_num === wheelNum || !isTyre(r.part_num)) continue;
    tyres.set(r.part_num, (tyres.get(r.part_num) || 0) + (r.qty ?? r.quantity ?? 0));
  }
  for (const [num, q] of tyres) if (q === wheel) found.set(num, (found.get(num) || 0) + 1);
}

async function fromMySets(wheelNum, found) {
  const bySet = new Map();
  for (const r of await db.all('setParts')) {
    if (!bySet.has(r.set_num)) bySet.set(r.set_num, []);
    bySet.get(r.set_num).push(r);
  }
  for (const rows of bySet.values()) tally(rows, wheelNum, found);
}

async function fromRebrickable(wheelNum, key, found) {
  const colours = (await rb.getPartColors(wheelNum, key)).sort((a, b) => (b.num_sets || 0) - (a.num_sets || 0));
  if (!colours.length) return;
  const sets = (await rb.getPartColorSets(wheelNum, colours[0].color_id, key))
    .filter((s) => s.num_parts > 0 && !/^fig-/i.test(s.set_num))
    .sort((a, b) => a.num_parts - b.num_parts) // small sets have fewer other wheels to confuse things
    .slice(0, 4);
  for (const s of sets) tally(await rb.getSetParts(s.set_num, key), wheelNum, found);
}

// Tyres seen with this wheel, most often first: [{ part_num, name, cat_id, seen }]. Cached per wheel.
export async function tyresSeenWith(wheelNum) {
  const found = new Map();
  await fromMySets(wheelNum, found);
  const cache = (await db.getSetting('tyreFits')) || {};
  let remote = cache[wheelNum];
  const key = (await db.getSetting('rebrickableKey')) || '';
  let note = '';
  if (!remote && key) {
    try {
      const r = new Map();
      await fromRebrickable(wheelNum, key, r);
      remote = [...r];
      await db.setSetting('tyreFits', { ...cache, [wheelNum]: remote });
    } catch (e) { note = e.message || 'Couldn’t look it up on Rebrickable.'; }
  } else if (!remote) note = 'Add your Rebrickable key in Settings to look up which tyres fit.';
  for (const [num, n] of remote || []) found.set(num, (found.get(num) || 0) + n);
  const mine = ((await db.getSetting('wheelTyres')) || {})[wheelNum];
  if (mine !== undefined) found.set(String(mine), (found.get(String(mine)) || 0) + 100); // you chose it before
  const out = [];
  for (const [num, seen] of found) {
    const i = refdata.ref.byNum.get(String(num).toLowerCase());
    if (i !== undefined) out.push({ part_num: refdata.ref.parts[i][0], name: refdata.ref.parts[i][1], cat_id: refdata.ref.parts[i][2], seen });
  }
  out.sort((a, b) => b.seen - a.seen || a.name.localeCompare(b.name));
  return { tyres: out, note };
}
