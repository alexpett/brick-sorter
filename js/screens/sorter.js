// The piece-sorting panel shared by the Add and Scan screens: part, colour, quantity, flags
// and the bin buttons. Tapping a bin saves the piece there.
import * as db from '../db.js';
import * as refdata from '../data.js';
import * as bins from '../bins.js';
import { $, esc, fmt, toast, notify, openDialog } from '../ui.js';
import { celebrate } from '../rewards.js';

const MAX_RECENT = 6;
const FLAGS = [['sticker', 'Sticker'], ['printed', 'Printed'], ['other', 'Other']];

// Shared lookups, refreshed whenever bins or sets change.
export const info = { ctx: null, yours: new Set(), imgByPart: new Map(), neededBy: new Map(), yourColorIds: [], colorCounts: new Map() };

let colorId = null;
let recent = [];

const colorOf = (id) => refdata.ref.colorById.get(id);

export async function refreshInfo() {
  info.ctx = await bins.loadContext();
  info.yours = new Set();
  info.imgByPart = new Map();
  const colors = new Map();
  for (const l of await db.all('setParts')) {
    info.yours.add(l.part_num);
    colors.set(l.color_id, (colors.get(l.color_id) || 0) + (Number(l.quantity) || 0));
    if (l.img && !info.imgByPart.has(l.part_num)) info.imgByPart.set(l.part_num, l.img);
  }
  info.colorCounts = colors;
  info.yourColorIds = [...colors.keys()].sort((a, b) => colors.get(b) - colors.get(a));
  info.neededBy = new Map();
  for (const a of info.ctx.active) {
    for (const [k, need] of a.need) {
      const [pn, cid] = k.split('|');
      const held = a.held.get(k) || 0;
      if (!info.neededBy.has(pn)) info.neededBy.set(pn, []);
      info.neededBy.get(pn).push({ bin: a.bin, set: a.set, colorId: Number(cid), need, held, rem: need - held });
    }
  }
}

export async function loadColorState() {
  const last = await db.getSetting('lastColor');
  colorId = last === undefined || last === null ? null : last;
  recent = ((await db.getSetting('recentColors')) || []).slice(0, MAX_RECENT);
}

export function partTag(pn) {
  const entries = info.neededBy.get(pn) || [];
  const open = [...new Set(entries.filter((e) => e.rem > 0).map((e) => e.bin.number))].sort((a, b) => a - b);
  if (open.length) return ` <span class="tag ok">needed: ${open.map((n) => `Bin ${n}`).join(', ')}</span>`;
  if (entries.length) return ' <span class="tag ok">active set has all it needs</span>';
  return info.yours.has(pn) ? ' <span class="tag ok">in your sets</span>' : '';
}

export function thumb(partNum, cid) {
  const url = refdata.partImg(partNum, cid, info.imgByPart.get(partNum));
  return `<span class="thumb">${url ? `<img src="${esc(url)}" alt="" loading="lazy">` : ''}</span>`;
}

// Colours of this part that active sets still need, most pieces remaining first, ties alphabetical.
export function colourSuggestions(partNum) {
  const by = new Map();
  for (const e of info.neededBy.get(partNum) || []) {
    if (e.rem <= 0 || !colorOf(e.colorId)) continue;
    if (!by.has(e.colorId)) by.set(e.colorId, { id: e.colorId, rem: 0, bins: new Set() });
    const x = by.get(e.colorId);
    x.rem += e.rem;
    x.bins.add(e.bin.number);
  }
  return [...by.values()].sort((a, b) => b.rem - a.rem || colorOf(a.id).name.localeCompare(colorOf(b.id).name));
}

const swatchHtml = (c, extra = '') => `<span class="swatch${c.is_trans ? ' trans' : ''}${extra}" style="--c:#${esc(c.rgb)}"></span>`;

// ---------- colour picker (a dialog) ----------

async function chooseColor(id) {
  colorId = id;
  recent = [id, ...recent.filter((x) => x !== id)].slice(0, MAX_RECENT);
  await db.setSetting('lastColor', id);
  await db.setSetting('recentColors', recent);
}

