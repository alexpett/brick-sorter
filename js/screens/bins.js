// Bins: the list of active and storage bins, what is in each, editing bricks, and abandoning a bin.
import * as db from '../db.js';
import * as refdata from '../data.js';
import * as bins from '../bins.js';
import { view, esc, fmt, toast, openDialog, ask, setTitle, safeRgb, stepperHtml } from '../ui.js';
import { orderDialog } from '../order.js';
import { celebrate } from '../rewards.js';
import { pickColor, refreshInfo, loadColorState } from './sorter.js';

const partCount = (lines) => bins.sumQty(lines);
const pl = (n, one, many) => `${fmt(n)} ${n === 1 ? one : many}`;

function tagsHtml(l) {
  const t = [];
  if (l.sticker) t.push('sticker');
  if (l.printed) t.push('printed');
  if (l.other) t.push('other');
  return t.map((x) => ` <span class="tag">${x}</span>`).join('');
}

// ---------- Bins list ----------

export async function renderBins() {
  setTitle('Store');
  await refdata.loadRef().catch(() => {});
  const ctx = await bins.loadContext();
  const count = (id) => partCount(ctx.byBin.get(id) || []);
  const wm = bins.wantedMap(ctx);
  const wantedLines = (id) => (ctx.byBin.get(id) || []).filter((l) => l.part_num && wm.has(`${l.part_num}|${l.color_id}`)).length;
  // Fullest first; equal counts keep their usual order.
  const storage = ctx.bins.filter((b) => b.type === 'storage').sort((a, b) => count(b.id) - count(a.id) || (a.order || 0) - (b.order || 0));

  const activeHtml = ctx.active.length
    ? `<ul class="cards">${ctx.active.map((a) => {
      const pct = Math.round(a.frac * 100);
      return `
      <li>
        <a class="card binrow" href="#/bin/${encodeURIComponent(a.bin.id)}">
          <span class="binchip big"${bins.chipStyle(a.bin)}>Bin ${a.bin.number}</span>
          <div class="cardtext">
            <div class="cardname">${esc(a.set.name)}</div>
            <div class="cardmeta">${esc(a.set.set_num)} · ${fmt(a.heldTotal)} of ${fmt(a.neededTotal)} bricks · ${pct}%</div>
            <div class="bar solid" aria-hidden="true"><i style="--p:${pct}%"></i></div>
          </div>
          <span class="chev" aria-hidden="true">›</span>
        </a>
      </li>`;
    }).join('')}</ul>`
    : '<p class="empty">No active bins yet. Open a set and choose “Start rebuilding this set”.</p>';

  view.innerHTML = `
    <a class="chip addbin searchall" href="#/bin/all"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L21 21"/></svg> Search all bricks</a>
    <section>
      <h2 class="section-title">Active bins</h2>
      ${activeHtml}
    </section>
    <section>
      <div class="sectionhead"><h2 class="section-title">Storage bins</h2><button type="button" class="chip addbin" id="addBin">+ Add bin</button></div>
      <ul class="cards">${storage.map((b) => `
        <li>
          <a class="card binrow" href="#/bin/${encodeURIComponent(b.id)}">
            <span class="binchip store big"${bins.chipStyle(b)}>${esc(bins.binShort(b))}</span>
            <div class="cardtext">
              <div class="cardname">${esc(b.label)}</div>
              <div class="cardmeta">${fmt(count(b.id))} ${count(b.id) === 1 ? 'brick' : 'bricks'}${b.desc ? ` · ${esc(b.desc)}` : ''}${paletteDots(b) ? ` ${paletteDots(b)}` : ''}${b.full ? ' · <span class="tag warn">Full</span>' : ''}${wantedLines(b.id) ? ` · <span class="tag ok">${wantedLines(b.id)} ${wantedLines(b.id) === 1 ? 'line' : 'lines'} wanted by active sets</span>` : ''}</div>
            </div>
            <span class="chev" aria-hidden="true">›</span>
          </a>
        </li>`).join('')}</ul>
    </section>
    `;

  $('#addBin').addEventListener('click', async () => { if (await editBinDialog(null, ctx, [])) await renderBins(); });
}

const $ = (sel) => view.querySelector(sel);

