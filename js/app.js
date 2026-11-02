import * as db from './db.js';
import * as rb from './rebrickable.js';

import * as bins from './bins.js';
import { $, view, esc, decode, fmt, safeRgb, setTitle, toast, openDialog, ask } from './ui.js';
import { renderAdd } from './screens/add.js';
import { renderBins, renderBin, confirmAbandon } from './screens/bins.js';

const APP_VERSION = '0.2.0 (stage 2)';

// ---------- dialogs ----------

async function chooseVersion(options) {
  const buttons = options.map((o, i) => `
    <button class="choice" value="${i}">
      <strong>${esc(o.set_num)}</strong>
      <span>${esc(decode(o.name))} · ${esc(o.year)} · ${fmt(o.num_parts)} pieces</span>
    </button>`).join('');
  const result = await openDialog(`
    <h2>Which version?</h2>
    <p>Rebrickable lists more than one match. Pick the one you own.</p>
    <div class="choices">${buttons}</div>
    <div class="row"><button class="btn" value="cancel">Cancel</button></div>`);
  const i = Number(result);
  return Number.isInteger(i) && result !== '' ? options[i] : null;
}

// ---------- data helpers ----------

async function getKey() {
  return (await db.getSetting('rebrickableKey')) || '';
}

async function ensureCategories(key) {
  let cats = await db.all('categories');
  if (!cats.length) {
    cats = (await rb.getCategories(key)).map((c) => ({ id: c.id, name: decode(c.name) }));
    await db.putMany('categories', cats);
  }
  return new Map(cats.map((c) => [c.id, c.name]));
}

const isSticker = (catName, partNum, name) => (
  /sticker/i.test(catName || '') || /stk/i.test(partNum || '') || /^sticker/i.test(name || '')
);

// Turns Rebrickable's parts list into one line per part and colour. Spares are left out.
function buildLines(setNum, results, catMap) {
  const lines = new Map();
  let spares = 0;
  for (const r of results) {
    const qty = Number(r.quantity) || 0;
    if (r.is_spare) { spares += qty; continue; }
    const p = r.part || {};
    const c = r.color || {};
    const id = `${setNum}|${p.part_num}|${c.id}`;
    const existing = lines.get(id);
    if (existing) { existing.qty += qty; continue; }
    const catName = catMap.get(p.part_cat_id) || 'Other';
    lines.set(id, {
      id,
      set_num: setNum,
      part_num: p.part_num,
      name: decode(p.name),
      cat_id: p.part_cat_id ?? null,
      cat_name: catName,
      img: p.part_img_url || null,
      color_id: c.id,
      color_name: decode(c.name),
      rgb: safeRgb(c.rgb),
      is_trans: !!c.is_trans,
      qty,
      element_id: r.element_id || null,
      sticker: isSticker(catName, p.part_num, p.name),
    });
  }
  return { lines: [...lines.values()], spares };
}

async function storeSet(info, results, catMap, previous) {
  const { lines, spares } = buildLines(info.set_num, results, catMap);
  const now = new Date().toISOString();
  const rec = {
    set_num: info.set_num,
    name: decode(info.name),
    year: info.year,
    theme_id: info.theme_id ?? null,
    official_parts: info.num_parts ?? null,
    img: info.set_img_url || null,
    status: previous?.status || 'catalogued',
    active_bin: previous?.active_bin ?? null,
    bin_id: previous?.bin_id ?? null,
    priority: previous?.priority ?? null,
    line_count: lines.length,
    pieces: lines.reduce((n, l) => n + l.qty, 0),
    sticker_lines: lines.filter((l) => l.sticker).length,
    spares,
    added: previous?.added || now,
    updated: now,
    deleted: false,
  };
  await db.delByIndex('setParts', 'set_num', info.set_num);
  await db.putMany('setParts', lines);
  await db.put('sets', rec);
  return rec;
}

// ---------- router ----------

const routes = {
  '': renderSets,
  set: renderSet,
  add: renderAdd,
  bins: renderBins,
  bin: renderBin,
  settings: renderSettings,
};

