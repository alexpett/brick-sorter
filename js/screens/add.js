// Add pieces: find the part, pick the colour, and see which bin it goes into.
import * as db from '../db.js';
import * as refdata from '../data.js';
import * as bins from '../bins.js';
import { view, esc, fmt, toast, openDialog, setTitle } from '../ui.js';

const MAX_RECENT = 6;

const FLAGS = [
  ['sticker', 'Sticker'],
  ['printed', 'Printed part'],
  ['other', 'Other'],
];

// Kept between visits so leaving the screen mid-entry loses nothing, and the colour stays put.
const S = {
  part: null,
  colorId: null,
  qty: '',
  flags: { sticker: false, printed: false, other: false },
  note: '',
  tab: 'recent',
  pickerOpen: true,
  q: '',
  colorFilter: '',
  fromScan: false,
};

// Called by the Scan screen: carry a chosen part (or a text to search for) into the Add flow.
export function choosePartFromScan(part, query = '') {
  S.part = part;
  S.q = query;
  S.qty = '';
  S.note = '';
  S.flags = { sticker: false, printed: false, other: false };
  handoff = true;
}
let handoff = false;

let ctx = null;
let yours = new Set();
let imgByPart = new Map();
let yourColorIds = [];
let neededBy = new Map(); // part_num -> [{ bin, set, colorId, need, held, rem }] across active sets
let recent = [];
let results = [];
let saving = false;
let root = null;

const colorOf = (id) => refdata.ref.colorById.get(id);
const $r = (sel) => root.querySelector(sel);

async function refreshContext() {
  ctx = await bins.loadContext();
  yours = new Set();
  imgByPart = new Map();
  const colors = new Set();
  for (const l of await db.all('setParts')) {
    yours.add(l.part_num);
    colors.add(l.color_id);
    if (l.img && !imgByPart.has(l.part_num)) imgByPart.set(l.part_num, l.img);
  }
  yourColorIds = [...colors];
  neededBy = new Map();
  for (const a of ctx.active) {
    for (const [k, need] of a.need) {
      const [pn, cid] = k.split('|');
      const held = a.held.get(k) || 0;
      if (!neededBy.has(pn)) neededBy.set(pn, []);
      neededBy.get(pn).push({ bin: a.bin, set: a.set, colorId: Number(cid), need, held, rem: need - held });
    }
  }
}

export async function renderAdd() {
  S.fromScan = handoff; // only true when we arrive from the Scan screen
  handoff = false;
  setTitle('Add pieces');
  view.innerHTML = '<p class="empty">Loading the parts catalogue…</p>';
  try {
    await refdata.loadRef();
  } catch (e) {
    view.innerHTML = `<section class="panel"><h2>Couldn't load the parts catalogue</h2><p>${esc(e.message)}</p></section>`;
    return;
  }
  await refreshContext();
  const last = await db.getSetting('lastColor');
  if (S.colorId == null && last != null) S.colorId = last;
  recent = ((await db.getSetting('recentColors')) || []).slice(0, MAX_RECENT);
  S.tab = recent.length ? 'recent' : 'yours';
  S.pickerOpen = S.colorId == null;

  view.innerHTML = `
    <div id="addRoot">
      <section class="panel" id="stepPart"></section>
      <section class="panel" id="stepColor" hidden></section>
      <section class="panel" id="stepDetails" hidden></section>
      <section class="panel" id="preview" hidden></section>
    </div>`;
  root = view.querySelector('#addRoot');
  root.addEventListener('click', onClick);
  root.addEventListener('input', onInput);
  drawAll();
}

function drawAll() {
  drawPart();
  drawColor();
  drawDetails();
  drawPreview();
}

// ---------- step 1: part ----------

function thumb(partNum, colorId) {
  const url = refdata.partImg(partNum, colorId, imgByPart.get(partNum));
  return `<div class="thumb">${url ? `<img src="${esc(url)}" alt="" loading="lazy">` : ''}</div>`;
}

function partTag(pn) {
  const open = [...new Set((neededBy.get(pn) || []).filter((e) => e.rem > 0).map((e) => e.bin.number))].sort((a, b) => a - b);
  if (open.length) return ` <span class="tag ok">needed: ${open.map((n) => `Bin ${n}`).join(', ')}</span>`;
  if ((neededBy.get(pn) || []).length) return ' <span class="tag ok">active set has all it needs</span>';
  return yours.has(pn) ? ' <span class="tag ok">in your sets</span>' : '';
}

