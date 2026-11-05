import * as db from './db.js';
import * as rb from './rebrickable.js';
import * as refdata from './data.js';
import * as bins from './bins.js';
import * as sync from './sync.js';
import { $, view, esc, decode, fmt, safeRgb, setTitle, toast, openDialog, ask } from './ui.js';
import { renderAdd } from './screens/add.js';
import { renderScan, stopCamera } from './screens/scan.js';
import { renderHome } from './screens/home.js';
import { renderBins, renderBin, confirmAbandon, exportSorting, drawRules } from './screens/bins.js';


// ---------- dialogs ----------

async function chooseVersion(options) {
  const buttons = options.map((o, i) => `
    <button class="choice" value="${i}">
      <strong>${esc(o.set_num)}</strong>
      <span>${esc(decode(o.name))} · ${esc(o.year)} · ${fmt(o.num_parts)} pieces</span>
    </button>`).join('');
  const host = document.querySelector('#addChoice'); // the Add sets pop-up is open: ask inside it
  if (host) {
    return new Promise((resolve) => {
      host.innerHTML = `<h3>Which version?</h3><p>Rebrickable lists more than one match. Pick the one you own.</p>
        <div class="choices">${buttons.replaceAll('<button class="choice"', '<button type="button" class="choice"')}</div>
        <button type="button" class="btn" data-cancel>Cancel</button>`;
      host.hidden = false;
      host.onclick = (e) => {
        const b = e.target.closest('.choice, [data-cancel]');
        if (!b) return;
        host.hidden = true; host.innerHTML = ''; host.onclick = null;
        resolve(b.matches('.choice') ? options[Number(b.value)] : null);
      };
    });
  }
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
    parts_at: now,
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
  '': renderHome,
  home: renderHome,
  sets: renderSets,
  set: renderSet,
  add: renderAdd,
  scan: renderScan,
  bins: renderBins,
  bin: renderBin,
  settings: renderSettings,
};

