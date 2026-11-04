// Bins: the list of active and storage bins, what is in each, editing pieces, and abandoning a bin.
import * as db from '../db.js';
import * as refdata from '../data.js';
import * as bins from '../bins.js';
import { view, esc, fmt, toast, openDialog, ask, setTitle, safeRgb, stepperHtml } from '../ui.js';
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
  const storage = ctx.bins.filter((b) => b.type === 'storage').sort((a, b) => (a.order || 0) - (b.order || 0));

  const activeHtml = ctx.active.length
    ? `<ul class="cards">${ctx.active.map((a) => {
      const pct = Math.round(a.frac * 100);
      return `
      <li>
        <a class="card binrow" href="#/bin/${encodeURIComponent(a.bin.id)}">
          <span class="binchip big"${bins.chipStyle(a.bin)}>Bin ${a.bin.number}</span>
          <div class="cardtext">
            <div class="cardname">${esc(a.set.name)}</div>
            <div class="cardmeta">${esc(a.set.set_num)} · ${fmt(a.heldTotal)} of ${fmt(a.neededTotal)} pieces · ${pct}%</div>
            <div class="bar solid" aria-hidden="true"><i style="--p:${pct}%"></i></div>
          </div>
          <span class="chev" aria-hidden="true">›</span>
        </a>
      </li>`;
    }).join('')}</ul>`
    : '<p class="empty">No active bins yet. Open a set and choose “Start rebuilding this set”.</p>';

  view.innerHTML = `
    <section>
      <h2 class="section-title">Active bins</h2>
      ${activeHtml}
    </section>
    <section>
      <h2 class="section-title">Storage bins</h2>
      <ul class="cards">${storage.map((b) => `
        <li>
          <a class="card binrow" href="#/bin/${encodeURIComponent(b.id)}">
            <span class="binchip store big"${bins.chipStyle(b)}>${esc(b.label.slice(0, 2).toUpperCase())}</span>
            <div class="cardtext">
              <div class="cardname">${esc(b.label)}</div>
              <div class="cardmeta">${fmt(count(b.id))} ${count(b.id) === 1 ? 'piece' : 'pieces'}${b.desc ? ` · ${esc(b.desc)}` : ''}${b.full ? ' · <span class="tag warn">Full</span>' : ''}${wantedLines(b.id) ? ` · <span class="tag ok">${wantedLines(b.id)} ${wantedLines(b.id) === 1 ? 'line' : 'lines'} wanted by active sets</span>` : ''}</div>
            </div>
            <span class="chev" aria-hidden="true">›</span>
          </a>
        </li>`).join('')}</ul>
    </section>
    <section class="panel">
      <h2>Add a storage bin</h2>
      <form id="addBinForm" autocomplete="off">
        <label for="binName" class="sr">Bin name</label>
        <div class="inline">
          <input id="binName" placeholder="e.g. Wheels" maxlength="30">
          <button class="btn primary">Add</button>
        </div>
      </form>
    </section>
    <a class="btn block" href="#/bin/all">Search all pieces</a>
    <button type="button" class="btn block" id="exportSort">Export sorting data</button>
    <details class="panel rules" id="rules"><summary>Storage rules</summary><div id="rulesBody"></div></details>`;

  $('#addBinForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await bins.addStorageBin($('#binName').value);
      await renderBins();
    } catch (err) {
      toast(err.message);
    }
  });
  $('#exportSort').addEventListener('click', async () => {
    try { toast(await exportSorting(ctx)); } catch (err) { toast(err.message || 'Could not export.'); }
  });
  $('#rules').addEventListener('toggle', () => { if ($('#rules').open) drawRules(); });
  if (location.hash === '#/bins' && sessionStorageOpen()) { $('#rules').open = true; drawRules(); }
}

const $ = (sel) => view.querySelector(sel);