function drawPart() {
  const el = $r('#stepPart');
  if (S.part) {
    const p = S.part;
    el.innerHTML = `
      <h2>1. Part</h2>
      <div class="selpart">
        ${p.unrec ? '<div class="thumb"></div>' : thumb(p.part_num, S.colorId)}
        <div class="pinfo">
          <div class="pname">${esc(p.name)}</div>
          <div class="pmeta">${p.unrec ? 'Goes to the Unrecognised bin' : `${esc(p.part_num)} · ${esc(refdata.categoryName(p.cat_id))}${partTag(p.part_num)}`}</div>
        </div>
        <button class="btn small" id="changePart" type="button">Change</button>
      </div>`;
    return;
  }
  el.innerHTML = `
    <h2>1. Find the part</h2>
    <a class="btn primary block scanbtn" href="#/scan">Scan a piece with the camera</a>
    <label for="q" class="sr">Search parts</label>
    <input id="q" type="search" placeholder="Part number or words, e.g. 3001 or plate 2 x 4" autocomplete="off" autocapitalize="off" spellcheck="false">
    <div id="results" aria-live="polite"></div>
    <button class="btn block" id="unrec" type="button">I can't identify this piece</button>`;
  $r('#q').value = S.q;
  drawResults();
}

function drawResults() {
  const el = $r('#results');
  if (!el) return;
  if (!S.q.trim()) {
    results = [];
    el.innerHTML = '<p class="hint">Parts from your sets are listed first.</p>';
    return;
  }
  results = refdata.searchParts(S.q, yours, 40);
  if (!results.length) { el.innerHTML = '<p class="empty">No parts match.</p>'; return; }
  el.innerHTML = `<ul class="parts results">${results.map((p, i) => `
    <li>
      <button type="button" class="result" data-pick="${i}">
        ${thumb(p.part_num, S.colorId)}
        <span class="pinfo">
          <span class="pname">${esc(p.name)}</span>
          <span class="pmeta">${esc(p.part_num)} · ${esc(refdata.categoryName(p.cat_id))}${partTag(p.part_num)}</span>
        </span>
      </button>
    </li>`).join('')}</ul>`;
}

// ---------- step 2: colour ----------

function swatchHtml(c, extra = '') {
  return `<span class="swatch${c.is_trans ? ' trans' : ''}${extra}" style="--c:#${esc(c.rgb)}"></span>`;
}

function colorsForTab() {
  const byName = (a, b) => a.name.localeCompare(b.name);
  if (S.tab === 'recent') return recent.map(colorOf).filter(Boolean);
  if (S.tab === 'yours') return yourColorIds.map(colorOf).filter(Boolean).sort(byName);
  return refdata.pickerColors();
}

function drawColor() {
  const el = $r('#stepColor');
  el.hidden = !S.part;
  if (!S.part) return;
  const cur = S.colorId != null ? colorOf(S.colorId) : null;
  if (cur && !S.pickerOpen) {
    el.innerHTML = `
      <h2>2. Colour</h2>
      <div class="curcolor">
        ${swatchHtml(cur, ' lg')}
        <strong id="curColorName">${esc(cur.name)}</strong>
        <button class="btn small" id="changeColor" type="button">Change</button>
      </div>`;
    return;
  }
  const yoursCount = yourColorIds.filter((id) => colorOf(id)).length;
  const tabs = [
    ['recent', `Recent (${recent.length})`],
    ['yours', `Your colours (${yoursCount})`],
    ['all', 'All'],
  ];
  el.innerHTML = `
    <h2>2. Pick the colour</h2>
    <div class="segmented" role="tablist">
      ${tabs.map(([id, label]) => `<button type="button" role="tab" data-tab="${id}" aria-selected="${S.tab === id}">${esc(label)}</button>`).join('')}
    </div>
    ${S.tab === 'recent' ? '' : `
      <label for="cfilter" class="sr">Filter colours</label>
      <input id="cfilter" type="search" placeholder="Filter colours" autocomplete="off" spellcheck="false">`}
    <div id="cgrid"></div>`;
  const f = $r('#cfilter');
  if (f) f.value = S.colorFilter;
  drawColorGrid();
}

function drawColorGrid() {
  const el = $r('#cgrid');
  if (!el) return;
  const needle = S.colorFilter.trim().toLowerCase();
  const list = colorsForTab().filter((c) => !needle || c.name.toLowerCase().includes(needle));
  if (!list.length) {
    el.innerHTML = `<p class="hint">${S.tab === 'recent' ? 'Colours you pick will appear here.' : 'No colours match.'}</p>`;
    return;
  }
  el.innerHTML = `<div class="cgrid">${list.map((c) => `
    <button type="button" class="cswatch" data-color="${c.id}" aria-pressed="${c.id === S.colorId}" title="${esc(c.name)}">
      ${swatchHtml(c, ' lg')}<span class="cn">${esc(c.name)}</span>
    </button>`).join('')}</div>`;
}

async function chooseColor(id) {
  S.colorId = id;
  S.pickerOpen = false;
  S.colorFilter = '';
  recent = [id, ...recent.filter((x) => x !== id)].slice(0, MAX_RECENT);
  await db.setSetting('lastColor', id);
  await db.setSetting('recentColors', recent);
  drawColor();
  drawDetails();
  drawPreview();
}