async function route() {
  const [, page = '', arg] = (location.hash.slice(1) || '/').split('/');
  stopCamera();
  const handler = routes[page] || renderHome;
  const tab = { add: 'add', scan: 'add', bins: 'bins', bin: 'bins', sets: 'sets', set: 'sets', settings: 'settings', home: 'home', '': 'home' }[page] || 'home';
  $('#cog')?.classList.toggle('active', tab === 'settings' || tab === 'home');
  closeMenu();
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
    <section>
      <div class="sectionhead">
        <h2 class="section-title" id="listTitle">Your sets</h2>
        <button type="button" class="chip addbin" id="showAdd" hidden>+ Add set</button>
      </div>
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
  if (!el.isConnected || !$('#listTitle')) return; // the screen changed while we were loading
  $('#listTitle').textContent = sets.length ? `Your sets (${sets.length})` : 'Your sets';
  $('#showAdd').hidden = !sets.length;
  const addTile = '<button type="button" class="addsettile" id="addTile">+ Add set</button>';
  if (!sets.length) {
    el.innerHTML = addTile;
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
    </li>`).join('')}</ul>${addTile}`;
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
    view.innerHTML = '<p class="empty">That set isn\'t in your list. <a href="#/sets">Back to sets</a></p>';
    return;
  }
  setTitle(rec.set_num);
  const lines = await db.byIndex('setParts', 'set_num', setNum);
  lines.sort((a, b) => a.cat_name.localeCompare(b.cat_name) || a.name.localeCompare(b.name)
    || String(a.color_name).localeCompare(String(b.color_name)));

  view.innerHTML = `
    <a class="backlink" href="#/sets">‹ All sets</a>
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
    <section class="panel" id="binPanel"></section>
    <section class="panel">
      <label for="filter" class="sr">Filter parts</label>
      <input id="filter" type="search" placeholder="Filter by name, part number or colour" autocomplete="off">
      <div id="partList"></div>
    </section>
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
    location.hash = '#/sets';
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
        const m = await bins.storageMatches(await bins.loadContext(), rec.set_num);
        toast(m.pieces
          ? `${rec.set_num} now has Bin ${bin.number}. ${fmt(m.pieces)} matching pieces are already in storage: see Missing in the bin.`
          : `${rec.set_num} now has Bin ${bin.number}.`);
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
    <section class="panel" id="syncPanel">
      <h2>Google Sheet backup</h2>
      <p id="syncSummary"></p>
      <details class="rules">
        <summary>How to set it up</summary>
        <ol class="steps">
          <li>On a computer, create a new Google Sheet.</li>
          <li>Open <strong>Extensions &gt; Apps Script</strong> and replace its contents with the script from the <code>apps-script</code> folder of the GitHub repository (open <code>Code.gs</code>, then Raw, and copy it all).</li>
          <li>Make up a long secret code and put it between the quotes after <code>SECRET_CODE</code>. Use the same code below.</li>
          <li><strong>Deploy &gt; New deployment &gt; Web app</strong>. Run as: Me. Who has access: Anyone. Approve the permissions (Google shows a warning for your own scripts; use Advanced).</li>
          <li>Copy the Web app address (it ends in <code>/exec</code>) and paste it below with the secret code, then Test and Save.</li>
        </ol>
      </details>
      <form id="syncForm" autocomplete="off">
        <label for="syncUrl">Web app address</label>
        <input id="syncUrl" type="url" inputmode="url" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="https://script.google.com/macros/s/…/exec">
        <label for="syncToken">Secret code</label>
        <input id="syncToken" type="password" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false">
        <div class="row">
          <button type="button" class="btn" id="makeCode">Make a code</button>
          <button type="button" class="btn" id="showToken">Show</button>
          <button type="button" class="btn" id="copyToken">Copy</button>
        </div>
        <div class="row">
          <button type="button" class="btn" id="testSync">Test</button>
          <button class="btn primary">Save</button>
        </div>
      </form>
      <button class="btn block" id="syncNow">Sync now</button>
      <p class="hint" id="syncStatus" role="status"></p>
      <p class="hint">Sets, bins and sorted pieces are backed up. Parts lists are fetched again from Rebrickable on a new device. Your Rebrickable key is never sent to the sheet.</p>
    </section>
    <section class="panel">
      <h2>Storage sorting</h2>
      <p class="hint">Where pieces are stored when no active set needs them.</p>
      <details class="rules" id="rules"><summary>Storage rules</summary><div id="rulesBody"></div></details>
      <button type="button" class="btn block" id="exportSort">Export sorting data</button>
      <p class="hint">A file of what is in each storage bin, the rules and your recent choices. Share it to get the rules tuned.</p>
    </section>
    <section class="panel">
      <h2>Your data</h2>
      <p>${fmt(sets.length)} sets and ${fmt(lineCount)} part lines are stored on this device${
        persistent ? '' : '. <strong>Warning:</strong> this browser is not keeping data between visits'}.</p>
      ${persistent && !persisted ? '<p class="hint">Tip: add this app to your home screen so the browser is less likely to clear its data.</p>' : ''}
      <button class="btn danger" id="wipe">Delete all sets and parts</button>
      <p class="hint">Your API key is kept.</p>
    </section>
    <p class="foot">Brick Sorter <span id="appVersion">…</span><br>Not affiliated with the LEGO Group, Rebrickable or Brickognize.</p>`;

  $('#key').value = key;
  try {
    const names = (await caches.keys()).filter((n) => n.startsWith('brick-sorter-'));
    $('#appVersion').textContent = `build ${names.map((n) => n.replace('brick-sorter-', '')).sort().pop() || '(not cached yet)'}`;
  } catch { $('#appVersion').textContent = ''; }
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

  await setupSyncPanel();
  $('#exportSort').addEventListener('click', async () => {
    try { toast(await exportSorting(await bins.loadContext())); } catch (err) { toast(err.message || 'Could not export.'); }
  });
  $('#rules').addEventListener('toggle', async () => { if ($('#rules').open) { await refdata.loadRef().catch(() => {}); await drawRules(); } });

  $('#wipe').addEventListener('click', async () => {
    const ok = await ask({
      title: 'Delete everything?',
      body: 'Every set, bin and sorted piece will be removed from this device, and from the Google Sheet if backup is on. Your API key stays.',
      ok: 'Delete everything',
      danger: true,
    });
    if (!ok) return;
    // Soft delete so that, if backup is on, the deletion reaches the sheet too.
    const now = new Date().toISOString();
    for (const t of ['sets', 'bins', 'inventory']) {
      const rows = await db.all(t);
      await db.putMany(t, rows.map((r) => ({
        ...r, deleted: true, updated: now,
        ...(t === 'sets' ? { status: 'catalogued', active_bin: null, bin_id: null, priority: null } : {}),
      })));
    }
    await db.clear('setParts');
    await db.clear('categories');
    await bins.ensureDefaultBins();
    toast('All sets and sorted pieces deleted.');
    await renderSettings();
  });
}

