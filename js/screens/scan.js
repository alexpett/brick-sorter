// Scan: take one photo of one brick; the photo shows at the top, the likely matches below,
// and choosing a match opens the sorting panel on the same screen. Saving returns to the camera.
import * as refdata from '../data.js';
import * as recog from '../recog.js';
import * as rb from '../rebrickable.js';
import * as db from '../db.js';
import { view, esc, toast, openDialog, setTitle } from '../ui.js';
import { createSorter, hideUndo, info, refreshInfo, loadColorState, partTag, thumb } from './sorter.js';

let stream = null;
let root = null;
let busy = false;
let sorter = null;
let lastItems = [];
let results = []; // typed-search results
let query = '';
let typeFilter = null; // part category id chosen in the Filter dialog (null = every type)
const resolved = new Map(); // brickognize id (lower) -> part | null, filled by lookups

export function stopCamera() {
  if (stream) for (const t of stream.getTracks()) t.stop();
  stream = null;
}

const $r = (sel) => root?.querySelector(sel);

export async function renderScan() {
  setTitle('Log bricks');
  busy = false;
  lastItems = [];
  try { await refdata.loadRef(); } catch (e) {
    view.innerHTML = `<section class="panel"><h2>Couldn’t load the parts catalogue</h2><p>${esc(e.message)}</p></section>`;
    return;
  }
  await refreshInfo();
  await loadColorState();
  view.innerHTML = `
    <div id="scanRoot">
      <section class="panel scan">
        <div class="viewer" id="viewer">
          <video id="cam" playsinline muted autoplay></video>
          <img id="still" alt="The photo you took" hidden>
          <p class="viewer-msg" id="viewerMsg"></p>
        </div>
        <div class="shutterrow">
          <label class="chip addbin camchip" for="filePick" role="button" aria-label="Upload a photo"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 16V4M7 9l5-5 5 5M4 15v4a1 1 0 001 1h14a1 1 0 001-1v-4"/></svg></label>
          <input type="file" id="filePick" accept="image/*" capture="environment" hidden>
          <button type="button" class="shutter" id="shutter" aria-label="Start the camera"><span></span></button>
          <button type="button" class="chip addbin camchip" id="descBtn" aria-label="Search by description"><svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg></button>
        </div>
      </section>
      <section class="panel" id="matches"></section>
      <section class="panel" id="sorterBox" hidden></section>
    </div>`;
  root = view.querySelector('#scanRoot');
  sorter = createSorter($r('#sorterBox'), {
    onSaved: () => showLive(true),
    onUndo: () => { root.classList.add('compact'); $r('#matches').hidden = true; },
    onChangePart: () => { root.classList.remove('compact'); $r('#matches').hidden = false; },
  });
  root.addEventListener('click', onClick);
  root.addEventListener('input', (e) => { if (e.target.id === 'q') { query = e.target.value; drawResults(); } });
  $r('#filePick').addEventListener('change', onFile);
  query = '';
  showLive();
}

async function startCamera() {
  const msg = $r('#viewerMsg');
  if (!navigator.mediaDevices?.getUserMedia) {
    msg.textContent = 'This browser can’t open the camera here. Use the upload button instead.';
    $r('#shutter').disabled = true;
    return;
  }
  msg.textContent = '';
  try {
    stopCamera();
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } }, audio: false });
    if (!root?.isConnected) { stopCamera(); return; }
    const v = $r('#cam');
    v.srcObject = stream;
    await v.play().catch(() => {});
    msg.textContent = '';
  } catch {
    msg.textContent = 'The camera isn’t available (permission refused?). Use the upload button instead.';
    $r('#shutter').disabled = true;
  }
}

// Back to the live camera, ready for the next piece.
function showLive(keepSearch = false) {
  if (!root?.isConnected) return;
  sorter?.clear();
  root.classList.remove('compact');
  $r('#still').hidden = true;
  $r('#cam').hidden = false;
  const sh = $r('#shutter');
  sh.classList.remove('again');
  sh.setAttribute('aria-label', stream ? 'Take photo' : 'Start the camera');
  if (!stream && !$r('#viewerMsg').textContent) $r('#viewerMsg').textContent = 'Tap the round button to start the camera';
  if (!keepSearch) query = '';
  drawSearch();
  window.scrollTo(0, 0);
}

