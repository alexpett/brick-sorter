// Bins: the list of active and storage bins, what is in each, editing pieces, and abandoning a bin.
import * as db from '../db.js';
import * as refdata from '../data.js';
import * as bins from '../bins.js';
import { view, esc, fmt, toast, openDialog, ask, setTitle } from '../ui.js';

const partCount = (lines) => bins.sumQty(lines);

function tagsHtml(l) {
  const t = [];
  if (l.sticker) t.push('sticker');
  if (l.printed) t.push('printed');
  if (l.other) t.push('other');
  return t.map((x) => ` <span class="tag">${x}</span>`).join('');
}

// ---------- Bins list ----------

export async function renderBins() {
  setTitle('Bins');
  await refdata.loadRef().catch(() => {});
  const ctx = await bins.loadContext();
  const count = (id) => partCount(ctx.byBin.get(id) || []);
  const storage = ctx.bins.filter((b) => b.type === 'storage').sort((a, b) => (a.order || 0) - (b.order || 0));

  const activeHtml = ctx.active.length
    ? `<ul class="cards">${ctx.active.map((a) => {
      const pct = Math.round(a.frac * 100);
      return `
      <li>
        <a class="card binrow" href="#/bin/${encodeURIComponent(a.bin.id)}">
          <span class="binchip big">Bin ${a.bin.number}</span>
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
            <span class="binchip store big">${esc(b.label.slice(0, 2).toUpperCase())}</span>
            <div class="cardtext">
              <div class="cardname">${esc(b.label)}</div>
              <div class="cardmeta">${fmt(count(b.id))} ${count(b.id) === 1 ? 'piece' : 'pieces'}${b.desc ? ` · ${esc(b.desc)}` : ''}</div>
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
  $('#rules').addEventListener('toggle', () => { if ($('#rules').open) drawRules(); });
  if (location.hash === '#/bins' && sessionStorageOpen()) { $('#rules').open = true; drawRules(); }
}

const $ = (sel) => view.querySelector(sel);
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
  const rows = [
    ...cats.map(([id, bin]) => `
      <li><span>${esc(refdata.categoryName(Number(id)))} <small>(every part)</small></span>
      ${select('category', id, bin)}<button class="linkbtn" data-rule-del="category" data-rule-key="${esc(id)}">Remove</button></li>`),
    ...parts.map(([pn, bin]) => `
      <li><span>${esc(partName(pn))}</span>
      ${select('part', pn, bin)}<button class="linkbtn" data-rule-del="part" data-rule-key="${esc(pn)}">Remove</button></li>`),
  ];
  const body = $('#rulesBody');
  body.innerHTML = rows.length
    ? `<p class="hint">Where pieces that no active set needs are stored. A rule for one part beats the rule for its category.</p><ul class="rulelist">${rows.join('')}</ul>`
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

