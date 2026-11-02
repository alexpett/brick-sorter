// Scan: take one photo of one piece; the photo shows at the top and the likely matches below.
import * as refdata from '../data.js';
import * as bins from '../bins.js';
import * as recog from '../recog.js';
import { view, esc, fmt, toast, openDialog, setTitle } from '../ui.js';
import { choosePartFromScan } from './add.js';

let stream = null;
let root = null;
let busy = false;

export function stopCamera() {
  if (stream) for (const t of stream.getTracks()) t.stop();
  stream = null;
}

const $r = (sel) => root?.querySelector(sel);

export async function renderScan() {
  setTitle('Scan a piece');
  busy = false;
  try { await refdata.loadRef(); } catch (e) {
    view.innerHTML = `<section class="panel"><h2>Couldn't load the parts catalogue</h2><p>${esc(e.message)}</p></section>`;
    return;
  }
  view.innerHTML = `
    <div id="scanRoot">
      <section class="panel scan">
        <div class="viewer" id="viewer">
          <video id="cam" playsinline muted autoplay></video>
          <img id="still" alt="The photo you took" hidden>
          <p class="viewer-msg" id="viewerMsg"></p>
        </div>
        <div class="shutterrow">
          <label class="btn small" for="filePick">Choose photo</label>
          <input type="file" id="filePick" accept="image/*" capture="environment" hidden>
          <button type="button" class="shutter" id="shutter" aria-label="Take photo"><span></span></button>
          <a class="btn small" href="#/add">Search by hand</a>
        </div>
      </section>
      <section class="panel" id="matches"><p class="hint">Put one piece in view and press the round button.</p></section>
    </div>`;
  root = view.querySelector('#scanRoot');
  root.addEventListener('click', onClick);
  $r('#filePick').addEventListener('change', onFile);
  await startCamera();
}

async function startCamera() {
  const msg = $r('#viewerMsg');
  if (!navigator.mediaDevices?.getUserMedia) {
    msg.textContent = 'This browser can’t open the camera here. Use Choose photo instead.';
    $r('#shutter').disabled = true;
    return;
  }
  try {
    stopCamera();
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } }, audio: false });
    if (!root?.isConnected) { stopCamera(); return; }
    const v = $r('#cam');
    v.srcObject = stream;
    await v.play().catch(() => {});
    msg.textContent = '';
  } catch {
    msg.textContent = 'The camera isn’t available (permission refused?). Use Choose photo instead.';
    $r('#shutter').disabled = true;
  }
}

function showLive() {
  $r('#still').hidden = true;
  $r('#cam').hidden = false;
  $r('#shutter').classList.remove('again');
  $r('#shutter').setAttribute('aria-label', 'Take photo');
  $r('#matches').innerHTML = '<p class="hint">Put one piece in view and press the round button.</p>';
}

async function onClick(e) {
  if (e.target.closest('#shutter')) {
    if (busy) return;
    if ($r('#shutter').classList.contains('again')) { showLive(); return; }
    const v = $r('#cam');
    if (!v || !v.videoWidth) { toast('The camera isn’t ready yet.'); return; }
    await handle(v);
    return;
  }
  const pick = e.target.closest('[data-part]');
  if (pick) {
    const p = JSON.parse(pick.dataset.part);
    choosePartFromScan(p);
    location.hash = '#/add';
    return;
  }
  const find = e.target.closest('[data-search]');
  if (find) {
    choosePartFromScan(null, find.dataset.search);
    location.hash = '#/add';
  }
}

async function onFile(e) {
  const f = e.target.files?.[0];
  e.target.value = '';
  if (f) await handle(f);
}

async function consent() {
  if (await recog.hasConsent()) return true;
  const v = await openDialog(`
    <h2>Send photos to Brickognize?</h2>
    <p>To identify a piece, the photo is sent to the free Brickognize service. Their terms say uploaded photos may be stored and used to improve their models. Only the photo is sent, only when you press the button.</p>
    <div class="row">
      <button class="btn" value="cancel" formnovalidate>Not now</button>
      <button class="btn primary" value="ok">OK, continue</button>
    </div>`);
  if (v !== 'ok') return false;
  await recog.giveConsent();
  return true;
}

async function handle(source) {
  if (!(await consent())) return;
  busy = true;
  const matches = $r('#matches');
  try {
    const { blob, canvas } = await recog.prepare(source);
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
    await drawMatches(res.items);
  } catch (e) {
    if (root?.isConnected) matches.innerHTML = `<p class="err-text">${esc(e.message || String(e))}</p><p class="hint">Press the round button to try again.</p>`;
  } finally {
    busy = false;
  }
}

async function drawMatches(items) {
  const matches = $r('#matches');
  if (!items.length) {
    matches.innerHTML = '<p class="empty">No matches. Try again with the piece flatter, closer and on a plain background, or search by hand.</p>';
    return;
  }
  const ctx = await bins.loadContext();
  const needed = new Map();
  for (const a of ctx.active) {
    for (const [k, need] of a.need) {
      const pn = k.split('|')[0];
      if (need - (a.held.get(k) || 0) > 0) {
        if (!needed.has(pn)) needed.set(pn, new Set());
        needed.get(pn).add(a.bin.number);
      }
    }
  }
  const rows = items.slice(0, 6).map((it) => {
    const idx = refdata.ref.byNum.get(it.id.toLowerCase());
    const part = idx === undefined ? null : { part_num: refdata.ref.parts[idx][0], name: refdata.ref.parts[idx][1], cat_id: refdata.ref.parts[idx][2] };
    const bn = part && needed.get(part.part_num);
    const tag = bn ? ` <span class="tag ok">needed: ${[...bn].sort((a, b) => a - b).map((n) => `Bin ${n}`).join(', ')}</span>` : '';
    const score = it.score === null ? '' : `<span class="score">${Math.round(it.score * 100)}%</span>`;
    const inner = `
      <span class="thumb">${it.img ? `<img src="${esc(it.img)}" alt="" loading="lazy">` : ''}</span>
      <span class="pinfo">
        <span class="pname">${esc(part ? part.name : it.name)}</span>
        <span class="pmeta">${esc(it.id)}${part ? '' : ' · not in the parts catalogue'}${tag}</span>
      </span>
      ${score}`;
    return part
      ? `<li><button type="button" class="result" data-part='${esc(JSON.stringify(part))}'>${inner}</button></li>`
      : `<li><button type="button" class="result dim" data-search="${esc(it.id)}">${inner}</button></li>`;
  });
  matches.innerHTML = `<h2>Best matches</h2><ul class="parts results">${rows.join('')}</ul>
    <p class="hint">Tap the right one. Tap the round button to scan another.</p>`;
  void fmt;
}