// ---------- step 3: quantity and flags ----------

function qtyValue() {
  if (S.qty.trim() === '') return 1;
  const n = Number(S.qty);
  return Number.isInteger(n) && n >= 1 && n <= 9999 ? n : null;
}

function drawDetails() {
  const el = $r('#stepDetails');
  el.hidden = !(S.part && S.colorId != null);
  if (el.hidden) return;
  const showNote = S.flags.other || S.part.unrec;
  el.innerHTML = `
    <h2>3. How many?</h2>
    <label for="qty">Quantity <span class="optional">(optional, 1 if blank)</span></label>
    <input id="qty" inputmode="numeric" pattern="[0-9]*" placeholder="1" autocomplete="off">
    <p class="hint" id="qtyHint" hidden>Enter a whole number from 1 to 9,999.</p>
    <div class="flagrow" role="group" aria-label="Flags">
      ${FLAGS.map(([id, label]) => `<button type="button" class="chip" data-flag="${id}" aria-pressed="${S.flags[id]}">${esc(label)}</button>`).join('')}
    </div>
    ${showNote ? `
      <label for="note">Note</label>
      <input id="note" placeholder="${S.part.unrec ? 'What does it look like?' : 'Add a note'}" autocomplete="off" maxlength="200">` : ''}`;
  $r('#qty').value = S.qty;
  const n = $r('#note');
  if (n) n.value = S.note;
}

// ---------- step 4: where it goes ----------

function computePreview() {
  if (!S.part || S.colorId == null) return null;
  const qty = qtyValue();
  if (qty === null) return { invalid: true };
  if (S.part.unrec) return { qty, allocations: [], storageQty: qty, storageBinId: 'unrecognised', unrec: true };
  const { allocations, storageQty } = bins.allocate(ctx, S.part.part_num, S.colorId, qty);
  return {
    qty,
    allocations,
    storageQty,
    storageBinId: storageQty > 0 ? bins.resolveStorage(ctx, S.part) : null,
  };
}

const storageLabel = (id) => ctx.bins.find((b) => b.id === id)?.label || 'storage';

function drawPreview() {
  const el = $r('#preview');
  const pv = computePreview();
  el.hidden = !pv;
  if (!pv) return;
  if (pv.invalid) {
    $r('#qtyHint').hidden = false;
    el.hidden = true;
    return;
  }
  const qh = $r('#qtyHint');
  if (qh) qh.hidden = true;

  const rows = pv.allocations.map((a) => `
    <li>
      <span class="binchip">Bin ${a.bin.number}</span>
      <span><strong>${fmt(a.qty)}</strong> for ${esc(a.set.name)}<br>
      <small>Needs ${fmt(a.need)}, has ${fmt(a.heldBefore)} so far</small></span>
    </li>`);
  if (pv.storageQty > 0) {
    rows.push(`
      <li>
        <span class="binchip store">${pv.unrec ? 'Unrecognised' : esc(pv.storageBinId ? storageLabel(pv.storageBinId) : 'Storage')}</span>
        <span><strong>${fmt(pv.storageQty)}</strong> ${pv.unrec ? 'to the Unrecognised bin' : pv.storageBinId ? 'not needed by an active set' : 'storage bin not chosen yet'}
        ${pv.unrec ? '' : `<br><button type="button" class="linkbtn" id="changeBin">${pv.storageBinId ? 'Use a different bin' : 'Choose a bin'}</button>`}</span>
      </li>`);
  }
  const total = pv.qty;
  let hint = '';
  const entries = S.part.unrec ? [] : (neededBy.get(S.part.part_num) || []);
  if (!pv.allocations.length && entries.length) {
    const cur = colorOf(S.colorId);
    const open = entries.filter((e) => e.rem > 0 && colorOf(e.colorId));
    hint = open.length
      ? `<div class="notice"><p>${esc(cur?.name || 'This colour')} isn't needed by an active set. This part is needed in:</p>
          <div class="flagrow">${open.map((e) => `<button type="button" class="chip" data-usecolor="${e.colorId}">${swatchHtml(colorOf(e.colorId))} ${esc(colorOf(e.colorId).name)} · Bin ${e.bin.number} (${fmt(e.rem)})</button>`).join('')}</div></div>`
      : `<div class="notice"><p>Active sets already have all they need of this ${esc(cur?.name || 'colour')} part.</p></div>`;
  }
  el.innerHTML = `
    <h2>4. Where it goes</h2>
    ${hint}
    <ul class="dest">${rows.join('')}</ul>
    <button class="btn primary block" id="saveBtn" type="button">Save ${fmt(total)} ${total === 1 ? 'piece' : 'pieces'}</button>`;
}