// Opens the colour picker dialog. Resolves with a colour id, or null if cancelled.
export function pickColor(current = colorId) {
  return new Promise((resolve) => {
    const d = $('#dlg');
    let tab = recent.length ? 'recent' : 'yours';
    let filter = '';
    let open = null; // the one group that is expanded (none to start with)
    d.innerHTML = `<form method="dialog">
      <h2>Colour</h2>
      <div class="segmented" id="cpTabs" role="tablist"></div>
      <input id="cfilter" type="search" placeholder="Filter colours" autocomplete="off" spellcheck="false" hidden>
      <div id="cgrid"></div>
      <div class="row"><button class="btn" value="cancel" formnovalidate>Cancel</button></div>
    </form>`;
    const byRank = (a, b) => b.popularity - a.popularity || a.name.localeCompare(b.name);
    const yoursRank = (a, b) => (info.colorCounts.get(b.id) || 0) - (info.colorCounts.get(a.id) || 0) || a.name.localeCompare(b.name);
    const swatches = (colors) => `<div class="cgrid">${colors.map((c) => `
      <button type="button" class="cswatch" data-color="${c.id}" aria-pressed="${c.id === current}" title="${esc(c.name)}">
        ${swatchHtml(c, ' lg')}<span class="cn">${esc(c.name)}</span>
      </button>`).join('')}</div>`;
    const draw = () => {
      const yours = info.yourColorIds.map(colorOf).filter(Boolean).sort(yoursRank);
      d.querySelector('#cpTabs').innerHTML = [['recent', `Recent (${recent.length})`], ['yours', `Your colours (${yours.length})`], ['all', 'All']]
        .map(([id, label]) => `<button type="button" role="tab" data-tab="${id}" aria-selected="${tab === id}">${esc(label)}</button>`).join('');
      d.querySelector('#cfilter').hidden = tab === 'recent';
      const needle = filter.trim().toLowerCase();
      const match = (c) => !needle || c.name.toLowerCase().includes(needle);
      const box = d.querySelector('#cgrid');
      let colors;
      if (tab === 'recent') colors = recent.map(colorOf).filter(Boolean);
      else if (tab === 'yours') colors = yours.filter(match);
      else if (needle) colors = refdata.pickerColors().filter(match).sort(byRank);
      if (colors) {
        box.innerHTML = colors.length ? swatches(colors) : `<p class="hint">${tab === 'recent' ? 'Colours you pick will appear here.' : 'No colours match.'}</p>`;
        return;
      }
      // All, no filter: collapsible groups, each ranked by how widely the colour is used.
      const all = refdata.pickerColors();
      box.innerHTML = `<div class="cgroups">${refdata.COLOR_GROUPS.map((g) => {
        const list = all.filter((c) => refdata.colorGroup(c) === g).sort(byRank);
        if (!list.length) return '';
        const isOpen = open === g;
        return `<section class="cgroup">
          <button type="button" class="cghead" data-group="${esc(g)}" aria-expanded="${isOpen}">
            <span class="cgname">${esc(g)} <small>${list.length}</small></span>
            <span class="cgprev">${list.slice(0, 5).map((c) => swatchHtml(c)).join('')}</span>
            <span class="cgarrow" aria-hidden="true">${isOpen ? '▾' : '▸'}</span>
          </button>
          ${isOpen ? swatches(list) : ''}
        </section>`;
      }).join('')}</div>`;
    };
    d.onclick = (e) => {
      const t = e.target.closest('[data-tab],[data-color],[data-group]');
      if (!t) return;
      if (t.dataset.group) {
        const g = t.dataset.group;
        open = open === g ? null : g;
        draw();
        if (open) { // bring the opened group to the top of the list
          const head = [...d.querySelectorAll('.cghead')].find((h) => h.dataset.group === g);
          const box = d.querySelector('.cgroups');
          if (head && box) box.scrollTop += head.getBoundingClientRect().top - box.getBoundingClientRect().top - 4;
        }
        return;
      }
      if (t.dataset.tab) { tab = t.dataset.tab; filter = ''; const f = d.querySelector('#cfilter'); f.value = ''; draw(); return; }
      d.close(t.dataset.color);
    };
    d.oninput = (e) => { if (e.target.id === 'cfilter') { filter = e.target.value; draw(); } };
    d.onkeydown = (e) => { if (e.key === 'Enter' && e.target.id === 'cfilter') e.preventDefault(); };
    d.onclose = () => {
      d.onclick = null; d.oninput = null; d.onkeydown = null;
      const v = d.returnValue;
      resolve(v && v !== 'cancel' ? Number(v) : null);
    };
    d.returnValue = '';
    draw();
    d.showModal();
    d.setAttribute('tabindex', '-1');
    d.focus({ preventScroll: true });
  });
}