// The typed search sits under the camera until a photo is taken.
function drawSearch() {
  const m = $r('#matches');
  m.hidden = false;
  m.innerHTML = `
    <h2><label for="q">Describe your brick</label></h2>
    <div class="searchrow">
      <input id="q" type="search" placeholder="e.g. brick, plate, tile etc" autocomplete="off" autocapitalize="off" spellcheck="false">
      <button type="button" class="btn lozenge${typeFilter == null ? '' : ' primary'}" id="logFilter" aria-label="Filter by type of brick">Filter</button>
    </div>
    ${typeFilter == null ? '' : `<p class="hint filterline">Showing ${esc(refdata.categoryName(typeFilter))} <button type="button" class="linkbtn" id="logFilterClear">Clear</button></p>`}
    <div id="results" aria-live="polite"></div>
    <button class="btn block" id="unrec" type="button">I can’t identify this brick</button>`;
  $r('#q').value = query;
  drawResults();
}

function drawResults() {
  const el = $r('#results');
  if (!el) return;
  if (!query.trim()) { results = []; el.innerHTML = '<p class="hint">Parts from your sets are listed first.</p>'; return; }
  results = (typeFilter == null ? refdata.searchParts(query, info.yours, 40) : refdata.searchParts(query, info.yours, 4000).filter((p) => p.cat_id === typeFilter).slice(0, 40));
  if (!results.length) { el.innerHTML = '<p class="empty">No parts match.</p>'; return; }
  el.innerHTML = `<ul class="parts results">${results.map((p, i) => `
    <li><button type="button" class="result" data-pick="${i}">
      ${thumb(p.part_num, null)}
      <span class="pinfo"><span class="pname">${esc(p.name)}</span>
      <span class="pmeta">${esc(p.part_num)} · ${esc(refdata.categoryName(p.cat_id))}${partTag(p.part_num)}</span></span>
    </button></li>`).join('')}</ul>`;
}

async function select(part) {
  root.classList.add('compact');
  $r('#matches').hidden = true;
  await sorter.setPart(part);
  window.scrollTo(0, 0); // keep the photo in view above the sorting panel
}

async function typeFilterDialog() {
  const cats = [...refdata.ref.categories].sort((a, b) => a[1].localeCompare(b[1]));
  const { value, data } = await openDialog(`
    <h2>Filter by type</h2>
    <label for="lt">Type of brick</label>
    <select id="lt" name="cat"><option value="">Every type</option>${cats.map(([id, name]) => `<option value="${id}"${id === typeFilter ? ' selected' : ''}>${esc(name)}</option>`).join('')}</select>
    <div class="row spread">
      <button class="btn" value="cancel" formnovalidate>Cancel</button>
      <button class="btn primary" value="apply">Apply</button>
    </div>`, { data: true });
  if (value !== 'apply') return;
  const v = String(data.get('cat') || '');
  typeFilter = v === '' ? null : Number(v);
  drawSearch();
}

async function onClick(e) {
  if (e.target.closest('#logFilter')) { await typeFilterDialog(); return; }
  if (e.target.closest('#logFilterClear')) { typeFilter = null; drawSearch(); return; }
  if (e.target.closest('#descBtn')) {
    if ($r('#shutter').classList.contains('again') || !$r('#q')) showLive();
    const q = $r('#q'); q.scrollIntoView({ block: 'center', behavior: 'smooth' }); q.focus();
    return;
  }
  if (e.target.closest('#shutter')) {
    hideUndo(); // using the camera again: the last save is settled
    if (busy) return;
    if (!stream) { await startCamera(); showLive(); return; } // the first tap switches the camera on
    if ($r('#shutter').classList.contains('again')) { showLive(); return; }
    const v = $r('#cam');
    if (!v || !v.videoWidth) { toast('The camera isn’t ready yet.'); return; }
    await handle(v, recog.visibleCrop(v)); // send only what the viewer shows
    return;
  }
  const typed = e.target.closest('[data-pick]');
  if (typed) { await select(results[Number(typed.dataset.pick)]); return; }
  const pick = e.target.closest('[data-part]');
  if (pick) { await select(JSON.parse(pick.dataset.part)); return; }
  if (e.target.closest('#unrec')) { await select({ unrec: true, part_num: '', name: 'Unrecognised brick', cat_id: null }); return; }
}

async function onFile(e) {
  const f = e.target.files?.[0];
  e.target.value = '';
  if (f) { hideUndo(); await handle(f); }
}