// ---------- Google Sheet sync ----------

let restoring = false;

// After pulling sets from the sheet (a new device, or after a reset) the parts lists are missing;
// fetch them again from Rebrickable.
async function restoreMissingParts() {
  if (restoring) return 0;
  const missing = [];
  for (const s of (await db.all('sets')).filter((x) => !x.deleted)) {
    if (!(await db.byIndex('setParts', 'set_num', s.set_num)).length) missing.push(s);
  }
  if (!missing.length) return 0;
  const key = await getKey();
  if (!key) { toast('Sets were restored. Add your Rebrickable key in Settings to download their parts lists.'); return 0; }
  restoring = true;
  let done = 0;
  try {
    const catMap = await ensureCategories(key);
    for (const s of missing) {
      toast(`Downloading parts for ${s.set_num} (${done + 1} of ${missing.length})…`);
      const info = await rb.getSet(s.set_num, key);
      const results = await rb.getSetParts(s.set_num, key);
      await storeSet(info, results, catMap, s);
      done++;
    }
    toast(`Restored ${done} ${done === 1 ? 'set' : 'sets'}.`);
  } catch (e) {
    toast(`Could not download all parts lists: ${e.message || e}`);
  } finally {
    restoring = false;
  }
  return done;
}

async function afterSync(r) {
  if (r.pulled) {
    if (r.partsRestored) toast(`Restored the parts lists for ${r.partsRestored} ${r.partsRestored === 1 ? 'set' : 'sets'} from your sheet.`);
    await restoreMissingParts(); // only sets the sheet had no parts for (older backups) go to Rebrickable
    const hash = location.hash;
    if (!/^#\/(add|settings)/.test(hash) && !document.querySelector('dialog[open]')) await route(); // refresh what's on screen
  }
}

async function paintSyncPill() {
  const el = $('#syncState');
  if (!el) return;
  const configured = await sync.isConfigured();
  el.hidden = !configured;
  if (!configured) return;
  const st = sync.state;
  let text = 'Backed up';
  let cls = 'ok';
  if (st.running) { text = 'Syncing…'; cls = 'work'; }
  else if (st.error) { text = 'Sync problem'; cls = 'err'; }
  else if (st.pending > 0) { text = 'Not backed up yet'; cls = 'warn'; }
  el.textContent = text;
  el.className = `pill ${cls}`;
}

async function setupSyncPanel() {
  const cfg = await sync.getConfig();
  $('#syncUrl').value = cfg.url;
  $('#syncToken').value = cfg.token;
  const status = $('#syncStatus');
  const summary = $('#syncSummary');
  const paint = async () => {
    const c = await sync.getConfig();
    const last = await db.getSetting('lastSyncAt');
    await sync.countPending().catch(() => {});
    if (!summary.isConnected) return; // the screen changed while we were reading
    if (!c.url || !c.token) summary.textContent = 'Not set up. Your data is only on this device.';
    else if (sync.state.error) summary.textContent = `Problem: ${sync.state.error}`;
    else summary.textContent = `${last ? `Last backed up ${new Date(last).toLocaleString('en-GB')}.` : 'Set up, not backed up yet.'}${sync.state.pending ? ` ${fmt(sync.state.pending)} changes waiting.` : ''}`;
    $('#syncNow').disabled = !c.url || !c.token || sync.state.running;
    $('#syncNow').textContent = sync.state.running ? 'Syncing…' : 'Sync now';
  };
  await paint();
  sync.onState(() => { if ($('#syncPanel')) paint(); });

  const read = () => ({ url: $('#syncUrl').value.trim(), token: $('#syncToken').value.trim() });
  $('#showToken').addEventListener('click', (e) => {
    const i = $('#syncToken');
    const show = i.type === 'password';
    i.type = show ? 'text' : 'password';
    e.target.textContent = show ? 'Hide' : 'Show';
  });
  $('#makeCode').addEventListener('click', () => {
    $('#syncToken').value = sync.makeSecretCode();
    $('#syncToken').type = 'text';
    $('#showToken').textContent = 'Hide';
    status.textContent = 'New code made. Copy it into SECRET_CODE in the script, then press Save.';
  });
  $('#copyToken').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('#syncToken').value);
      status.textContent = 'Code copied.';
    } catch { status.textContent = "Couldn't copy. Show the code and copy it by hand."; }
  });
  $('#testSync').addEventListener('click', async (e) => {
    const c = read();
    if (!c.url || !c.token) { status.textContent = 'Enter the address and the code first.'; return; }
    e.target.disabled = true;
    status.textContent = 'Testing…';
    try {
      const r = await sync.test(c);
      status.textContent = `Connected to the sheet “${r.name}”. Press Save to keep these.`;
    } catch (err) { status.textContent = err.message; }
    e.target.disabled = false;
  });
  $('#syncForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const c = read();
    const old = await sync.getConfig();
    await db.setSetting('syncUrl', c.url);
    await db.setSetting('syncToken', c.token);
    if (c.url !== old.url) await sync.resetCursor(); // a different sheet needs everything sent
    status.textContent = c.url && c.token ? 'Saved. Syncing…' : 'Backup turned off.';
    await paintSyncPill();
    if (c.url && c.token) await runSync();
    await paint();
  });
  $('#syncNow').addEventListener('click', async () => { await runSync(); await paint(); });

  async function runSync() {
    try {
      const r = await sync.syncNow();
      if (r) {
        status.textContent = `Done. Sent ${fmt(r.pushed)}, received ${fmt(r.pulled)}.`;
        await afterSync(r);
      }
    } catch (err) { status.textContent = err.message; }
    await paintSyncPill();
  }
}