async function chooseStorage(part) {
  const storage = ctx.bins.filter((b) => b.type === 'storage' && !b.locked).sort((a, b) => (a.order || 0) - (b.order || 0));
  const catName = part.cat_id != null ? refdata.categoryName(part.cat_id) : null;
  const { value, data: form } = await openDialog(`
    <h2>Which storage bin?</h2>
    <p>No active set needs <strong>${esc(part.name)}</strong>. Where should it be stored?</p>
    <div class="choices">${storage.map((b) => `
      <button class="choice" value="${esc(b.id)}"><strong>${esc(b.label)}</strong>${b.desc ? `<span>${esc(b.desc)}</span>` : ''}</button>`).join('')}
    </div>
    ${catName ? `
    <fieldset class="scope">
      <legend>Remember this for</legend>
      <label><input type="radio" name="scope" value="category" checked> every part in “${esc(catName)}”</label>
      <label><input type="radio" name="scope" value="part"> only this part</label>
    </fieldset>` : ''}
    <div class="row"><button class="btn" value="cancel" formnovalidate>Cancel</button></div>`, { data: true });
  if (!value || value === 'cancel') return null;
  await bins.rememberStorage({ part, binId: value, scope: form.get('scope') || 'part', ctx });
  return value;
}

async function save() {
  if (saving) return;
  const pv = computePreview();
  if (!pv || pv.invalid) return;
  saving = true;
  const btn = $r('#saveBtn');
  if (btn) btn.disabled = true;
  try {
    let storageBinId = pv.storageBinId;
    if (pv.storageQty > 0 && !storageBinId) {
      storageBinId = await chooseStorage(S.part);
      if (!storageBinId) return;
    }
    const items = pv.allocations.map((a) => ({ binId: a.bin.id, qty: a.qty }));
    if (pv.storageQty > 0) items.push({ binId: storageBinId, qty: pv.storageQty });
    await bins.saveToBins({
      part: S.part,
      color: colorOf(S.colorId),
      flags: S.flags,
      note: S.note.trim(),
      items,
    });
    const where = items.map((it) => {
      const b = ctx.bins.find((x) => x.id === it.binId);
      return `${fmt(it.qty)} in ${b?.type === 'active' ? `Bin ${b.number}` : b?.label || 'storage'}`;
    }).join(', ');
    toast(`Saved: ${where}`);
    S.part = null;
    S.qty = '';
    S.q = '';
    S.note = '';
    S.flags = { sticker: false, printed: false, other: false };
    await refreshContext();
    if (S.fromScan) { location.hash = '#/scan'; return; } // straight back to the camera for the next piece
    drawAll();
  } catch (e) {
    toast(e.message || 'Could not save.');
  } finally {
    saving = false;
    const b = $r('#saveBtn');
    if (b) b.disabled = false;
  }
}

// ---------- events ----------

async function onClick(e) {
  const t = e.target.closest('[data-usecolor],[data-pick],[data-tab],[data-color],[data-flag],#changePart,#unrec,#changeColor,#saveBtn,#changeBin');
  if (!t) return;
  if (t.dataset.pick !== undefined) {
    S.part = results[Number(t.dataset.pick)];
    S.flags = { sticker: false, printed: false, other: false };
    S.note = '';
    drawAll();
    return;
  }
  if (t.dataset.usecolor !== undefined) { await chooseColor(Number(t.dataset.usecolor)); return; }
  if (t.dataset.tab) { S.tab = t.dataset.tab; S.colorFilter = ''; drawColor(); return; }
  if (t.dataset.color !== undefined) { await chooseColor(Number(t.dataset.color)); return; }
  if (t.dataset.flag) {
    S.flags[t.dataset.flag] = !S.flags[t.dataset.flag];
    drawDetails();
    return;
  }
  switch (t.id) {
    case 'changePart': S.part = null; S.fromScan = false; drawAll(); break;
    case 'unrec':
      S.part = { unrec: true, part_num: '', name: 'Unrecognised piece', cat_id: null };
      S.flags = { sticker: false, printed: false, other: false };
      drawAll();
      break;
    case 'changeColor': S.pickerOpen = true; S.tab = recent.length ? 'recent' : 'yours'; drawColor(); break;
    case 'changeBin': {
      const id = await chooseStorage(S.part);
      if (id) drawPreview();
      break;
    }
    case 'saveBtn': await save(); break;
    default: break;
  }
}

function onInput(e) {
  const id = e.target.id;
  if (id === 'q') { S.q = e.target.value; drawResults(); }
  else if (id === 'cfilter') { S.colorFilter = e.target.value; drawColorGrid(); }
  else if (id === 'qty') { S.qty = e.target.value; drawPreview(); }
  else if (id === 'note') { S.note = e.target.value; }
}