// A file of what is in each storage bin, the current rules and recent choices, to share for tuning the rules.
export async function exportSorting(ctx) {
  const label = (id) => ctx.bins.find((b) => b.id === id)?.label || id;
  const colour = (id) => refdata.ref.colorById.get(id);
  const storage = ctx.bins.filter((b) => b.type === 'storage' && !b.deleted);
  const lines = [];
  for (const b of storage) {
    for (const l of ctx.byBin.get(b.id) || []) {
      const c = colour(l.color_id);
      lines.push({ bin: b.label, part_num: l.part_num, name: l.name, category: refdata.categoryName(l.cat_id), colour: l.color_name, colour_group: c ? refdata.colorGroup(c) : null, qty: l.qty, sticker: !!l.sticker, printed: !!l.printed, note: l.note || undefined });
    }
  }
  const log = (await db.getSetting('storageLog')) || [];
  const out = {
    exported: new Date().toISOString(),
    note: 'Pieces held in storage bins, the storage rules in force, and the last storage choices made on this device.',
    storage_bins: storage.map((b) => ({ label: b.label, description: b.desc || '', full: !!b.full, pieces: partCount(ctx.byBin.get(b.id) || []), colour_rule: bins.binPalette(b).map((i) => colour(i)?.name).filter(Boolean) })),
    category_rules: Object.entries(ctx.catMap || {}).map(([cat, bin]) => ({ category: refdata.categoryName(Number(cat)), bin: label(bin) })),
    part_exceptions: Object.entries(ctx.overrides || {}).map(([part, bin]) => ({ part_num: part, bin: label(bin) })),
    recent_choices: log.map((e) => ({ when: e.t, category: refdata.categoryName(e.cat), part_num: e.part, colour: e.col != null ? colour(e.col)?.name : undefined, chosen: label(e.bin), suggested: e.sug ? label(e.sug) : null })),
    lines,
  };
  const blob = new Blob([JSON.stringify(out, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `brick-sorter-storage-${out.exported.slice(0, 10)}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  return `Exported ${pl(lines.length, 'brick type', 'brick types')} from ${pl(storage.length, 'storage bin', 'storage bins')}.`;
}

export async function drawRules() {
  const ctx = await bins.loadContext();
  const storage = ctx.bins.filter((b) => b.type === 'storage' && !b.locked).sort((a, b) => (a.order || 0) - (b.order || 0));
  const cats = Object.entries(ctx.catMap);
  const parts = Object.entries(ctx.overrides);
  const select = (kind, key, current) => `
    <select data-rule-kind="${kind}" data-rule-key="${esc(key)}" aria-label="Storage bin">
      ${storage.map((b) => `<option value="${esc(b.id)}"${b.id === current ? ' selected' : ''}>${esc(b.label)}</option>`).join('')}
    </select>`;
  const partName = (pn) => {
    const i = refdata.ref.byNum.get(String(pn).toLowerCase());
    return i === undefined ? pn : `${refdata.ref.parts[i][1]} (${pn})`;
  };
  const log = (await db.getSetting('storageLog')) || [];
  const labelOf = (id) => ctx.bins.find((b) => b.id === id)?.label || 'a deleted bin';
  const recentText = (id) => {
    const r = bins.recentChoices(log, id);
    return r.length ? `<br><small>Lately: ${r.map((x) => `${esc(labelOf(x.bin))} × ${x.n}`).join(', ')}</small>` : '';
  };
  const rows = [
    ...cats.map(([id, bin]) => `
      <li><span>${esc(refdata.categoryName(Number(id)))} <small>(every part)</small>${recentText(id)}</span>
      ${select('category', id, bin)}<button class="linkbtn" data-rule-del="category" data-rule-key="${esc(id)}">Remove</button></li>`),
    ...parts.map(([pn, bin]) => `
      <li><span>${esc(partName(pn))}</span>
      ${select('part', pn, bin)}<button class="linkbtn" data-rule-del="part" data-rule-key="${esc(pn)}">Remove</button></li>`),
  ];
  const body = view.querySelector('#rulesBody');
  body.innerHTML = rows.length
    ? `<p class="hint">Where bricks that no active set needs are stored. A rule for one part beats the rule for its category. The rules follow you: choose a different bin and that part goes there next time, and when most recent bricks of a category go to one bin, the category follows. A full bin is skipped.</p><ul class="rulelist">${rows.join('')}</ul>`
    : '<p class="hint">No rules yet. The first time a brick needs storage, the app asks which bin and remembers.</p>';
  body.onchange = async (e) => {
    const s = e.target.closest('select[data-rule-kind]');
    if (!s) return;
    const name = s.dataset.ruleKind === 'category' ? 'categoryMap' : 'partOverrides';
    const map = { ...((await db.getSetting(name)) || {}), [s.dataset.ruleKey]: s.value };
    await db.setSetting(name, map);
    toast('Updated the storage rule.');
  };
  body.onclick = async (e) => {
    const b = e.target.closest('[data-rule-del]');
    if (!b) return;
    await bins.removeRule(b.dataset.ruleDel, b.dataset.ruleKey);
    await drawRules();
  };
}

// ---------- One bin (or all bricks) ----------

let binMode = 'missing'; // 'missing' | 'found' for active bins
const pickOpen = new Set(); // storage bins expanded in the pick list
let pickOnly = false; // missing list: only bricks that are sitting in storage
let colorFilter = null; // colour id chosen with the Colour Wall (bin view)
let offOnly = false; // storage bin: only lines outside the bin’s colour rule
let neededOnly = false; // storage bin: only lines an active set still wants

export async function renderBin(id, keepMode = false) {
  if (!keepMode) { binMode = 'missing'; pickOnly = false; pickOpen.clear(); colorFilter = null; neededOnly = false; offOnly = false; }
  const ctx = await bins.loadContext();
  const isAll = id === 'all';
  const bin = isAll ? null : ctx.bins.find((b) => b.id === id);
  if (!isAll && !bin) {
    setTitle('Bin not found');
    view.innerHTML = '<p class="empty">That bin doesn’t exist any more. <a href="#/bins">Back to bins</a></p>';
    return;
  }
  await refdata.loadRef().catch(() => {});
  const lines = isAll ? [...ctx.byBin.values()].flat() : (ctx.byBin.get(bin.id) || []);
  lines.sort((a, b) => (a.name || '').localeCompare(b.name || '') || a.color_name.localeCompare(b.color_name));

  const wm = bins.wantedMap(ctx);
  const wantedFor = (l) => (l.part_num && (wm.get(`${l.part_num}|${l.color_id}`) || [])) || [];
  const wantedCount = lines.filter((l) => wantedFor(l).length && ctx.bins.find((b) => b.id === l.bin_id)?.type === 'storage').length;
  const title = isAll ? 'All bricks' : bins.binLabel(bin, ctx.setsByNum);
  const isActive = !isAll && bin.type === 'active';
  let missing = [];
  const catOfPart = new Map(); // part number -> the set list’s category name (active bins)
  if (isActive) {
    const held = new Map();
    for (const l of lines) held.set(`${l.part_num}|${l.color_id}`, (held.get(`${l.part_num}|${l.color_id}`) || 0) + l.qty);
    const setRows = await db.byIndex('setParts', 'set_num', bin.set_num);
    for (const r of setRows) if (!catOfPart.has(r.part_num)) catOfPart.set(r.part_num, r.cat_name || 'Other');
    missing = setRows
      .map((l) => ({ ...l, have: held.get(`${l.part_num}|${l.color_id}`) || 0 }))
      .map((l) => ({ ...l, rem: l.qty - l.have }))
      .filter((l) => l.rem > 0)
      .sort((a, b) => a.cat_name.localeCompare(b.cat_name) || a.name.localeCompare(b.name) || String(a.color_name).localeCompare(String(b.color_name)));
    // Matching bricks already sitting in storage bins (the pick list).
    const stock = new Map();
    for (const b of ctx.bins.filter((x) => x.type === 'storage')) {
      for (const l of ctx.byBin.get(b.id) || []) {
        if (!l.part_num) continue;
        const k = `${l.part_num}|${l.color_id}`;
        if (!stock.has(k)) stock.set(k, []);
        stock.get(k).push({ line: l, bin: b });
      }
    }
    for (const m of missing) {
      m.stock = stock.get(`${m.part_num}|${m.color_id}`) || [];
      m.avail = m.stock.reduce((n, x) => n + x.line.qty, 0);
    }
  }
  if (isActive) lines.sort((a, b) => (catOfPart.get(a.part_num) || 'Other').localeCompare(catOfPart.get(b.part_num) || 'Other') || (a.name || '').localeCompare(b.name || '') || a.color_name.localeCompare(b.color_name));
  // Active bins show the same category headings as the set’s parts list.
  const groupByCategory = (cats) => {
    const ul = listEl.querySelector('ul.parts');
    if (!ul) return;
    const lis = [...ul.children];
    const out = document.createDocumentFragment();
    let cur = null;
    let curUl = null;
    let head = null;
    let n = 0;
    const flush = () => { if (head) head.innerHTML = `${esc(cur)} <small>${n}</small>`; };
    lis.forEach((li, i) => {
      if (cats[i] !== cur) {
        flush();
        cur = cats[i];
        n = 0;
        head = document.createElement('h3');
        head.className = 'cat';
        curUl = document.createElement('ul');
        curUl.className = 'parts';
        out.append(head, curUl);
      }
      curUl.append(li);
      n++;
    });
    flush();
    listEl.replaceChildren(out);
  };
  const pickCount = missing.filter((m) => m.avail > 0).length;
  const missingCount = missing.reduce((n, l) => n + l.rem, 0);
  setTitle(isAll ? 'All bricks' : bin.type === 'active' ? `Bin ${bin.number}` : bin.label);

  let head = '';
  if (!isAll && bin.type === 'active') {
    const a = ctx.active.find((x) => x.bin.id === bin.id);
    const pct = a ? Math.round(a.frac * 100) : 0;
    const img = a?.set.img || null;
    const ico = (d) => `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
    head = `
      <section class="panel binpanel">
        <button type="button" class="iconbtn editbtn" id="binColor" aria-label="Edit bin">${ico('<path d="M4 20l1-4L16.5 4.5a2.1 2.1 0 013 3L8 19z"/><path d="M14 7l3 3"/>')}</button>
        <div class="binhead">
          <div class="setpic" style="--p:${pct / 100}" role="img" aria-label="${pct}% complete">
            ${img ? `<img src="${esc(img)}" alt="">` : ''}
            <span class="pctbadge" aria-hidden="true">${pct}%</span>
          </div>
          <div class="binhead-text">
            <h2 class="setname">${bins.colorSquare(bin)}${esc(a?.set.name || 'Set')}</h2>
            <p class="cardmeta">${esc(bin.set_num)}${a ? `<br>${fmt(a.heldTotal)} of ${fmt(a.neededTotal)} bricks` : ''}</p>
          </div>
        </div>
        <div class="binfoot">
          <button type="button" class="btn" id="createOrder">Create order</button>
          <button type="button" class="iconbtn trash" id="abandon" aria-label="Remove this bin">${ico('<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 10v6M14 10v6"/>')}</button>
        </div>
      </section>`;
  } else if (!isAll) {
    head = `
      <section class="panel binpanel">
        ${bin.locked ? '' : `<button type="button" class="iconbtn editbtn" id="editBin" aria-label="Edit bin"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20l1-4L16.5 4.5a2.1 2.1 0 013 3L8 19z"/><path d="M14 7l3 3"/></svg></button>`}
        <h2 class="setname">${bins.colorSquare(bin)}${esc(bin.label)}</h2>
        <p class="cardmeta">${fmt(partCount(lines))} ${partCount(lines) === 1 ? 'brick' : 'bricks'}${bin.desc ? ` · ${esc(bin.desc)}` : ''}</p>
        ${bin.locked ? '' : paletteRow(bin)}
        ${bin.full ? '<p class="hint">This bin is full. Nothing new is suggested or accepted here until you reopen it.</p>' : ''}
        ${bin.locked ? '<div class="actions"><button class="btn" id="binColor">Bin colour</button></div>' : `<div class="binfoot">
          <div class="openfull" role="group" aria-label="Bin status">
            <button type="button" id="openBtn" aria-pressed="${!bin.full}">Open</button>
            <button type="button" id="fullBtn" aria-pressed="${!!bin.full}">Full</button>
          </div>
          <button type="button" class="iconbtn trash" id="delBin" aria-label="Remove this storage bin"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 10v6M14 10v6"/></svg></button>
        </div>`}
      </section>`;
  }

  view.innerHTML = `
    <a class="backlink" href="#/bins">‹ Store</a>
 ${head}
    <section class="panel">
      <h2 class="panelhead">Inventory</h2>
      ${isActive ? `<div class="segmented" role="tablist">
        <button type="button" role="tab" data-mode="missing" aria-selected="${binMode === 'missing'}">Missing (${fmt(missingCount)})</button>
        <button type="button" role="tab" data-mode="found" aria-selected="${binMode === 'found'}">Found (${fmt(partCount(lines))})</button>
 </div>
      ${binMode === 'missing' && pickCount ? `<button type="button" class="chip pickchip" id="pickToggle" aria-pressed="${pickOnly}">In storage: ${fmt(pickCount)} ${pickCount === 1 ? 'part' : 'parts'} to pick</button>` : ''}` : ''}
      ${!isActive && wantedCount ? `<button type="button" class="chip pickchip" id="neededToggle" aria-pressed="${neededOnly}">Wanted by active sets: ${fmt(wantedCount)} ${wantedCount === 1 ? 'line' : 'lines'}</button>` : ''}
      ${(() => { const n = (!isAll && bin.type === 'storage' && bins.binPalette(bin).length) ? lines.filter((l) => !bins.acceptsColour(bin, l.color_id)).length : 0; return n ? `<button type="button" class="chip pickchip" id="offToggle" aria-pressed="${offOnly}">Outside this bin’s colour rule: ${fmt(n)} ${n === 1 ? 'line' : 'lines'}</button>` : ''; })()}
      <label for="filter" class="sr">Filter bricks</label>
      <input id="filter" type="search" placeholder="Search name, part no. or colour" autocomplete="off">
      <div class="colorfilter" id="colorChips"></div>
      <p class="hint" id="count"></p>
      <div id="bulkRow" class="bulkrow" hidden></div>
      <div id="lineList"></div>
    </section>`;

  const listEl = $('#lineList');
  const match = (l, q) => `${l.name} ${l.part_num} ${l.color_name} ${l.note || ''}`.toLowerCase().includes(q);
  const byColor = (l) => colorFilter === null || l.color_id === colorFilter;
  const showMissing = isActive && binMode === 'missing';
  const offLines = !isAll && bin.type === 'storage' && bins.binPalette(bin).length ? lines.filter((l) => !bins.acceptsColour(bin, l.color_id)) : [];
  let shownLines = neededOnly && !isActive ? lines.filter((l) => wantedFor(l).length && ctx.bins.find((b) => b.id === l.bin_id)?.type === 'storage') : lines;
  if (offOnly && offLines.length) shownLines = offLines;
  const basePool = showMissing ? (pickOnly ? missing.filter((l) => l.avail > 0) : missing) : shownLines;
  // Colour chips: the colours in this list, most bricks first.
  const chipMap = new Map();
  for (const l of basePool) {
    const c = chipMap.get(l.color_id) || { id: l.color_id, name: l.color_name, rgb: l.rgb, trans: !!l.is_trans || /^Trans/i.test(l.color_name || ''), n: 0 };
    c.n += showMissing ? l.rem : l.qty;
    chipMap.set(l.color_id, c);
  }
  if (colorFilter !== null && !chipMap.has(colorFilter)) colorFilter = null;
  const drawChips = () => {
    const el = $('#colorChips');
    const cur = colorFilter === null ? null : chipMap.get(colorFilter);
    el.hidden = chipMap.size < 2 && colorFilter === null;
    el.innerHTML = `<button type="button" class="colorbtn${cur ? '' : ' empty'}" id="cfBtn" aria-label="Filter">
        <span>Filter</span>${cur ? `<span class="swatch lg${cur.trans ? ' trans' : ''}" style="--c:#${esc(safe(cur.rgb))}"></span><span>${esc(cur.name)} · ${fmt(cur.n)}</span>` : ''}
      </button>${cur ? '<button type="button" class="btn small" id="cfClear">Clear</button>' : ''}`;
  };
  const safe = (rgb) => (/^[0-9a-f]{6}$/i.test(rgb || '') ? rgb : '999999');
  let bulkShown = [];
  const draw = (q) => {
    const needle = q.trim().toLowerCase();
    if (showMissing) {
      const pool = basePool.filter(byColor);
      const shown = needle ? pool.filter((l) => match(l, needle)) : pool;
      $('#count').textContent = missing.length
        ? `${pl(shown.reduce((n, l) => n + l.rem, 0), 'brick', 'bricks')} still missing`
        : '';
      if (!shown.length) {
        listEl.innerHTML = `<p class="empty">${missing.length ? 'No bricks match.' : 'Nothing missing. This set is complete!'}</p>`;
        return;
      }
      const rowHtml = (l, from) => `
        <li class="part">
          <span class="thumb">${l.img ? `<img src="${esc(l.img)}" alt="" loading="lazy">` : ''}</span>
          <span class="pinfo">
            <span class="pname">${esc(l.name)}</span>
            <span class="pmeta">
              ${from ? '<br>' : ''}<span class="swatch${l.is_trans ? ' trans' : ''}" style="--c:#${esc(l.rgb)}"></span>
              ${esc(l.color_name)}${from ? '' : ` · ${esc(l.part_num)}`}${l.sticker ? ' <span class="tag">sticker</span>' : ''}
              ${l.have && !from ? `<br>Have ${fmt(l.have)} of ${fmt(l.qty)}` : ''}
              ${l.avail ? (from ? `<br><span class="tag sm ${from.qty >= l.rem ? 'ok' : 'bad'}">${fmt(from.qty)} available · ${fmt(l.rem)} required</span>` : `<br><span class="tag ok">In storage: ${fmt(l.avail)} · ${esc([...new Set(l.stock.map((x) => x.bin.label))].join(', '))}</span>`) : ''}
            </span>
          </span>
          ${from ? '' : `<span class="qty">${fmt(l.rem)}</span>`}
          <span class="btns">
            ${from ? (() => { const n = Math.min(l.rem, from.qty); return `<div class="stepper pickstep" role="group" aria-label="Quantity"><button type="button" data-step="-1" aria-label="One fewer">−</button><input class="pqty" type="number" inputmode="numeric" min="1" max="${n}" step="1" value="1" aria-label="Quantity"><button type="button" data-step="1" aria-label="One more">+</button></div><button type="button" class="btn small lozenge primary" data-take="${esc(l.id)}" data-from="${esc(from.bin.id)}">Found</button>`; })() : l.avail ? `<button type="button" class="btn small primary" data-take="${esc(l.id)}">Take ${fmt(Math.min(l.rem, l.avail))}</button>` : ''}
            ${from ? '' : `<button type="button" class="btn small" data-found="${esc(l.id)}">Found</button>`}
          </span>
        </li>`;
      if (pickOnly) {
        // Picking from storage: one heading per storage bin, so a trip to the oddments bin gets everything from it.
        const order = new Map(ctx.bins.filter((x) => x.type === 'storage').map((x, i) => [x.id, [x.order ?? i, x.label]]));
        const groups = new Map();
        for (const l of shown) {
          const perBin = new Map();
          for (const x of l.stock) { const g = perBin.get(x.bin.id) || { bin: x.bin, qty: 0 }; g.qty += x.line.qty; perBin.set(x.bin.id, g); }
          for (const g of perBin.values()) { if (!groups.has(g.bin.id)) groups.set(g.bin.id, { bin: g.bin, items: [] }); groups.get(g.bin.id).items.push([l, g]); }
        }
        const sorted = [...groups.values()].sort((x, y) => (order.get(x.bin.id)?.[0] ?? 0) - (order.get(y.bin.id)?.[0] ?? 0) || String(x.bin.label).localeCompare(String(y.bin.label)));
        listEl.innerHTML = sorted.map((g) => `<button type="button" class="card binrow pickgroup" data-pg="${esc(g.bin.id)}" aria-expanded="${pickOpen.has(g.bin.id)}"><div class="cardtext"><div class="cardname">${esc(g.bin.label)}</div><div class="cardmeta">${pl(g.items.length, 'part', 'parts')} to pick</div></div><span class="pgcaret" aria-hidden="true">›</span><span class="binchip store big"${bins.chipStyle(g.bin)}>${esc(bins.binShort(g.bin))}</span></button><ul class="parts"${pickOpen.has(g.bin.id) ? '' : ' hidden'}>${g.items.map(([l, f]) => rowHtml(l, f)).join('')}</ul>`).join('');
        return;
      }
      listEl.innerHTML = `<ul class="parts">${shown.map((l) => rowHtml(l)).join('')}</ul>`;
      groupByCategory(shown.map((l) => l.cat_name || 'Other'));
      return;
    }
    const pool = shownLines.filter(byColor);
    const shown = needle ? pool.filter((l) => match(l, needle)) : pool;
    $('#count').textContent = `${pl(partCount(shown), 'brick', 'bricks')}`;
    bulkShown = shown;
    const bulk = $('#bulkRow');
    const canBulk = bin?.type === 'storage' && !isAll && shown.length > 0;
    bulk.hidden = !canBulk;
    if (canBulk) bulk.innerHTML = `<button type="button" class="btn" id="bulkMove">Move ${colorFilter !== null || needle ? 'these' : 'all'} ${pl(partCount(shown), 'brick', 'bricks')} to another bin…</button>`;
    if (!shown.length) {
      listEl.innerHTML = `<p class="empty">${lines.length ? 'No bricks match.' : isAll ? 'Nothing has been sorted yet.' : 'Nothing found yet. Use the Missing tab or the Log tab.'}</p>`;
      return;
    }
    listEl.innerHTML = `<ul class="parts">${shown.map((l) => {
      const b = isAll ? ctx.bins.find((x) => x.id === l.bin_id) : null;
      const url = l.part_num ? refdata.partImg(l.part_num, l.color_id, null) : null;
      const inStore = ctx.bins.find((x) => x.id === l.bin_id)?.type === 'storage';
      const wants = inStore ? wantedFor(l) : [];
      const canMove = wants.length || (!inStore && l.part_num && b?.type !== 'storage' && (isAll ? b?.type === 'active' : isActive));
      return `
      <li class="part${canMove ? ' haswrap' : ''}">
        <button type="button" class="linebtn" data-line="${esc(l.id)}">
          <span class="thumb">${url ? `<img src="${esc(url)}" alt="" loading="lazy">` : ''}</span>
          <span class="pinfo">
            <span class="pname">${esc(l.name)}</span>
            <span class="pmeta">
              <span class="swatch${/^Trans/i.test(l.color_name) ? ' trans' : ''}" style="--c:#${esc(l.rgb)}"></span>
              ${esc(l.color_name)}${l.part_num ? ` · ${esc(l.part_num)}` : ''}${tagsHtml(l)}${b ? ` · ${esc(b.type === 'active' ? `Bin ${b.number}` : b.label)}` : ''}
              ${l.note ? `<br><em>${esc(l.note)}</em>` : ''}
              ${wants.length ? `<br><span class="tag ok">Wanted: ${wants.map((w) => `Bin ${w.bin.number} (${fmt(w.rem)})`).join(', ')}</span>` : ''}
            </span>
          </span>
          <span class="qty">${fmt(l.qty)}</span>
        </button>
        ${canMove ? `<div class="moverow"><button type="button" class="btn small${wants.length ? ' primary' : ''}" data-move="${esc(l.id)}">${wants.length ? `Move to Bin ${wants[0].bin.number}…` : 'Move…'}</button></div>` : ''}
      </li>`;
    }).join('')}</ul>`;
    if (isActive) groupByCategory(shown.map((l) => catOfPart.get(l.part_num) || 'Other'));
  };
  drawChips();
  draw('');
  $('#colorChips').addEventListener('click', async (e) => {
    if (e.target.closest('#cfClear')) colorFilter = null;
    else if (e.target.closest('#cfBtn')) {
      for (;;) {
        const c = colorFilter === null ? null : chipMap.get(colorFilter);
        const v = await openDialog(`
          <h2>Filter inventory</h2>
          <button class="btn block editrow" value="colour" formnovalidate><span>Colour</span><small>${c ? `${esc(c.name)} · ${fmt(c.n)}` : 'Any colour'}</small></button>
          <div class="row spread">
            <button class="btn" value="clear" formnovalidate>Clear filter</button>
            <span class="grow"></span>
            <button class="btn primary" value="done" formnovalidate>Done</button>
          </div>`);
        if (v === 'clear') { colorFilter = null; break; }
        if (v !== 'colour') break;
        const only = new Map([...chipMap].map(([cid, x]) => [cid, x.n]));
        const r = await pickColor(colorFilter, { only, clearLabel: 'Show all colours', title: 'Colour Wall · this bin' });
        if (r === null) continue;
        colorFilter = r === 'clear' ? null : r;
        break;
      }
    } else return;
    drawChips();
    draw($('#filter').value);
  });
  $('#bulkRow').addEventListener('click', async (e) => {
    if (!e.target.closest('#bulkMove')) return;
    if (await bulkMoveDialog(bulkShown, ctx, bin)) await renderBin(id, true);
  });
  $('#filter').addEventListener('input', (e) => draw(e.target.value));
  view.querySelector('.segmented')?.addEventListener('click', (e) => {
    const m = e.target.closest('[data-mode]');
    if (!m) return;
    binMode = m.dataset.mode;
    renderBin(id, true);
  });
  $('#offToggle')?.addEventListener('click', () => { offOnly = !offOnly; renderBin(id, true); });
  $('#neededToggle')?.addEventListener('click', () => { neededOnly = !neededOnly; renderBin(id, true); });
  $('#pickToggle')?.addEventListener('click', () => { pickOnly = !pickOnly; renderBin(id, true); });
  const clampQty = (inp) => { const max = Number(inp.max) || 1; inp.value = String(Math.max(1, Math.min(max, Math.floor(Number(inp.value)) || 1))); };
  listEl.addEventListener('change', (e) => { if (e.target.classList?.contains('pqty')) clampQty(e.target); });
  listEl.addEventListener('click', async (e) => {
    const pg = e.target.closest('[data-pg]');
    if (pg) {
      const open = pg.getAttribute('aria-expanded') !== 'true';
      pg.setAttribute('aria-expanded', String(open));
      pg.nextElementSibling.hidden = !open;
      if (open) pickOpen.add(pg.dataset.pg); else pickOpen.delete(pg.dataset.pg);
      return;
    }
    const st = e.target.closest('[data-step]');
    if (st) { const inp = st.parentElement.querySelector('.pqty'); inp.value = String((Number(inp.value) || 1) + Number(st.dataset.step)); clampQty(inp); return; }
    const tb = e.target.closest('[data-take]');
    if (tb) {
      const row = missing.find((l) => l.id === tb.dataset.take);
      if (row && await takeFromStorage(row, bin, tb.dataset.from || null, tb.closest('li').querySelector('.pqty') ? Number(tb.closest('li').querySelector('.pqty').value) : null)) await renderBin(id, true);
      return;
    }
    const fb = e.target.closest('[data-found]');
    if (fb) {
      const row = missing.find((l) => l.id === fb.dataset.found);
      if (row && await markFound(row, bin)) { await renderBin(id, true); await celebrate(); }
      return;
    }
    const mv = e.target.closest('[data-move]');
    if (mv) {
      const ln = lines.find((l) => l.id === mv.dataset.move);
      if (ln && await moveLineDialog(ln, ctx, wm)) { await renderBin(id, true); await celebrate(); }
      return;
    }
    const btn = e.target.closest('[data-line]');
    if (!btn) return;
    const line = lines.find((l) => l.id === btn.dataset.line);
    if (line && await editLine(line, ctx)) await renderBin(id, true);
  });

  $('#binColor')?.addEventListener('click', async () => { await binColourDialog(bin); await renderBin(id, true); });
  $('#editBin')?.addEventListener('click', async () => { await editBinDialog(bin, ctx, lines); await renderBin(id, true); });
  $('#openBtn')?.addEventListener('click', () => setFull(false));
  $('#fullBtn')?.addEventListener('click', () => setFull(true));
  $('#createOrder')?.addEventListener('click', async () => { const set = ctx.setsByNum.get(bin.set_num) || (await db.get('sets', bin.set_num)); if (set) await orderDialog({ set, missing }); });
  $('#abandon')?.addEventListener('click', async () => {
    if (await confirmAbandon(bin.id)) location.hash = '#/bins';
  });
  const setFull = async (full) => {
    if (!!bin.full === full) return;
    await bins.setBinFull(bin.id, full);
    toast(full ? `${bin.label} marked as full.` : `${bin.label} is open again.`);
    await renderBin(id, true);
  };
  $('#delBin')?.addEventListener('click', async () => {
    if (!(await ask({ title: 'Remove this bin?', body: `${bin.label} will be removed. Its bricks stay in the app. Any storage rules that point to it will ask again next time.`, ok: 'Remove', danger: true }))) return;
    try {
      await bins.deleteStorageBin(bin.id);
      location.hash = '#/bins';
    } catch (err) { toast(err.message); }
  });
  void title;
}

// Asks first; then deletes every brick in the bin and returns the set to the catalogue.
export async function confirmAbandon(binId) {
  const ctx = await bins.loadContext();
  const bin = ctx.bins.find((b) => b.id === binId);
  if (!bin) return false;
  const lines = ctx.byBin.get(binId) || [];
  const bricks = partCount(lines);
  const set = ctx.setsByNum.get(bin.set_num);
  const name = `Bin ${bin.number}${set ? ` (${set.name})` : ''}`;
  const body = bricks
    ? `The ${fmt(bricks)} ${bricks === 1 ? 'brick' : 'bricks'} sorted into this bin will be removed from the app. This can’t be undone. The set stays in your catalogue and you can start it again later.`
    : 'This bin is empty. The set stays in your catalogue and you can start it again later.';
  const ok = await ask({
    title: `Remove ${name}?`,
    body,
    ok: 'Remove',
    danger: true,
  });
  if (!ok) return false;
  const res = await bins.abandonBin(binId);
  toast(res.pieces ? `Removed Bin ${bin.number} and ${fmt(res.pieces)} bricks.` : `Removed Bin ${bin.number}.`);
  return true;
}

// ---------- Mark a missing brick as found ----------

async function markFound(row, bin) {
  let qty = row.rem;
  if (row.rem > 1) {
    const { value, data } = await openDialog(`
      <h2>${esc(row.name)}</h2>
      <p class="hint">${esc(row.color_name)} · ${esc(row.part_num)} · ${fmt(row.rem)} still missing</p>
      <label for="fq">How many did you find?</label>
      ${stepperHtml({ id: 'fq', name: 'qty', value: 1, max: row.rem })}
      <div class="row">
        <button class="btn" value="cancel" formnovalidate>Cancel</button>
        <button class="btn primary" value="ok">Add to Bin ${bin.number}</button>
      </div>`, { data: true });
    if (value !== 'ok') return false;
    qty = Number(data.get('qty'));
    if (!Number.isInteger(qty) || qty < 1 || qty > row.rem) { toast(`Enter a number from 1 to ${row.rem}.`); return false; }
  }
  await bins.saveToBins({
    part: { part_num: row.part_num, name: row.name, cat_id: row.cat_id },
    color: { id: row.color_id, name: row.color_name, rgb: row.rgb },
    flags: { sticker: !!row.sticker, printed: false, other: false },
    note: '',
    items: [{ binId: bin.id, qty }],
  });
  toast(`Found ${fmt(qty)} × ${row.name}.`);
  return true;
}

// Moves bricks from storage bins into this active bin.
async function takeFromStorage(row, bin, fromBin = null, fixedQty = null) {
  const stock = fromBin ? row.stock.filter((x) => x.bin.id === fromBin) : row.stock;
  const avail = stock.reduce((n, x) => n + x.line.qty, 0);
  const max = Math.min(row.rem, avail);
  let qty = fixedQty ? Math.min(fixedQty, max) : max;
  if (max > 1 && !fixedQty) {
    const { value, data } = await openDialog(`
      <h2>${esc(row.name)}</h2>
      <p class="hint">${esc(row.color_name)} · ${esc(row.part_num)} · ${fmt(avail)} in ${fromBin ? esc(stock[0]?.bin.label || 'storage') : 'storage'}, ${fmt(row.rem)} needed</p>
      <label for="tq">How many are you taking out of storage?</label>
      ${stepperHtml({ id: 'tq', name: 'qty', value: max, max })}
      <div class="row">
        <button class="btn" value="cancel" formnovalidate>Cancel</button>
        <button class="btn primary" value="ok">Move to Bin ${bin.number}</button>
      </div>`, { data: true });
    if (value !== 'ok') return false;
    qty = Number(data.get('qty'));
    if (!Number.isInteger(qty) || qty < 1 || qty > max) { toast(`Enter a number from 1 to ${max}.`); return false; }
  }
  const now = new Date().toISOString();
  let left = qty;
  for (const { line } of stock) {
    if (left <= 0) break;
    const take = Math.min(left, line.qty);
    await db.put('inventory', take === line.qty
      ? { ...line, qty: 0, deleted: true, updated: now }
      : { ...line, qty: line.qty - take, updated: now });
    left -= take;
  }
  await bins.saveToBins({
    part: { part_num: row.part_num, name: row.name, cat_id: row.cat_id },
    color: { id: row.color_id, name: row.color_name, rgb: row.rgb },
    flags: { sticker: !!row.sticker, printed: false, other: false },
    note: '',
    items: [{ binId: bin.id, qty }],
    log: false, // a move from storage isn’t new sorting
  });
  toast(`Moved ${fmt(qty)} × ${row.name} to Bin ${bin.number}.`);
  return true;
}

// Edit a bin’s colours (up to four). Resolves true if saved.
async function binColourDialog(bin, { draft = false } = {}) {
  let sel = bins.binColors(bin);
  const nameOf = (hex) => {
    const c = [...refdata.ref.colorById.values()].find((x) => `#${x.rgb}`.toLowerCase() === hex.toLowerCase());
    return c ? c.name : 'Custom';
  };
  for (;;) {
    const shares = { 1: ['whole bin'], 2: ['half', 'half'], 3: ['half', 'quarter', 'quarter'], 4: ['quarter', 'quarter', 'quarter', 'quarter'] }[sel.length] || [];
    const { value } = await openDialog(`
      <h2>Bin colours</h2>
      <p class="hint">Choose up to four. Two split the bin in half, three give the first a half and the others a quarter each, four are quarters.</p>
      <div class="binpreview"><span class="binchip big"${bins.chipStyle({ colors: sel })}>${esc((bin.type === 'active' ? `Bin ${bin.number}` : bins.binShort(bin)))}</span></div>
      <ul class="bincolors">${sel.map((h, i) => `
        <li><span class="swatch lg" style="--c:${h}"></span><span class="grow">${esc(nameOf(h))} <small>${shares[i]}</small></span>
        <button class="btn small" value="rm${i}" formnovalidate aria-label="Remove ${esc(nameOf(h))}">Remove</button></li>`).join('') || '<li class="hint">No colour yet.</li>'}</ul>
      ${sel.length < 4 ? '<button class="btn block" value="add" formnovalidate>+ Add a LEGO colour</button>' : ''}
      <div class="row spread">
        <button class="btn" value="reset" formnovalidate>Clear</button>
        <span class="grow"></span>
        <button class="btn" value="cancel" formnovalidate>Cancel</button>
        <button class="btn primary" value="save">Save</button>
      </div>`, { data: true });
    if (!value || value === 'cancel') return draft ? null : false;
    if (value === 'save') { if (draft) return sel; await bins.setBinColors(bin.id, sel); return true; }
    if (value === 'reset') { sel = []; continue; }
    if (value === 'add') {
      const cid = await pickColor(null, { allOnly: true });
      const c = cid === null || cid === undefined ? null : refdata.ref.colorById.get(cid);
      if (c) sel = [...sel, `#${c.rgb}`.toLowerCase()].slice(0, 4);
      continue;
    }
    const m = /^rm(\d+)$/.exec(value);
    if (m) sel = sel.filter((_, i) => i !== Number(m[1]));
  }
}

// One place for a storage bin’s settings: name, short name, colours and sorting rules. Pass bin = null to
// make a new bin. Nothing is saved until Save. Resolves true if a bin was created or changed.
export async function editBinDialog(bin, ctx, lines) {
  const isNew = !bin;
  const d = {
    label: bin?.label || '', short: bin?.short || '',
    colors: bins.binColors(bin), palette: bins.binPalette(bin),
  };
  let err = '';
  for (;;) {
    const view = { ...(bin || { type: 'storage', label: d.label }), label: d.label, colors: d.colors, color: d.colors[0] || null, palette: d.palette.length ? d.palette : null, short: d.short };
    const { value, data } = await openDialog(`
      <h2>${isNew ? 'Add bin' : 'Edit bin'}</h2>
      ${err ? `<p class="hint err" role="alert">${esc(err)}</p>` : ''}
      <label for="eb">Name</label>
      <input id="eb" name="name" maxlength="30" required autocomplete="off" value="${esc(d.label)}">
      <label for="es">Short name on the tile <small class="hint">up to 3 characters</small></label>
      <input id="es" name="short" maxlength="3" autocomplete="off" placeholder="${esc((d.label || 'AB').slice(0, 2).toUpperCase())}" value="${esc(d.short)}">
      <div class="editrows">
        <button class="btn block editrow" value="colour" formnovalidate><span>Bin colour</span>${d.colors.length ? bins.colorSquare(view) : '<small>Not set</small>'}</button>
        <button class="btn block editrow" value="rule" formnovalidate><span>Sorting rule · colours</span><small>${d.palette.length ? `${d.palette.length} ${d.palette.length === 1 ? 'colour' : 'colours'}` : 'Any colour'}</small></button>
      </div>
      <div class="row spread">
        <button class="btn" value="cancel" formnovalidate>Cancel</button>
        <button class="btn primary" value="save">${isNew ? 'Add bin' : 'Save'}</button>
      </div>`, { data: true });
    d.label = String(data.get('name') || '');
    d.short = String(data.get('short') || '').trim().toUpperCase();
    err = '';
    if (!value || value === 'cancel') return false;
    if (value === 'colour') { const r = await binColourDialog(view, { draft: true }); if (r) d.colors = r; continue; }
    if (value === 'rule') { const r = await colourRuleDialog(view, ctx, lines || [], { draft: true }); if (r) d.palette = r; continue; }
    if (value === 'save') {
      try {
        let id = bin?.id;
        if (isNew) id = (await bins.addStorageBin(d.label)).id;
        else if (d.label.trim() && d.label.trim() !== bin.label) await bins.renameStorageBin(id, d.label);
        await bins.setBinShort(id, d.short);
        await bins.setBinColors(id, d.colors);
        await bins.setBinPalette(id, d.palette);
        return id;
      } catch (e) { err = e.message || 'Could not save.'; }
    }
  }
}

// Small swatches for a storage bin’s colour rule ('' if it takes any colour).
function paletteDots(bin, max = 8) {
  const ids = bins.binPalette(bin);
  const cs = ids.map((i) => refdata.ref.colorById.get(i)).filter(Boolean);
  if (!cs.length) return '';
  return `<span class="paldots" aria-hidden="true">${cs.slice(0, max).map((c) => `<span class="swatch${c.is_trans ? ' trans' : ''}" style="--c:#${esc(safeRgb(c.rgb))}"></span>`).join('')}${cs.length > max ? `<small>+${cs.length - max}</small>` : ''}</span>`;
}

function paletteRow(bin) {
  const ids = bins.binPalette(bin);
  if (!ids.length) return '<p class="hint">Takes any colour. Tap the pencil to limit this bin to certain colours.</p>';
  const names = ids.map((i) => refdata.ref.colorById.get(i)?.name).filter(Boolean);
  return `<p class="hint palrow">${paletteDots(bin, 12)} Only: ${esc(names.join(', '))}</p>`;
}

// Edit which colours a storage bin holds. Resolves true if it was changed.
async function colourRuleDialog(bin, ctx, lines, { draft = false } = {}) {
  let sel = bins.binPalette(bin);
  const colour = (i) => refdata.ref.colorById.get(i);
  for (;;) {
    const value = await openDialog(`
      <h2>Colour rule · ${esc(bin.label)}</h2>
      <p class="hint">Choose the colours that belong in this bin. New bricks in those colours are suggested here, and colours you leave out are suggested elsewhere. Leave it empty and the bin takes any colour.</p>
      <div class="flagrow">${sel.map((i) => { const c = colour(i); return c ? `<button class="chip" value="rm${i}" formnovalidate aria-label="Remove ${esc(c.name)}"><span class="swatch${c.is_trans ? ' trans' : ''}" style="--c:#${esc(safeRgb(c.rgb))}"></span> ${esc(c.name)} ✕</button>` : ''; }).join('') || '<span class="hint">Any colour.</span>'}</div>
      <button class="btn block" value="add" formnovalidate>+ Choose colours</button>
      ${lines.length ? '<button class="btn block" value="fromBin" formnovalidate>Use the colours in this bin now</button>' : ''}
      <div class="row spread">
        <button class="btn" value="reset" formnovalidate>Any colour</button>
        <span class="grow"></span>
        <button class="btn" value="cancel" formnovalidate>Cancel</button>
        <button class="btn primary" value="save">Save</button>
      </div>`);
    if (!value || value === 'cancel') return draft ? null : false;
    if (value === 'save') { if (draft) return sel; await bins.setBinPalette(bin.id, sel); toast(sel.length ? `${bin.label} now only takes ${sel.length} ${sel.length === 1 ? 'colour' : 'colours'}.` : `${bin.label} takes any colour.`); return true; }
    if (value === 'reset') { sel = []; continue; }
    if (value === 'fromBin') {
      const n = new Map();
      for (const l of lines) n.set(l.color_id, (n.get(l.color_id) || 0) + l.qty);
      const total = [...n.values()].reduce((a, b) => a + b, 0) || 1;
      sel = [...n].filter(([, q]) => q / total >= 0.03).map(([cid]) => cid); // ignore the odd stray brick
      continue;
    }
    if (value === 'add') {
      const r = await pickColor(null, { multi: sel, title: 'Colour Wall · colours for this bin' });
      if (Array.isArray(r)) sel = r;
      continue;
    }
    const m = /^rm(\d+)$/.exec(value);
    if (m) sel = sel.filter((x) => x !== Number(m[1]));
  }
}

// Moves every brick in the lines currently shown to another storage bin. Nothing moves until you confirm.
async function bulkMoveDialog(lines, ctx, from) {
  const opts = ctx.bins
    .filter((b) => !b.deleted && b.type === 'storage' && b.id !== from.id && b.id !== 'unrecognised' && !b.full)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  if (!opts.length) { toast('There is no other storage bin to move these to. Add one on the Store screen.'); return false; }
  const total = partCount(lines);
  const colours = [...new Set(lines.map((l) => l.color_name))];
  const what = colours.length === 1 ? `${colours[0]} bricks` : 'bricks';
  const { value, data } = await openDialog(`
    <h2>Move ${esc(what)}</h2>
    <p class="hint">${pl(total, 'brick', 'bricks')} from ${esc(from.label)}. Every brick currently shown moves.</p>
    <label for="bb">To</label>
    <select id="bb" name="bin">${opts.map((b) => `<option value="${esc(b.id)}">${esc(bins.binLabel(b, ctx.setsByNum))}</option>`).join('')}</select>
    <div class="row">
      <button class="btn" value="cancel" formnovalidate>Cancel</button>
      <button class="btn primary" value="ok">Move ${fmt(total)}</button>
    </div>`, { data: true });
  if (value !== 'ok') return false;
  try {
    const to = await bins.moveLines(ctx, lines, String(data.get('bin')));
    toast(`Moved ${pl(total, 'brick', 'bricks')} to ${to.label}.`);
    return true;
  } catch (e) {
    toast(e.message || 'Could not move those.');
    return false;
  }
}

// Moves some or all of a line to another bin, in either direction. Nothing moves until you confirm.
async function moveLineDialog(line, ctx, wm) {
  const k = `${line.part_num}|${line.color_id}`;
  const wants = line.part_num ? (wm.get(k) || []).filter((w) => w.bin.id !== line.bin_id) : [];
  const wantRem = new Map(wants.map((w) => [w.bin.id, w.rem]));
  const cur = ctx.bins.find((b) => b.id === line.bin_id);
  const opts = ctx.bins
    .filter((b) => !b.deleted && b.id !== line.bin_id && b.id !== 'unrecognised' && ((b.type === 'storage' && !b.full) || wantRem.has(b.id)))
    .sort((a, b) => (wantRem.has(b.id) ? 0 : 1) - (wantRem.has(a.id) ? 0 : 1) || (a.type === b.type ? (a.number ?? a.order ?? 0) - (b.number ?? b.order ?? 0) : a.type === 'active' ? -1 : 1));
  if (!opts.length) { toast('There is nowhere to move this to.'); return false; }
  const dflt = cur?.type === 'storage' ? opts.find((b) => wantRem.has(b.id)) || opts[0]
    : opts.find((b) => b.type === 'storage' && b.id === bins.resolveStorage(ctx, { part_num: line.part_num, cat_id: line.cat_id }, line.color_id)) || opts.find((b) => b.type === 'storage') || opts[0];
  const startQty = wantRem.has(dflt.id) ? Math.min(line.qty, wantRem.get(dflt.id)) : line.qty;
  const { value, data } = await openDialog(`
    <h2>${esc(line.name)}</h2>
    <p class="hint">${esc(line.color_name)}${line.part_num ? ` · ${esc(line.part_num)}` : ''} · ${fmt(line.qty)} in ${esc(cur ? bins.binLabel(cur, ctx.setsByNum) : 'this bin')}</p>
    <label for="mq">How many are you moving?</label>
    ${stepperHtml({ id: 'mq', name: 'qty', value: startQty, max: line.qty })}
    <label for="mb">To</label>
    <select id="mb" name="bin">${opts.map((b) => `<option value="${esc(b.id)}"${b.id === dflt.id ? ' selected' : ''}>${esc(bins.binLabel(b, ctx.setsByNum))}${wantRem.has(b.id) ? ` — needs ${fmt(wantRem.get(b.id))}` : ''}</option>`).join('')}</select>
    <div class="row">
      <button class="btn" value="cancel" formnovalidate>Cancel</button>
      <button class="btn primary" value="ok">Move</button>
    </div>`, { data: true });
  if (value !== 'ok') return false;
  try {
    const to = await bins.moveLine(ctx, line, String(data.get('bin')), Number(data.get('qty')));
    toast(`Moved ${fmt(Number(data.get('qty')))} × ${line.name} to ${to.type === 'active' ? `Bin ${to.number}` : to.label}.`);
    return true;
  } catch (e) {
    toast(e.message || 'Could not move that.');
    return false;
  }
}

// ---------- Edit one line ----------

async function editLine(line, ctx, draft = {}) {
  const curColorId = draft.color ?? line.color_id;
  const curColor = refdata.ref.colorById.get(curColorId);
  const colorName = curColor ? curColor.name : line.color_name;
  const colorRgb = curColor ? curColor.rgb : line.rgb;
  const qtyVal = draft.qty ?? line.qty;
  const binVal = draft.bin ?? line.bin_id;
  const fl = (k) => (draft.flags ? draft.flags[k] : line[k]);
  const noteVal = draft.note ?? (line.note || '');
  const needs = new Map();
  for (const b of ctx.bins.filter((x) => x.type === 'active')) {
    const rows = await db.byIndex('setParts', 'set_num', b.set_num);
    needs.set(b.id, rows.filter((l) => l.part_num === line.part_num));
  }
  const binOptions = ctx.bins
    .filter((b) => (b.type !== 'active' || b.id === line.bin_id || (needs.get(b.id) || []).length) && !(b.type === 'storage' && b.full && b.id !== line.bin_id))
    .slice()
    .sort((a, b) => (a.type === b.type ? (a.number ?? a.order ?? 0) - (b.number ?? b.order ?? 0) : a.type === 'active' ? -1 : 1))
    .map((b) => `<option value="${esc(b.id)}"${b.id === binVal ? ' selected' : ''}>${esc(bins.binLabel(b, ctx.setsByNum))}</option>`).join('');
  const unrec = !line.part_num;

  const { value, data } = await openDialog(`
    <h2>${esc(line.name)}</h2>
    <p class="hint">${unrec ? 'Unidentified brick' : esc(line.part_num)}</p>
    <label for="eq">Quantity</label>
    <input id="eq" name="qty" type="number" min="1" max="9999" step="1" required value="${esc(qtyVal)}" inputmode="numeric">
    <label for="ec">Colour</label>
    <input type="hidden" name="color" value="${curColorId}">
    <button type="submit" value="pickcolor" formnovalidate class="colorbtn" id="ec"><span class="swatch lg${/^Trans/i.test(colorName || '') ? ' trans' : ''}" style="--c:#${esc(safeRgb(colorRgb))}"></span><span>${esc(colorName)}</span></button>
    <label for="eb">Bin</label>
    <select id="eb" name="bin">${binOptions}</select>
    <fieldset class="scope">
      <legend>Flags</legend>
      <label><input type="checkbox" name="sticker"${fl('sticker') ? ' checked' : ''}> Sticker</label>
      <label><input type="checkbox" name="printed"${fl('printed') ? ' checked' : ''}> Printed part</label>
      <label><input type="checkbox" name="other"${fl('other') ? ' checked' : ''}> Other</label>
    </fieldset>
    <label for="en">Note</label>
    <input id="en" name="note" maxlength="200" value="${esc(noteVal)}">
    <div class="row spread">
      <button class="btn danger" value="delete" formnovalidate>Remove</button>
      <span class="grow"></span>
      <button class="btn" value="cancel" formnovalidate>Cancel</button>
      <button class="btn primary" value="save">Save</button>
    </div>`, { data: true });

  if (value === 'pickcolor') {
    // Only one dialog can be open at a time: keep what was typed, pick a colour, then reopen.
    const keep = {
      qty: String(data.get('qty') || ''), bin: String(data.get('bin')), note: String(data.get('note') || ''),
      flags: { sticker: data.has('sticker'), printed: data.has('printed'), other: data.has('other') },
      color: Number(data.get('color')),
    };
    await refreshInfo();
    await loadColorState();
    const picked = await pickColor(keep.color);
    if (picked !== null) keep.color = picked;
    return editLine(line, ctx, keep);
  }
  const now = new Date().toISOString();
  if (value === 'delete') {
    if (!(await ask({ title: 'Remove these bricks?', body: `${fmt(line.qty)} × ${line.name} (${line.color_name}) will be removed from the app. Everything else in the bin stays.`, ok: 'Remove', danger: true }))) return false;
    await db.put('inventory', { ...line, deleted: true, updated: now });
    toast(`Removed ${fmt(line.qty)} × ${line.name}.`);
    return true;
  }
  if (value !== 'save') return false;
  const qty = Number(data.get('qty'));
  if (!Number.isInteger(qty) || qty < 1) { toast('Quantity must be a whole number of at least 1.'); return false; }
  const colorId = Number(data.get('color'));
  const color = refdata.ref.colorById.get(colorId);
  const targetBin = ctx.bins.find((b) => b.id === String(data.get('bin')));
  if (targetBin?.type === 'active' && line.part_num) {
    // An active bin never holds more of a part than its set needs.
    const need = (await db.byIndex('setParts', 'set_num', targetBin.set_num))
      .filter((l) => l.part_num === line.part_num && l.color_id === colorId).reduce((n, l) => n + l.qty, 0);
    const others = (ctx.byBin.get(targetBin.id) || [])
      .filter((l) => l.id !== line.id && l.part_num === line.part_num && l.color_id === colorId).reduce((n, l) => n + l.qty, 0);
    if (qty + others > need) {
      toast(need ? `Bin ${targetBin.number}’s set only needs ${fmt(need)} of this brick in that colour.` : `Bin ${targetBin.number}’s set doesn’t need this brick in that colour.`);
      return false;
    }
  }
  await db.put('inventory', {
    ...line,
    qty,
    bin_id: String(data.get('bin')),
    color_id: color ? color.id : line.color_id,
    color_name: color ? color.name : line.color_name,
    rgb: color ? color.rgb : line.rgb,
    sticker: data.has('sticker'),
    printed: data.has('printed'),
    other: data.has('other'),
    note: String(data.get('note') || '').trim(),
    updated: now,
  });
  toast(`Saved changes to ${line.name}.`);
  return true;
}