// ---------- the panel ----------

export function createSorter(el, { onSaved, onChangePart } = {}) {
  const st = { part: null, qtyText: '1', flags: { sticker: false, printed: false, other: false }, note: '', saving: false, sugOpen: true };
  el.classList.add('sorter');
  el.hidden = true;

  const qty = () => {
    const n = Number(st.qtyText);
    return st.qtyText.trim() !== '' && Number.isInteger(n) && n >= 1 && n <= 9999 ? n : null;
  };

  // Where the piece would go by default.
  function suggest() {
    const q = qty();
    if (q === null || colorId === null || !st.part) return null;
    if (st.part.unrec) return { dest: [{ binId: 'unrecognised', qty: q }], needsRule: false, allocations: [] };
    const { allocations, storageQty } = bins.allocate(info.ctx, st.part.part_num, colorId, q);
    const storageBin = storageQty > 0 ? bins.resolveStorage(info.ctx, st.part) : null;
    const dest = allocations.map((a) => ({ binId: a.bin.id, qty: a.qty }));
    if (storageQty > 0 && storageBin) dest.push({ binId: storageBin, qty: storageQty });
    return { dest, needsRule: storageQty > 0 && !storageBin, allocations, leftover: storageQty };
  }

  function suggestionsHtml() {
    if (!st.part || st.part.unrec) return '';
    const list = colourSuggestions(st.part.part_num);
    if (!list.length) return '';
    if (!st.sugOpen) return `<div class="suggest"><button type="button" class="linkbtn" id="showSug">Show colours needed by your sets (${list.length})</button></div>`;
    return `<div class="suggest">
      <p class="suggest-label">Needed by your sets — tap to use</p>
      <div class="flagrow">${list.map((c) => {
        const col = colorOf(c.id);
        return `<button type="button" class="chip" data-usecolor="${c.id}" aria-pressed="${c.id === colorId}">${swatchHtml(col)} ${esc(col.name)} · ${fmt(c.rem)} <small>${[...c.bins].sort((a, b) => a - b).map((n) => `Bin ${n}`).join(', ')}</small></button>`;
      }).join('')}</div>
    </div>`;
  }

  function renderTop() {
    const p = st.part;
    if (!p) { el.hidden = true; el.innerHTML = ''; return; }
    el.hidden = false;
    const cur = colorId === null ? null : colorOf(colorId);
    el.innerHTML = `
      <div class="selpart">
        ${p.unrec ? '<span class="thumb"></span>' : thumb(p.part_num, colorId)}
        <div class="pinfo">
          <div class="pname">${esc(p.name)}</div>
          <div class="pmeta">${p.unrec ? 'Goes to the Unrecognised bin' : `${esc(p.part_num)} · ${esc(refdata.categoryName(p.cat_id))}${partTag(p.part_num)}`}</div>
        </div>
        <button class="btn small" id="changePart" type="button">Change</button>
      </div>
      <div class="cqrow">
        <button type="button" class="colorbtn${cur ? '' : ' empty'}" id="colorBtn" aria-label="Colour">
          ${cur ? `${swatchHtml(cur, ' lg')}<span>${esc(cur.name)}</span>` : '<span>Choose a colour</span>'}
        </button>
        <div class="stepper" role="group" aria-label="Quantity">
          <button type="button" id="qtyMinus" aria-label="One fewer">−</button>
          <input id="qty" inputmode="numeric" pattern="[0-9]*" autocomplete="off" aria-label="Quantity">
          <button type="button" id="qtyPlus" aria-label="One more">+</button>
        </div>
      </div>
      ${suggestionsHtml()}
      <div class="flagrow" role="group" aria-label="Flags">
        ${FLAGS.map(([id, label]) => `<button type="button" class="chip" data-flag="${id}" aria-pressed="${st.flags[id]}">${esc(label)}</button>`).join('')}
      </div>
      ${st.flags.other || p.unrec ? `
        <label for="note" class="sr">Note</label>
        <input id="note" placeholder="${p.unrec ? 'What does it look like?' : 'Add a note'}" autocomplete="off" maxlength="200">` : ''}
      <h2 class="storagehead">Storage</h2>
      <div id="dest"></div>`;
    el.querySelector('#qty').value = st.qtyText;
    const n = el.querySelector('#note');
    if (n) n.value = st.note;
    renderDest();
  }

  function renderDest() {
    const box = el.querySelector('#dest');
    if (!box) return;
    const ctx = info.ctx;
    const q = qty();
    const sug = suggest();
    const sugMap = new Map((sug?.dest || []).map((d) => [d.binId, d.qty]));
    const remFor = (b) => {
      if (b.type !== 'active' || st.part.unrec || colorId === null) return 0;
      const e = (info.neededBy.get(st.part.part_num) || []).find((x) => x.bin.id === b.id && x.colorId === colorId);
      return e ? Math.max(0, e.rem) : 0;
    };
    const split = sug && sug.dest.length > 1 && !sug.needsRule;
    const partial = !!(sug && sug.needsRule && sug.allocations.length); // some go to active bins, the rest need a storage choice
    let usable = ctx.bins.filter((b) => !b.deleted);
    usable = st.part.unrec ? usable.filter((b) => b.id === 'unrecognised') : usable.filter((b) => b.id !== 'unrecognised');
    const active = usable.filter((b) => b.type === 'active').sort((a, b) => a.number - b.number);
    const storage = usable.filter((b) => b.type === 'storage').sort((a, b) => (a.order || 0) - (b.order || 0));
    const tile = (b) => {
      const isActive = b.type === 'active';
      const label = isActive ? `Bin ${b.number}` : b.label.slice(0, 2).toUpperCase();
      const name = isActive ? (ctx.setsByNum.get(b.set_num)?.name || '') : b.label;
      const s = sugMap.has(b.id);
      // An active bin only takes what its set still needs.
      const full = !isActive && !!b.full;
      const blocked = (isActive && remFor(b) <= 0) || full;
      return `
        <button type="button" class="tile${s ? ' suggested' : ''}" data-bin="${esc(b.id)}"${q === null || colorId === null || blocked ? ' disabled' : ''}${blocked ? ` title="${full ? 'This bin is full' : 'This set doesn’t need this piece'}"` : ''}>
          <span class="binchip big${isActive ? '' : ' store'}"${bins.chipStyle(b)}>${esc(label)}</span>
          <span class="tilename">${esc(name)}</span>
          ${full ? '<span class="tilebadge full">Full</span>' : ''}
          ${isActive && !blocked && colorId !== null && !st.part.unrec ? `<span class="tilebadge" title="${fmt(remFor(b))} still needed to complete this set"><span aria-hidden="true">${fmt(remFor(b))}</span><span class="sr">needs ${fmt(remFor(b))} more</span></span>` : ''}
        </button>`;
    };

    let note = '';
    if (colorId === null) note = '<p class="hint">Choose a colour first.</p>';
    else if (q === null) note = '<p class="hint">Enter a whole number from 1 to 9,999.</p>';
    else if (partial) {
      const lbl = (id) => { const b = ctx.bins.find((x) => x.id === id); return b.type === 'active' ? `Bin ${b.number}` : b.label; };
      note = `<p class="hint">${sug.dest.map((d) => `${fmt(d.qty)} → ${esc(lbl(d.binId))}`).join(', ')}. Tap a storage bin for the ${fmt(sug.leftover)} left over${st.part.cat_id != null ? ` (it will be remembered for “${esc(refdata.categoryName(st.part.cat_id))}”)` : ''}.</p>`;
    } else if (split) {
      const lbl = (id) => { const b = ctx.bins.find((x) => x.id === id); return b.type === 'active' ? `Bin ${b.number}` : b.label; };
      note = `<p class="hint">Suggested split: ${sug.dest.map((d) => `${fmt(d.qty)} → ${esc(lbl(d.binId))}`).join(', ')}. <button type="button" class="linkbtn" id="useSplit">Use this split</button></p>`;
    } else if (sug?.needsRule && st.part && !st.part.unrec && bins.ruleBinId(ctx, st.part)) {
      const fb = ctx.bins.find((x) => x.id === bins.ruleBinId(ctx, st.part));
      note = `<p class="hint">${esc(fb?.label || 'The usual bin')} is full. Choose another storage bin and the app will use it from now on.</p>`;
    } else if (sug?.needsRule) {
      note = `<p class="hint">No storage rule for this part yet. Tap a storage bin and the app will remember it for ${st.part.cat_id != null ? `every part in “${esc(refdata.categoryName(st.part.cat_id))}”` : 'this part'}.</p>`;
    }
    const addTile = st.part.unrec ? '' : `
        <button type="button" class="tile addtile" data-addbin="1">
          <span class="binchip big addchip" aria-hidden="true">+</span>
          <span class="tilename">Add bin</span>
        </button>`;
    // Preferred bins come first (the suggestion, in the order it fills them), then the other bins
    // that can take this piece, and bins that can't (set doesn't need it, storage full) go last.
    const isBlocked = (b) => (b.type === 'active' && remFor(b) <= 0) || (b.type === 'storage' && !!b.full);
    let ordered = [...active, ...storage];
    if (colorId !== null && !st.part.unrec) {
      const sugOrder = (sug?.dest || []).map((d) => d.binId);
      const rank = (b) => {
        const si = sugOrder.indexOf(b.id);
        if (si >= 0) return si;
        if (isBlocked(b)) return 1000;
        return b.type === 'active' ? 100 : 200;
      };
      ordered = ordered.map((b, i) => ({ b, i, r: rank(b) })).sort((x, y) => x.r - y.r || x.i - y.i).map((x) => x.b);
    }
    box.innerHTML = `${note}<div class="tiles">${ordered.map(tile).join('')}${addTile}</div>`;
  }

  // Create a storage bin without leaving the Log screen. The new bin is shown but not chosen.
  async function addBinFlow(error = '', name = '', color = '') {
    const { value, data } = await openDialog(`
      <h2>Add storage bin</h2>
      ${error ? `<p class="hint err" role="alert">${esc(error)}</p>` : ''}
      <label for="nbn">Name</label>
      <input id="nbn" name="name" maxlength="30" required autocomplete="off" value="${esc(name)}">
      <p class="suggest-label">Colour (optional)</p>
      <div class="cgrid presets pickc">${bins.BIN_COLORS.map((c) => `<label class="cswatch"><input type="radio" name="color" value="${c}"${c === color ? ' checked' : ''}><span class="swatch lg" style="--c:${c}"></span></label>`).join('')}</div>
      <div class="row">
        <button class="btn" value="cancel" formnovalidate>Cancel</button>
        <button class="btn primary" value="add">Add bin</button>
      </div>`, { data: true });
    if (value !== 'add') return;
    const nm = String(data.get('name') || '');
    const col = String(data.get('color') || '');
    try {
      const bin = await bins.addStorageBin(nm);
      if (col) await bins.setBinColor(bin.id, col);
    } catch (e) {
      await addBinFlow(e.message || 'Could not add the bin.', nm, col);
      return;
    }
    await refreshInfo();
    renderDest();
    toast(`Added “${nm.trim()}”.`);
  }

  async function commit(items, { keep = 0 } = {}) {
    if (st.saving) return;
    const q = qty();
    if (q === null || colorId === null || !st.part) return;
    st.saving = true;
    try {
      const part = st.part;
      for (const it of items) {
        const b = info.ctx.bins.find((x) => x.id === it.binId);
        if (b?.type !== 'active') continue;
        const e = (info.neededBy.get(part.part_num) || []).find((x) => x.bin.id === b.id && x.colorId === colorId);
        if (!e || e.rem < it.qty) { toast(`Bin ${b.number} doesn’t need that many.`); return; }
      }
      const suggestedStore = part.unrec ? null : bins.resolveStorage(info.ctx, part);
      await bins.saveToBins({ part, color: colorOf(colorId), flags: st.flags, note: st.note.trim(), items });
      const where = items.map((it) => {
        const b = info.ctx.bins.find((x) => x.id === it.binId);
        return `${fmt(it.qty)} in ${b?.type === 'active' ? `Bin ${b.number}` : b?.label || 'storage'}`;
      }).join(', ');
      let extra = '';
      const stores = items.map((it) => info.ctx.bins.find((x) => x.id === it.binId)).filter((b) => b && b.type === 'storage' && !b.locked);
      const target = stores.length === 1 ? stores[0] : null;
      if (target && !part.unrec) {
        extra = await bins.learnStorage({
          part, chosenId: target.id, suggestedId: suggestedStore, ctx: info.ctx,
          catName: part.cat_id != null ? refdata.categoryName(part.cat_id) : '',
        });
      }
      toast(`Saved: ${where}.${extra}`);
      await refreshInfo();
      if (keep > 0) {
        // Only part of the quantity fitted in that bin: keep the piece in the panel for the rest.
        st.qtyText = String(keep);
        renderTop();
        const b0 = info.ctx.bins.find((x) => x.id === items[0].binId);
        await notify({
          title: `${fmt(keep)} still to place`,
          body: `${b0?.type === 'active' ? `Bin ${b0.number}` : 'That bin'} only needed ${fmt(items[0].qty)}, so ${fmt(items[0].qty)} ${items[0].qty === 1 ? 'was' : 'were'} saved there. The other ${fmt(keep)} need to go in a different bin — choose one now.`,
        });
        await celebrate();
        return;
      }
      st.part = null;
      st.qtyText = '1';
      st.note = '';
      st.flags = { sticker: false, printed: false, other: false };
      renderTop();
      onSaved?.();
      await celebrate();
    } catch (e) {
      toast(e.message || 'Could not save.');
    } finally {
      st.saving = false;
    }
  }

  el.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-bin],[data-flag],[data-usecolor],#changePart,#colorBtn,#showSug,[data-addbin],#qtyMinus,#qtyPlus,#useSplit');
    if (!t) return;
    if (t.dataset.addbin) { await addBinFlow(); return; }
    if (t.dataset.bin) {
      const sug = suggest();
      const b = info.ctx.bins.find((x) => x.id === t.dataset.bin);
      if (sug && sug.needsRule && sug.allocations.length && b?.type === 'storage') {
        await commit([...sug.dest, { binId: b.id, qty: sug.leftover }]); // active bins as suggested, the rest here
      } else if (b?.type === 'active') {
        const e = (info.neededBy.get(st.part.part_num) || []).find((x) => x.bin.id === b.id && x.colorId === colorId);
        const room = e ? Math.max(0, e.rem) : 0;
        if (room <= 0) { toast('That set doesn’t need this piece.'); return; }
        const take = Math.min(qty(), room);
        await commit([{ binId: b.id, qty: take }], { keep: qty() - take });
      } else {
        await commit([{ binId: t.dataset.bin, qty: qty() }]);
      }
      return;
    }
    if (t.dataset.usecolor !== undefined) { st.sugOpen = false; await chooseColor(Number(t.dataset.usecolor)); renderTop(); return; }
    if (t.dataset.flag) {
      st.flags[t.dataset.flag] = !st.flags[t.dataset.flag];
      renderTop();
      return;
    }
    switch (t.id) {
      case 'showSug': st.sugOpen = true; renderTop(); break;
      case 'changePart': st.part = null; renderTop(); onChangePart?.(); break;
      case 'colorBtn': {
        const id = await pickColor();
        if (id !== null) { st.sugOpen = false; await chooseColor(id); renderTop(); }
        break;
      }
      case 'qtyMinus': case 'qtyPlus': {
        const n = (qty() ?? 1) + (t.id === 'qtyPlus' ? 1 : -1);
        st.qtyText = String(Math.min(9999, Math.max(1, n)));
        el.querySelector('#qty').value = st.qtyText;
        renderDest();
        break;
      }
      case 'useSplit': { const s = suggest(); if (s) await commit(s.dest); break; }
      default: break;
    }
  });
  el.addEventListener('input', (e) => {
    if (e.target.id === 'qty') { st.qtyText = e.target.value; renderDest(); }
    else if (e.target.id === 'note') st.note = e.target.value;
  });

  return {
    async setPart(part) {
      st.part = part;
      st.sugOpen = true;
      st.qtyText = '1';
      st.note = '';
      st.flags = { sticker: false, printed: false, other: false };
      await refreshInfo();
      renderTop();
    },
    clear() { st.part = null; renderTop(); },
    get part() { return st.part; },
  };
}