// ---------- header menu (cog) ----------

function closeMenu() {
  const m = $('#menu');
  if (m) m.hidden = true;
  $('#cog')?.setAttribute('aria-expanded', 'false');
}

$('#cog')?.addEventListener('click', (e) => {
  e.preventDefault();
  const m = $('#menu');
  const open = m.hidden;
  m.hidden = !open;
  e.currentTarget.setAttribute('aria-expanded', String(open));
});
document.addEventListener('click', (e) => { if (!e.target.closest('#menu, #cog')) closeMenu(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });

// ---------- start ----------

view.addEventListener('error', (e) => {
  if (e.target.tagName === 'IMG') e.target.style.visibility = 'hidden';
}, true);

view.addEventListener('click', (e) => {
  if (e.target.closest('#showAdd, #addTile')) showAddDialog();
});

// "Add sets" in a pop-up. It stays open while sets download, so the progress lines stay visible.
function showAddDialog() {
  const done = openDialog(`
    <h2>Add sets</h2>
    <div id="addForm">
      <label for="nums">Set numbers</label>
      <div class="inline">
        <input id="nums" name="nums" inputmode="text" autocapitalize="off" autocorrect="off" spellcheck="false" autocomplete="off" placeholder="e.g. 41395, 76396">
        <button type="button" class="btn primary" id="addBtn">Add</button>
      </div>
    </div>
    <p class="hint">Use commas or spaces to add several at once. Version -1 is assumed unless you type one, like 75192-2.</p>
    <div id="addChoice" hidden></div>
    <ul id="addLog" class="log" aria-live="polite"></ul>
    <div class="row" style="justify-content:flex-end"><button class="btn" value="close" id="closeAdd" formnovalidate>Close</button></div>`);
  const d = $('#dlg');
  const run = () => { const input = $('#nums'); addSets(input.value).then(() => { if (!$('#addLog .err')) input.value = ''; }); };
  $('#addBtn').addEventListener('click', run);
  $('#nums').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); run(); } });
  d.querySelector('form').addEventListener('submit', (e) => {
    if (e.submitter?.id === 'closeAdd' && !adding) return; // Close
    e.preventDefault();
    if (e.submitter?.id === 'closeAdd') toast('Still adding. One moment.');
    else run();
  });
  d.oncancel = (e) => { if (adding) e.preventDefault(); }; // Escape / back while downloading
  const away = () => { if (!adding && d.open) d.close(); };
  window.addEventListener('hashchange', away);
  done.then(() => { d.oncancel = null; window.removeEventListener('hashchange', away); });
}

window.addEventListener('hashchange', route);
bins.ensureDefaultBins().catch(() => {}).then(route).then(() => {
  sync.onState(paintSyncPill);
  paintSyncPill();
  sync.startAuto(async (r) => { await afterSync(r); await paintSyncPill(); });
});
$('#syncState')?.addEventListener('click', () => { location.hash = '#/settings'; });

try { navigator.storage?.persist?.(); } catch { /* best effort */ }
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => { /* offline support is optional */ });
}