async function route() {
  const [, page = '', arg] = (location.hash.slice(1) || '/').split('/');
  const handler = routes[page] || renderSets;
  const tab = { add: 'add', bins: 'bins', bin: 'bins', settings: 'settings' }[page] || 'sets';
  document.querySelectorAll('.tabs a').forEach((a) => {
    a.classList.toggle('active', a.dataset.tab === tab);
    if (a.dataset.tab === tab) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  try {
    await handler(arg ? decodeURIComponent(arg) : undefined);
  } catch (e) {
    view.innerHTML = `<section class="panel"><h2>Something went wrong</h2><p>${esc(e.message || e)}</p></section>`;
  }
  window.scrollTo(0, 0);
}

// ---------- Sets screen ----------

let adding = false;

async function renderSets() {
  setTitle('Sets');
  const key = await getKey();
  view.innerHTML = `
    ${key ? '' : `
    <section class="panel callout">
      <h2>Add your Rebrickable key first</h2>
      <p>The app needs your free API key to fetch parts lists. <a href="#/settings">Open Settings</a></p>
    </section>`}
    <section class="panel">
      <h2>Add sets</h2>
      <form id="addForm" autocomplete="off">
        <label for="nums">Set numbers</label>
        <div class="inline">
          <input id="nums" name="nums" inputmode="text" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="e.g. 41395, 76396">
          <button class="btn primary" id="addBtn">Add</button>
        </div>
      </form>
      <p class="hint">Use commas or spaces to add several at once. Version -1 is assumed unless you type one, like 75192-2.</p>
      <ul id="addLog" class="log" aria-live="polite"></ul>
    </section>
    <section>
      <h2 class="section-title" id="listTitle">Your sets</h2>
      <div id="setList"></div>
    </section>`;
  await refreshSetList();
}

async function refreshSetList() {
  const el = $('#setList');
  if (!el) return;
  const sets = (await db.all('sets')).filter((s) => !s.deleted)
    .sort((a, b) => a.set_num.localeCompare(b.set_num, undefined, { numeric: true }));
  const activeBy = new Map((await bins.loadContext()).active.map((a) => [a.set.set_num, a]));
  $('#listTitle').textContent = sets.length ? `Your sets (${sets.length})` : 'Your sets';
  if (!sets.length) {
    el.innerHTML = '<p class="empty">No sets yet. Add a set number above to get started.</p>';
    return;
  }
  el.innerHTML = `<ul class="cards">${sets.map((s) => `
    <li>
      <a class="card" href="#/set/${encodeURIComponent(s.set_num)}">
        <div class="setimg">${s.img ? `<img src="${esc(s.img)}" alt="" loading="lazy">` : ''}</div>
        <div class="cardtext">
          <div class="cardname">${esc(s.name)}</div>
          <div class="cardmeta">${esc(s.set_num)} · ${esc(s.year)} · ${fmt(s.pieces)} pieces</div>
          ${activeBy.get(s.set_num) ? `<div class="cardmeta"><span class="binchip">Bin ${activeBy.get(s.set_num).bin.number}</span> ${Math.round(activeBy.get(s.set_num).frac * 100)}% sorted</div>` : ''}
        </div>
        <span class="chev" aria-hidden="true">›</span>
      </a>
    </li>`).join('')}</ul>`;
}

function parseTokens(text) {
  return text.split(/[\s,;]+/).map((t) => t.trim()).filter(Boolean);
}

function logLine(token) {
  const log = $('#addLog');
  if (!log) return { set() {} };
  const li = document.createElement('li');
  log.appendChild(li);
  const api = {
    // state: 'queued' | 'work' | 'ok' | 'err' | 'skip'. While working, a spinner and a progress
    // bar are shown; progress is 0 to 1 when known, otherwise the bar is indeterminate.
    set(text, state = 'work', progress = null) {
      li.className = state;
      const working = state === 'work';
      const known = working && typeof progress === 'number';
      const bar = working
        ? `<div class="bar${known ? '' : ' indet'}" aria-hidden="true"><i${known ? ` style="--p:${Math.round(Math.min(1, progress) * 100)}%"` : ''}></i></div>`
        : '';
      li.innerHTML = `${working ? '<span class="spin" aria-hidden="true"></span>' : ''}<strong>${esc(token)}</strong> ${esc(text)}${bar}`;
    },
  };
  api.set('waiting in line…', 'queued');
  return api;
}

async function addOne(token, line, key) {
  if (!/^[A-Za-z0-9]+(-\d+)?$/.test(token)) {
    throw new Error("doesn't look like a set number");
  }
  const guess = token.includes('-') ? token : `${token}-1`;
  const existing = await db.get('sets', guess);
  if (existing && !existing.deleted) {
    line.set('is already in your list', 'skip');
    return;
  }

  line.set('looking up the set…');
  let info;
  try {
    info = await rb.getSet(guess, key);
  } catch (e) {
    if (e.kind !== 'notfound' || token.includes('-')) {
      throw e.kind === 'notfound' ? new Error('set not found on Rebrickable') : e;
    }
    const found = (await rb.searchSets(token, key)).filter((r) => r.set_num.split('-')[0] === token);
    if (!found.length) throw new Error('set not found on Rebrickable');
    info = found.length === 1 ? found[0] : await chooseVersion(found);
    if (!info) throw new Error('cancelled');
  }

  const dup = await db.get('sets', info.set_num);
  if (dup && !dup.deleted) {
    line.set(`is already in your list as ${info.set_num}`, 'skip');
    return;
  }

  line.set('getting the part categories…');
  const catMap = await ensureCategories(key);
  line.set(`downloading parts for ${decode(info.name)}…`, 'work', 0);
  const results = await rb.getSetParts(info.set_num, key, (n, total) => {
    line.set(
      `downloading parts… ${fmt(n)}${total ? ` of ${fmt(total)}` : ''}`,
      'work',
      total ? n / total : null,
    );
  });
  line.set('saving to this device…');
  const rec = await storeSet(info, results, catMap, dup);
  line.set(`added ${decode(info.name)}: ${fmt(rec.line_count)} part types, ${fmt(rec.pieces)} pieces`, 'ok');
}

async function addSets(text) {
  if (adding) return;
  const key = await getKey();
  if (!key) { toast('Add your Rebrickable key in Settings first.'); return; }
  const tokens = parseTokens(text);
  if (!tokens.length) { toast('Type a set number first.'); return; }

  adding = true;
  const btn = $('#addBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Adding…'; }
  const log = $('#addLog');
  if (log) { log.innerHTML = ''; log.setAttribute('aria-busy', 'true'); }
  rb.setThrottleHook((secs) => toast(`Rebrickable asked us to wait ${secs} second${secs === 1 ? '' : 's'}…`));
  const queue = tokens.map((token) => ({ token, line: logLine(token) }));
  for (const { token, line } of queue) {
    line.set('starting…');
    try {
      await addOne(token, line, key);
    } catch (e) {
      line.set(e.message || String(e), 'err');
    }
    await refreshSetList();
  }
  rb.setThrottleHook(null);
  adding = false;
  const b2 = $('#addBtn');
  if (b2) { b2.disabled = false; b2.textContent = 'Add'; }
  $('#addLog')?.removeAttribute('aria-busy');
}

// ---------- Set detail ----------

async function renderSet(setNum) {
  const rec = await db.get('sets', setNum);
  if (!rec || rec.deleted) {
    setTitle('Set not found');
    view.innerHTML = '<p class="empty">That set isn\'t in your list. <a href="#/">Back to sets</a></p>';
    return;
  }
  setTitle(rec.set_num);
  const lines = await db.byIndex('setParts', 'set_num', setNum);
  lines.sort((a, b) => a.cat_name.localeCompare(b.cat_name) || a.name.localeCompare(b.name)
    || String(a.color_name).localeCompare(String(b.color_name)));

  view.innerHTML = `
    <a class="backlink" href="#/">‹ All sets</a>
    <section class="panel hero">
      <div class="setimg big">${rec.img ? `<img src="${esc(rec.img)}" alt="">` : ''}</div>
      <div>
        <h2 class="setname">${esc(rec.name)}</h2>
        <p class="cardmeta">${esc(rec.set_num)} · ${esc(rec.year)}</p>
        <p class="stats"><strong>${fmt(rec.pieces)}</strong> pieces · <strong>${fmt(rec.line_count)}</strong> part types${
          rec.sticker_lines ? ` · <strong>${fmt(rec.sticker_lines)}</strong> sticker` : ''}</p>
        <p class="hint">${rec.spares ? `${fmt(rec.spares)} spare pieces are not counted. ` : ''}Minifigures are not included.</p>
      </div>
    </section>
    <section class="panel">
      <label for="filter" class="sr">Filter parts</label>
      <input id="filter" type="search" placeholder="Filter by name, part number or colour" autocomplete="off">
      <div id="partList"></div>
    </section>
    <section class="panel" id="binPanel"></section>
    <section class="panel actions">
      <button class="btn" id="refreshSet">Refresh from Rebrickable</button>
      <button class="btn danger" id="removeSet">Remove this set</button>
    </section>`;

  const listEl = $('#partList');
  const draw = (q) => {
    const needle = q.trim().toLowerCase();
    const shown = needle
      ? lines.filter((l) => `${l.name} ${l.part_num} ${l.color_name} ${l.cat_name}`.toLowerCase().includes(needle))
      : lines;
    if (!shown.length) { listEl.innerHTML = '<p class="empty">No parts match.</p>'; return; }
    let html = '';
    let cat = null;
    for (const l of shown) {
      if (l.cat_name !== cat) {
        if (cat !== null) html += '</ul>';
        cat = l.cat_name;
        html += `<h3 class="cat">${esc(cat)}</h3><ul class="parts">`;
      }
      html += partRow(l);
    }
    listEl.innerHTML = `${html}</ul>`;
  };
  draw('');
  $('#filter').addEventListener('input', (e) => draw(e.target.value));

  await drawBinPanel(rec);
  $('#refreshSet').addEventListener('click', () => refreshSet(rec));
  $('#removeSet').addEventListener('click', async () => {
    if (rec.status === 'active') {
      toast('This set has an active bin. Abandon the bin first.');
      return;
    }
    const ok = await ask({
      title: 'Remove this set?',
      body: `${rec.set_num} ${rec.name} will be removed from your list. You can add it again later.`,
      ok: 'Remove',
      danger: true,
    });
    if (!ok) return;
    await db.delByIndex('setParts', 'set_num', rec.set_num);
    await db.put('sets', { ...rec, deleted: true, updated: new Date().toISOString() });
    location.hash = '#/';
  });
}

async function drawBinPanel(rec) {
  const el = $('#binPanel');
  const fresh = await db.get('sets', rec.set_num);
  if (fresh?.status === 'active') {
    const ctx = await bins.loadContext();
    const a = ctx.active.find((x) => x.set.set_num === rec.set_num);
    el.innerHTML = `
      <h2>Bin ${fresh.active_bin}</h2>
      <p>${a ? `${fmt(a.heldTotal)} of ${fmt(a.neededTotal)} pieces sorted (${Math.round(a.frac * 100)}%).` : 'Active.'}</p>
      <div class="actions">
        <a class="btn" href="#/bin/${encodeURIComponent(fresh.bin_id)}">Open bin</a>
        <button class="btn danger" id="abandonBin">Abandon bin</button>
      </div>`;
    $('#abandonBin').addEventListener('click', async () => {
      if (await confirmAbandon(fresh.bin_id)) await renderSet(rec.set_num);
    });
  } else {
    el.innerHTML = `
      <h2>Rebuild this set</h2>
      <p>Starting it gives the set its own numbered bin. Matching pieces you add will be put in that bin until the set is complete.</p>
      <button class="btn primary" id="startBin">Start rebuilding this set</button>`;
    $('#startBin').addEventListener('click', async () => {
      try {
        const bin = await bins.activateSet(rec.set_num);
        toast(`${rec.set_num} now has Bin ${bin.number}.`);
        await renderSet(rec.set_num);
      } catch (e) { toast(e.message); }
    });
  }
}

function partRow(l) {
  return `
    <li class="part">
      <div class="thumb">${l.img ? `<img src="${esc(l.img)}" alt="" loading="lazy">` : ''}</div>
      <div class="pinfo">
        <div class="pname">${esc(l.name)}</div>
        <div class="pmeta">
          <span class="swatch${l.is_trans ? ' trans' : ''}" style="--c:#${esc(l.rgb)}"></span>
          ${esc(l.color_name)} · ${esc(l.part_num)}${l.sticker ? ' <span class="tag">sticker</span>' : ''}
        </div>
      </div>
      <div class="qty" aria-label="Quantity">${fmt(l.qty)}</div>
    </li>`;
}

async function refreshSet(rec) {
  const key = await getKey();
  if (!key) { toast('Add your Rebrickable key in Settings first.'); return; }
  const btn = $('#refreshSet');
  btn.disabled = true;
  btn.textContent = 'Refreshing…';
  try {
    const info = await rb.getSet(rec.set_num, key);
    const catMap = await ensureCategories(key);
    const results = await rb.getSetParts(rec.set_num, key);
    await storeSet(info, results, catMap, rec);
    toast('Parts list refreshed.');
    await renderSet(rec.set_num);
  } catch (e) {
    toast(e.message || 'Refresh failed.');
    btn.disabled = false;
    btn.textContent = 'Refresh from Rebrickable';
  }
}

// ---------- Settings ----------

async function renderSettings() {
  setTitle('Settings');
  const key = await getKey();
  const sets = (await db.all('sets')).filter((s) => !s.deleted);
  const lineCount = sets.reduce((n, s) => n + s.line_count, 0);
  const persistent = await db.isPersistent();
  let persisted = false;
  try { persisted = !!(await navigator.storage?.persisted?.()); } catch { /* ignore */ }

  view.innerHTML = `
    <section class="panel">
      <h2>Rebrickable API key</h2>
      <p>Get a free key from your Rebrickable account. It is stored only on this device and is never part of the code or the GitHub repository.</p>
      <form id="keyForm" autocomplete="off">
        <label for="key">API key</label>
        <input id="key" type="password" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false">
        <div class="row">
          <button type="button" class="btn" id="showKey">Show</button>
          <button type="button" class="btn" id="testKey">Test</button>
          <button class="btn primary">Save</button>
        </div>
      </form>
      <p class="hint" id="keyStatus" role="status">${key ? 'A key is saved on this device.' : 'No key saved yet.'}</p>
    </section>
    <section class="panel">
      <h2>Your data</h2>
      <p>${fmt(sets.length)} sets and ${fmt(lineCount)} part lines are stored on this device${
        persistent ? '' : '. <strong>Warning:</strong> this browser is not keeping data between visits'}.</p>
      ${persistent && !persisted ? '<p class="hint">Tip: add this app to your home screen so the browser is less likely to clear its data.</p>' : ''}
      <button class="btn danger" id="wipe">Delete all sets and parts</button>
      <p class="hint">Your API key is kept.</p>
    </section>
    <p class="foot">Brick Sorter ${esc(APP_VERSION)}<br>Not affiliated with the LEGO Group, Rebrickable or Brickognize.</p>`;

  $('#key').value = key;
  const status = $('#keyStatus');
  const readKey = () => $('#key').value.trim().replace(/^key\s+/i, '');

  $('#showKey').addEventListener('click', (e) => {
    const input = $('#key');
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    e.target.textContent = show ? 'Hide' : 'Show';
  });

  $('#keyForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const k = readKey();
    await db.setSetting('rebrickableKey', k);
    status.textContent = !k
      ? 'Key removed.'
      : /^[0-9a-f]{32}$/i.test(k) ? 'Saved on this device.' : 'Saved, but this does not look like a 32-character key. Use Test to check it.';
  });

  $('#testKey').addEventListener('click', async (e) => {
    const k = readKey();
    if (!k) { status.textContent = 'Type your key first.'; return; }
    e.target.disabled = true;
    status.textContent = 'Testing…';
    try {
      await rb.testKey(k);
      status.textContent = 'The key works. Press Save to keep it.';
    } catch (err) {
      status.textContent = err.message || 'Test failed.';
    }
    e.target.disabled = false;
  });

  $('#wipe').addEventListener('click', async () => {
    const ok = await ask({
      title: 'Delete everything?',
      body: 'Every set, bin and sorted piece on this device will be removed. Your API key stays.',
      ok: 'Delete everything',
      danger: true,
    });
    if (!ok) return;
    await db.clear('setParts');
    await db.clear('sets');
    await db.clear('categories');
    await db.clear('inventory');
    await db.clear('bins');
    await bins.ensureDefaultBins();
    toast('All sets and sorted pieces deleted.');
    await renderSettings();
  });
}

// ---------- start ----------

view.addEventListener('error', (e) => {
  if (e.target.tagName === 'IMG') e.target.style.visibility = 'hidden';
}, true);

view.addEventListener('submit', (e) => {
  if (e.target.id === 'addForm') {
    e.preventDefault();
    const input = $('#nums');
    addSets(input.value).then(() => { if (!$('#addLog .err')) input.value = ''; });
  }
});

window.addEventListener('hashchange', route);
bins.ensureDefaultBins().catch(() => {}).then(route);

try { navigator.storage?.persist?.(); } catch { /* best effort */ }
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => { /* offline support is optional */ });
}