// A file of what is in each storage bin, the current rules and recent choices, to share for tuning the rules.
async function exportSorting(ctx) {
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
    storage_bins: storage.map((b) => ({ label: b.label, description: b.desc || '', full: !!b.full, pieces: partCount(ctx.byBin.get(b.id) || []) })),
    category_rules: Object.entries(ctx.catMap || {}).map(([cat, bin]) => ({ category: refdata.categoryName(Number(cat)), bin: label(bin) })),
    part_exceptions: Object.entries(ctx.overrides || {}).map(([part, bin]) => ({ part_num: part, bin: label(bin) })),
    recent_choices: log.map((e) => ({ when: e.t, category: refdata.categoryName(e.cat), part_num: e.part, chosen: label(e.bin), suggested: e.sug ? label(e.sug) : null })),
    lines,
  };
  const blob = new Blob([JSON.stringify(out, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `brick-sorter-storage-${out.exported.slice(0, 10)}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  return `Exported ${pl(lines.length, 'line', 'lines')} from ${pl(storage.length, 'storage bin', 'storage bins')}.`;
}
function sessionStorageOpen() { return false; }

async function drawRules() {
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
  const body = $('#rulesBody');
  body.innerHTML = rows.length
    ? `<p class="hint">Where pieces that no active set needs are stored. A rule for one part beats the rule for its category. The rules follow you: choose a different bin and that part goes there next time, and when most recent pieces of a category go to one bin, the category follows. A full bin is skipped.</p><ul class="rulelist">${rows.join('')}</ul>`
    : '<p class="hint">No rules yet. The first time a piece needs storage, the app asks which bin and remembers.</p>';
  body.onchange = async (e) => {
    const s = e.target.closest('select[data-rule-kind]');
    if (!s) return;
    const name = s.dataset.ruleKind === 'category' ? 'categoryMap' : 'partOverrides';
    const map = { ...((await db.getSetting(name)) || {}), [s.dataset.ruleKey]: s.value };
    await db.setSetting(name, map);
    toast('Rule updated.');
  };
  body.onclick = async (e) => {
    const b = e.target.closest('[data-rule-del]');
    if (!b) return;
    await bins.removeRule(b.dataset.ruleDel, b.dataset.ruleKey);
    await drawRules();
  };
}

// ---------- One bin (or all pieces) ----------

let binMode = 'missing'; // 'missing' | 'found' for active bins
let pickOnly = false; // missing list: only pieces that are sitting in storage
let colorFilter = null; // colour id chosen in the bin's colour chips
let neededOnly = false; // storage bin: only lines an active set still wants

export async function renderBin(id, keepMode = false) {
  if (!keepMode) { binMode = 'missing'; pickOnly = false; colorFilter = null; neededOnly = false; }
  const ctx = await bins.loadContext();
  const isAll = id === 'all';
  const bin = isAll ? null : ctx.bins.find((b) => b.id === id);
  if (!isAll && !bin) {
    setTitle('Bin not found');
    view.innerHTML = '<p class="empty">That bin doesn\'t exist any more. <a href="#/bins">Back to bins</a></p>';
    return;
  }
  await refdata.loadRef().catch(() => {});
  const lines = isAll ? [...ctx.byBin.values()].flat() : (ctx.byBin.get(bin.id) || []);
  lines.sort((a, b) => (a.name || '').localeCompare(b.name || '') || a.color_name.localeCompare(b.color_name));

  const wm = bins.wantedMap(ctx);
  const wantedFor = (l) => (l.part_num && (wm.get(`${l.part_num}|${l.color_id}`) || [])) || [];
  const wantedCount = lines.filter((l) => wantedFor(l).length && ctx.bins.find((b) => b.id === l.bin_id)?.type === 'storage').length;
  const title = isAll ? 'All pieces' : bins.binLabel(bin, ctx.setsByNum);
  const isActive = !isAll && bin.type === 'active';
  let missing = [];
  const catOfPart = new Map(); // part number -> the set list's category name (active bins)
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
    // Matching pieces already sitting in storage bins (the pick list).
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
  // Active bins show the same category headings as the set's parts list.
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
  setTitle(isAll ? 'All pieces' : bin.type === 'active' ? `Bin ${bin.number}` : bin.label);

  let head = '';
  if (!isAll && bin.type === 'active') {
    const a = ctx.active.find((x) => x.bin.id === bin.id);
    const pct = a ? Math.round(a.frac * 100) : 0;
    head = `
      <section class="panel">
        <h2 class="setname">${esc(a?.set.name || 'Set')}</h2>
        <p class="cardmeta">${esc(bin.set_num)}${a ? ` · ${fmt(a.heldTotal)} of ${fmt(a.neededTotal)} pieces · ${pct}%` : ''}</p>
        <div class="bar solid" aria-hidden="true"><i style="--p:${pct}%"></i></div>
        <div class="actions"><button class="btn" id="binColor">Bin colour</button><button class="btn danger" id="abandon">Abandon this bin</button></div>
      </section>`;
  } else if (!isAll) {
    head = `
      <section class="panel">
        <h2 class="setname">${esc(bin.label)}</h2>
        <p class="cardmeta">${fmt(partCount(lines))} ${partCount(lines) === 1 ? 'piece' : 'pieces'}${bin.desc ? ` · ${esc(bin.desc)}` : ''}</p>
        ${bin.full ? '<p class="hint">This bin is full. Nothing new is suggested or accepted here until you reopen it.</p>' : ''}
        <div class="actions">
          <button class="btn" id="binColor">Bin colour</button>
          ${bin.locked ? '' : `<button class="btn${bin.full ? ' primary' : ''}" id="fullToggle" aria-pressed="${!!bin.full}">${bin.full ? 'Reopen bin' : 'Mark as full'}</button>
          <button class="btn" id="rename">Rename</button>
          <button class="btn danger" id="delBin">Delete bin</button>`}
        </div>
      </section>`;
  }

  view.innerHTML = `
    <a class="backlink" href="#/bins">‹ All bins</a>
 ${head}
    <section class="panel">
      ${isActive ? `<div class="segmented" role="tablist">
        <button type="button" role="tab" data-mode="missing" aria-selected="${binMode === 'missing'}">Missing (${fmt(missingCount)})</button>
        <button type="button" role="tab" data-mode="found" aria-selected="${binMode === 'found'}">Found (${fmt(partCount(lines))})</button>
 </div>
      ${binMode === 'missing' && pickCount ? `<button type="button" class="chip pickchip" id="pickToggle" aria-pressed="${pickOnly}">In storage: ${fmt(pickCount)} ${pickCount === 1 ? 'part' : 'parts'} to pick</button>` : ''}` : ''}
      ${!isActive && wantedCount ? `<button type="button" class="chip pickchip" id="neededToggle" aria-pressed="${neededOnly}">Wanted by active sets: ${fmt(wantedCount)} ${wantedCount === 1 ? 'line' : 'lines'}</button>` : ''}
      <label for="filter" class="sr">Filter pieces</label>
      <input id="filter" type="search" placeholder="Filter by name, part number or colour" autocomplete="off">
      <div class="flagrow colorchips" id="colorChips" role="group" aria-label="Filter by colour"></div>
      <p class="hint" id="count"></p>
      <div id="bulkRow" class="bulkrow" hidden></div>
      <div id="lineList"></div>
    </section>`;

  const listEl = $('#lineList');
  const match = (l, q) => `${l.name} ${l.part_num} ${l.color_name} ${l.note || ''}`.toLowerCase().includes(q);
  const byColor = (l) => colorFilter === null || l.color_id === colorFilter;
  const showMissing = isActive && binMode === 'missing';
  const shownLines = neededOnly && !isActive ? lines.filter((l) => wantedFor(l).length && ctx.bins.find((b) => b.id === l.bin_id)?.type === 'storage') : lines;
  const basePool = showMissing ? (pickOnly ? missing.filter((l) => l.avail > 0) : missing) : shownLines;
  // Colour chips: the colours in this list, most pieces first.
  const chipMap = new Map();
  for (const l of basePool) {
    const c = chipMap.get(l.color_id) || { id: l.color_id, name: l.color_name, rgb: l.rgb, trans: !!l.is_trans || /^Trans/i.test(l.color_name || ''), n: 0 };
    c.n += showMissing ? l.rem : l.qty;
    chipMap.set(l.color_id, c);
  }
  if (colorFilter !== null && !chipMap.has(colorFilter)) colorFilter = null;
  const drawChips = () => {
    const el = $('#colorChips');
    const list = [...chipMap.values()].sort((a, b) => b.n - a.n || String(a.name).localeCompare(String(b.name)));
    el.hidden = list.length < 2;
    el.innerHTML = list.map((c) => `<button type="button" class="chip" data-cfilter="${c.id}" aria-pressed="${c.id === colorFilter}"><span class="swatch${c.trans ? ' trans' : ''}" style="--c:#${esc(safe(c.rgb))}"></span> ${esc(c.name)} · ${fmt(c.n)}</button>`).join('');
  };
  const safe = (rgb) => (/^[0-9a-f]{6}$/i.test(rgb || '') ? rgb : '999999');
  let bulkShown = [];
  const draw = (q) => {
    const needle = q.trim().toLowerCase();
    if (showMissing) {
      const pool = basePool.filter(byColor);
      const shown = needle ? pool.filter((l) => match(l, needle)) : pool;
      $('#count').textContent = missing.length
        ? `${pl(shown.reduce((n, l) => n + l.rem, 0), 'piece', 'pieces')} in ${pl(shown.length, 'line', 'lines')} still missing`
        : '';
      if (!shown.length) {
        listEl.innerHTML = `<p class="empty">${missing.length ? 'No pieces match.' : 'Nothing missing. This set is complete!'}</p>`;
        return;
      }
      listEl.innerHTML = `<ul class="parts">${shown.map((l) => `
        <li class="part">
          <span class="thumb">${l.img ? `<img src="${esc(l.img)}" alt="" loading="lazy">` : ''}</span>
          <span class="pinfo">
            <span class="pname">${esc(l.name)}</span>
            <span class="pmeta">
              <span class="swatch${l.is_trans ? ' trans' : ''}" style="--c:#${esc(l.rgb)}"></span>
              ${esc(l.color_name)} · ${esc(l.part_num)}${l.sticker ? ' <span class="tag">sticker</span>' : ''}
              ${l.have ? `<br>Have ${fmt(l.have)} of ${fmt(l.qty)}` : ''}
              ${l.avail ? `<br><span class="tag ok">In storage: ${fmt(l.avail)} · ${esc([...new Set(l.stock.map((x) => x.bin.label))].join(', '))}</span>` : ''}
            </span>
          </span>
          <span class="qty">${fmt(l.rem)}</span>
          <span class="btns">
            ${l.avail ? `<button type="button" class="btn small primary" data-take="${esc(l.id)}">Take ${fmt(Math.min(l.rem, l.avail))}</button>` : ''}
            <button type="button" class="btn small" data-found="${esc(l.id)}">Found</button>
          </span>
        </li>`).join('')}</ul>`;
      groupByCategory(shown.map((l) => l.cat_name || 'Other'));
      return;
    }
    const pool = shownLines.filter(byColor);
    const shown = needle ? pool.filter((l) => match(l, needle)) : pool;
    $('#count').textContent = `${pl(partCount(shown), 'piece', 'pieces')} in ${pl(shown.length, 'line', 'lines')}`;
    bulkShown = shown;
    const bulk = $('#bulkRow');
    const canBulk = bin?.type === 'storage' && !isAll && shown.length > 0;
    bulk.hidden = !canBulk;
    if (canBulk) bulk.innerHTML = `<button type="button" class="btn" id="bulkMove">Move ${colorFilter !== null || needle ? 'these' : 'all'} ${pl(partCount(shown), 'piece', 'pieces')} to another bin…</button>`;
    if (!shown.length) {
      listEl.innerHTML = `<p class="empty">${lines.length ? 'No pieces match.' : isAll ? 'Nothing has been sorted yet.' : 'Nothing found yet. Use the Missing tab or the Add tab.'}</p>`;
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
  $('#colorChips').addEventListener('click', (e) => {
    const c = e.target.closest('[data-cfilter]');
    if (!c) return;
    const idc = Number(c.dataset.cfilter);
    colorFilter = colorFilter === idc ? null : idc;
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
  $('#neededToggle')?.addEventListener('click', () => { neededOnly = !neededOnly; renderBin(id, true); });
  $('#pickToggle')?.addEventListener('click', () => { pickOnly = !pickOnly; renderBin(id, true); });
  listEl.addEventListener('click', async (e) => {
    const tb = e.target.closest('[data-take]');
    if (tb) {
      const row = missing.find((l) => l.id === tb.dataset.take);
      if (row && await takeFromStorage(row, bin)) await renderBin(id, true);
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

  $('#binColor')?.addEventListener('click', async () => {
    const cur = /^#[0-9a-f]{6}$/i.test(bin.color || '') ? bin.color : '';
    const { value, data } = await openDialog(`
      <h2>Bin colour</h2>
      <div class="cgrid presets">${bins.BIN_COLORS.map((c) => `<button type="submit" class="cswatch" value="${c}" aria-pressed="${c === cur}" aria-label="${c}"><span class="swatch lg" style="--c:${c}"></span></button>`).join('')}</div>
      <label for="cc">Or pick any colour</label>
      <input id="cc" name="custom" type="color" value="${cur || '#b3261e'}">
      <div class="row spread">
        <button class="btn" value="reset" formnovalidate>Default</button>
        <span class="grow"></span>
        <button class="btn" value="cancel" formnovalidate>Cancel</button>
        <button class="btn primary" value="custom">Use this colour</button>
      </div>`, { data: true });
    if (!value || value === 'cancel') return;
    const hex = value === 'reset' ? null : value === 'custom' ? String(data.get('custom')) : value;
    await bins.setBinColor(bin.id, hex);
    await renderBin(id, true);
  });
  $('#fullToggle')?.addEventListener('click', async () => {
    await bins.setBinFull(bin.id, !bin.full);
    toast(bin.full ? `${bin.label} is open again.` : `${bin.label} marked as full.`);
    await renderBin(id, true);
  });
  $('#abandon')?.addEventListener('click', async () => {
    if (await confirmAbandon(bin.id)) location.hash = '#/bins';
  });
  $('#rename')?.addEventListener('click', async () => {
    const { value, data } = await openDialog(`
      <h2>Rename bin</h2>
      <label for="nb">Name</label>
      <input id="nb" name="name" maxlength="30" required value="${esc(bin.label)}">
      <div class="row">
        <button class="btn" value="cancel" formnovalidate>Cancel</button>
        <button class="btn primary" value="ok">Save</button>
      </div>`, { data: true });
    if (value !== 'ok') return;
    try {
      await bins.renameStorageBin(bin.id, String(data.get('name') || ''));
      await renderBin(id);
    } catch (err) { toast(err.message); }
  });
  $('#delBin')?.addEventListener('click', async () => {
    if (!(await ask({ title: 'Delete this bin?', body: `${bin.label} will be removed. Any storage rules that point to it will ask again next time.`, ok: 'Delete', danger: true }))) return;
    try {
      await bins.deleteStorageBin(bin.id);
      location.hash = '#/bins';
    } catch (err) { toast(err.message); }
  });
  void title;
}

// Asks first; then deletes every piece in the bin and returns the set to the catalogue.
export async function confirmAbandon(binId) {
  const ctx = await bins.loadContext();
  const bin = ctx.bins.find((b) => b.id === binId);
  if (!bin) return false;
  const lines = ctx.byBin.get(binId) || [];
  const pieces = partCount(lines);
  const set = ctx.setsByNum.get(bin.set_num);
  const name = `Bin ${bin.number}${set ? ` (${set.name})` : ''}`;
  const body = pieces
    ? `The ${fmt(pieces)} ${pieces === 1 ? 'piece' : 'pieces'} sorted into this bin (${fmt(lines.length)} part types) will be deleted from the app. This can't be undone. The set goes back to your catalogue and you can start it again later.`
    : 'This bin is empty. The set goes back to your catalogue and you can start it again later.';
  const ok = await ask({
    title: `Abandon ${name}?`,
    body,
    ok: pieces ? `Abandon and delete ${fmt(pieces)}` : 'Abandon bin',
    danger: true,
  });
  if (!ok) return false;
  const res = await bins.abandonBin(binId);
  toast(res.pieces ? `Bin ${bin.number} abandoned. ${fmt(res.pieces)} pieces deleted.` : `Bin ${bin.number} abandoned.`);
  return true;
}

// ---------- Mark a missing piece as found ----------

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
  toast(`Found: ${fmt(qty)} × ${row.name}`);
  return true;
}

// Moves pieces from storage bins into this active bin.
async function takeFromStorage(row, bin) {
  const max = Math.min(row.rem, row.avail);
  let qty = max;
  if (max > 1) {
    const { value, data } = await openDialog(`
      <h2>${esc(row.name)}</h2>
      <p class="hint">${esc(row.color_name)} · ${esc(row.part_num)} · ${fmt(row.avail)} in storage, ${fmt(row.rem)} needed</p>
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
  for (const { line } of row.stock) {
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
    log: false, // a move from storage isn't new sorting
  });
  toast(`Moved ${fmt(qty)} × ${row.name} to Bin ${bin.number}`);
  return true;
}

// Moves every piece in the lines currently shown to another storage bin. Nothing moves until you confirm.
async function bulkMoveDialog(lines, ctx, from) {
  const opts = ctx.bins
    .filter((b) => !b.deleted && b.type === 'storage' && b.id !== from.id && b.id !== 'unrecognised' && !b.full)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  if (!opts.length) { toast('There is no other storage bin to move these to. Add one on the Bins screen.'); return false; }
  const total = partCount(lines);
  const colours = [...new Set(lines.map((l) => l.color_name))];
  const what = colours.length === 1 ? `${colours[0]} pieces` : 'pieces';
  const { value, data } = await openDialog(`
    <h2>Move ${esc(what)}</h2>
    <p class="hint">${pl(total, 'piece', 'pieces')} in ${pl(lines.length, 'line', 'lines')}, from ${esc(from.label)}. Every piece currently shown moves.</p>
    <label for="bb">To</label>
    <select id="bb" name="bin">${opts.map((b) => `<option value="${esc(b.id)}">${esc(bins.binLabel(b, ctx.setsByNum))}</option>`).join('')}</select>
    <div class="row">
      <button class="btn" value="cancel" formnovalidate>Cancel</button>
      <button class="btn primary" value="ok">Move ${fmt(total)}</button>
    </div>`, { data: true });
  if (value !== 'ok') return false;
  try {
    const to = await bins.moveLines(ctx, lines, String(data.get('bin')));
    toast(`Moved ${pl(total, 'piece', 'pieces')} to ${to.label}`);
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
    : opts.find((b) => b.type === 'storage' && b.id === bins.resolveStorage(ctx, { part_num: line.part_num, cat_id: line.cat_id })) || opts.find((b) => b.type === 'storage') || opts[0];
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
    toast(`Moved ${fmt(Number(data.get('qty')))} × ${line.name} to ${to.type === 'active' ? `Bin ${to.number}` : to.label}`);
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
    <p class="hint">${unrec ? 'Unidentified piece' : esc(line.part_num)}</p>
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
      <button class="btn danger" value="delete" formnovalidate>Delete</button>
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
    if (!(await ask({ title: 'Delete this line?', body: `${fmt(line.qty)} × ${line.name} (${line.color_name}) will be removed from the app.`, ok: 'Delete', danger: true }))) return false;
    await db.put('inventory', { ...line, deleted: true, updated: now });
    toast('Deleted.');
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
      toast(need ? `Bin ${targetBin.number}'s set only needs ${fmt(need)} of this piece in that colour.` : `Bin ${targetBin.number}'s set doesn't need this piece in that colour.`);
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
  toast('Saved.');
  return true;
}