async function consent() {
  if (await recog.hasConsent()) return true;
  const v = await openDialog(`
    <h2>Send photos to Brickognize?</h2>
    <p>To identify a brick, the photo is sent to the free Brickognize service. Their terms say uploaded photos may be stored and used to improve their models. Only the photo is sent, only when you press the button.</p>
    <div class="row">
      <button class="btn" value="cancel" formnovalidate>Cancel</button>
      <button class="btn primary" value="ok">OK, continue</button>
    </div>`);
  if (v !== 'ok') return false;
  await recog.giveConsent();
  return true;
}

async function handle(source, crop = null) {
  if (!(await consent())) return;
  busy = true;
  const matches = $r('#matches');
  try {
    sorter.clear();
    root.classList.remove('compact');
    matches.hidden = false;
    const { blob, canvas } = await recog.prepare(source, 1024, crop);
    const still = $r('#still');
    still.src = canvas.toDataURL('image/jpeg', 0.8);
    still.hidden = false;
    $r('#cam').hidden = true;
    const sh = $r('#shutter');
    sh.classList.add('again');
    sh.setAttribute('aria-label', 'Scan another');
    matches.innerHTML = '<p class="working"><span class="spin" aria-hidden="true"></span>Identifying…</p>';
    const res = await recog.identify(blob);
    if (!root?.isConnected) return;
    lastItems = res.items;
    await refreshInfo();
    drawMatches(res.items);
    resolveMissing(res.items);
  } catch (e) {
    if (root?.isConnected) matches.innerHTML = `<p class="err-text">${esc(e.message || String(e))}</p><p class="hint">Press the round button to try again.</p>${unrecButton()}`;
  } finally {
    busy = false;
  }
}

const unrecButton = () => '<button class="btn block" id="unrec" type="button">I can’t identify this brick</button>';

// Items whose number isn’t in the catalogue: ask Rebrickable which of its parts BrickLink calls that
// (needs the API key), otherwise fall back to the closest local guess.
async function resolveMissing(items) {
  const key = (await db.getSetting('rebrickableKey')) || '';
  let changed = false;
  for (const it of items.slice(0, 6)) {
    const k = it.id.toLowerCase();
    if (refdata.ref.byNum.has(k) || resolved.has(k)) continue;
    let part = null;
    if (key) {
      try {
        const r = (await rb.findByBricklink(it.id, key))[0];
        if (r) part = { part_num: r.part_num, name: r.name, cat_id: r.part_cat_id };
      } catch { /* fall through to the local guess */ }
    }
    resolved.set(k, part || refdata.guessCatalogue(it.id));
    changed = true;
    if (root?.isConnected && items === lastItems) drawMatches(items);
  }
  void changed;
}

function drawMatches(items) {
  const matches = $r('#matches');
  if (!items.length) {
    matches.innerHTML = `<p class="empty">No matches. Try again with the brick flatter, closer and on a plain background.</p>${unrecButton()}`;
    return;
  }
  const rows = items.slice(0, 6).map((it) => {
    const idx = refdata.ref.byNum.get(it.id.toLowerCase());
    const part = idx === undefined ? (resolved.get(it.id.toLowerCase()) || null) : { part_num: refdata.ref.parts[idx][0], name: refdata.ref.parts[idx][1], cat_id: refdata.ref.parts[idx][2] };
    const pending = idx === undefined && !resolved.has(it.id.toLowerCase());
    const mapped = part && part.part_num.toLowerCase() !== it.id.toLowerCase();
    const score = it.score === null ? '' : `<span class="score">${Math.round(it.score * 100)}%</span>`;
    const inner = `
      <span class="thumb">${it.img ? `<img src="${esc(it.img)}" alt="" loading="lazy">` : ''}</span>
      <span class="pinfo">
        <span class="pname">${esc(part ? part.name : it.name)}</span>
        <span class="pmeta">${esc(it.id)}${part ? `${mapped ? ` → ${esc(part.part_num)}${part.assembly ? ' (without the glass or other fitted parts)' : part.approx ? ' (plain version)' : ''}` : ''}${partTag(part.part_num)}` : pending ? ' · looking up…' : ' · not in the parts catalogue'}</span>
      </span>
      ${score}`;
    return part
      ? `<li><button type="button" class="result" data-part='${esc(JSON.stringify(part))}'>${inner}</button></li>`
      : `<li><button type="button" class="result dim" disabled>${inner}</button></li>`;
  });
  matches.innerHTML = `<h2>Best matches</h2><ul class="parts results">${rows.join('')}</ul>
    <p class="hint">Tap the right one.</p>${unrecButton()}`;
  void info;
}