export async function renderBin(id) {
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

  const title = isAll ? 'All pieces' : bins.binLabel(bin, ctx.setsByNum);
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
        <div class="actions"><button class="btn danger" id="abandon">Abandon this bin</button></div>
      </section>`;
  } else if (!isAll) {
    head = `
      <section class="panel">
        <h2 class="setname">${esc(bin.label)}</h2>
        <p class="cardmeta">${fmt(partCount(lines))} ${partCount(lines) === 1 ? 'piece' : 'pieces'}${bin.desc ? ` · ${esc(bin.desc)}` : ''}</p>
        ${bin.locked ? '' : `<div class="actions">
          <button class="btn" id="rename">Rename</button>
          <button class="btn danger" id="delBin">Delete bin</button>
        </div>`}
      </section>`;
  }

  view.innerHTML = `
    <a class="backlink" href="#/bins">‹ All bins</a>
    ${head}
    <section class="panel">
      <label for="filter" class="sr">Filter pieces</label>
      <input id="filter" type="search" placeholder="Filter by name, part number or colour" autocomplete="off">
      <p class="hint" id="count"></p>
      <div id="lineList"></div>
    </section>`;

  const listEl = $('#lineList');
  const draw = (q) => {
    const needle = q.trim().toLowerCase();
    const shown = needle
      ? lines.filter((l) => `${l.name} ${l.part_num} ${l.color_name} ${l.note || ''}`.toLowerCase().includes(needle))
      : lines;
    $('#count').textContent = `${fmt(partCount(shown))} pieces in ${fmt(shown.length)} lines`;
    if (!shown.length) {
      listEl.innerHTML = `<p class="empty">${lines.length ? 'No pieces match.' : isAll ? 'Nothing has been sorted yet.' : 'This bin is empty.'}</p>`;
      return;
    }
    listEl.innerHTML = `<ul class="parts">${shown.map((l) => {
      const b = isAll ? ctx.bins.find((x) => x.id === l.bin_id) : null;
      const url = l.part_num ? refdata.partImg(l.part_num, l.color_id, null) : null;
      return `
      <li class="part">
        <button type="button" class="linebtn" data-line="${esc(l.id)}">
          <span class="thumb">${url ? `<img src="${esc(url)}" alt="" loading="lazy">` : ''}</span>
          <span class="pinfo">
            <span class="pname">${esc(l.name)}</span>
            <span class="pmeta">
              <span class="swatch${/^Trans/i.test(l.color_name) ? ' trans' : ''}" style="--c:#${esc(l.rgb)}"></span>
              ${esc(l.color_name)}${l.part_num ? ` · ${esc(l.part_num)}` : ''}${tagsHtml(l)}${b ? ` · ${esc(b.type === 'active' ? `Bin ${b.number}` : b.label)}` : ''}
              ${l.note ? `<br><em>${esc(l.note)}</em>` : ''}
            </span>
          </span>
          <span class="qty">${fmt(l.qty)}</span>
        </button>
      </li>`;
    }).join('')}</ul>`;
  };
  draw('');
  $('#filter').addEventListener('input', (e) => draw(e.target.value));
  listEl.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-line]');
    if (!btn) return;
    const line = lines.find((l) => l.id === btn.dataset.line);
    if (line && await editLine(line, ctx)) await renderBin(id);
  });

  $('#abandon')?.addEventListener('click', async () => {
    if (await confirmAbandon(bin.id)) location.hash = '#/bins';
  });
  $('#rename')?.addEventListener('click', async () => {
    const { value, data } = await openDialog(`
      <h2>Rename bin</h2>
      <label for="nb">Name</label>
      <input id="nb" name="name" maxlength="30" required>
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

// ---------- Edit one line ----------

async function editLine(line, ctx) {
  const colors = refdata.ref.loaded ? refdata.pickerColors() : [];
  const known = colors.some((c) => c.id === line.color_id);
  const colorOptions = (known ? colors : [{ id: line.color_id, name: line.color_name }, ...colors])
    .map((c) => `<option value="${c.id}"${c.id === line.color_id ? ' selected' : ''}>${esc(c.name)}</option>`).join('');
  const binOptions = ctx.bins
    .slice()
    .sort((a, b) => (a.type === b.type ? (a.number ?? a.order ?? 0) - (b.number ?? b.order ?? 0) : a.type === 'active' ? -1 : 1))
    .map((b) => `<option value="${esc(b.id)}"${b.id === line.bin_id ? ' selected' : ''}>${esc(bins.binLabel(b, ctx.setsByNum))}</option>`).join('');
  const unrec = !line.part_num;

  const { value, data } = await openDialog(`
    <h2>${esc(line.name)}</h2>
    <p class="hint">${unrec ? 'Unidentified piece' : esc(line.part_num)}</p>
    <label for="eq">Quantity</label>
    <input id="eq" name="qty" type="number" min="1" max="9999" step="1" required value="${line.qty}" inputmode="numeric">
    <label for="ec">Colour</label>
    <select id="ec" name="color">${colorOptions}</select>
    <label for="eb">Bin</label>
    <select id="eb" name="bin">${binOptions}</select>
    <fieldset class="scope">
      <legend>Flags</legend>
      <label><input type="checkbox" name="sticker"${line.sticker ? ' checked' : ''}> Sticker</label>
      <label><input type="checkbox" name="printed"${line.printed ? ' checked' : ''}> Printed part</label>
      <label><input type="checkbox" name="other"${line.other ? ' checked' : ''}> Other</label>
    </fieldset>
    <label for="en">Note</label>
    <input id="en" name="note" maxlength="200" value="${esc(line.note || '')}">
    <div class="row spread">
      <button class="btn danger" value="delete" formnovalidate>Delete</button>
      <span class="grow"></span>
      <button class="btn" value="cancel" formnovalidate>Cancel</button>
      <button class="btn primary" value="save">Save</button>
    </div>`, { data: true });

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
