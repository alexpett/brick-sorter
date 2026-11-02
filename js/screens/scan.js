// Scan: take one photo of one piece; the photo shows at the top, the likely matches below,
// and choosing a match opens the sorting panel on the same screen. Saving returns to the camera.
import * as refdata from '../data.js';
import * as recog from '../recog.js';
import { view, esc, toast, openDialog, setTitle } from '../ui.js';
import { createSorter, info, refreshInfo, loadColorState, partTag } from './sorter.js';

let stream = null;
let root = null;
let busy = false;
let sorter = null;
let lastItems = [];

export function stopCamera() {
  if (stream) for (const t of stream.getTracks()) t.stop();
  stream = null;
}

const $r = (sel) => root?.querySelector(sel);

export async function renderScan() {
  setTitle('Scan a piece');
  busy = false;
  lastItems = [];
  try { await refdata.loadRef(); } catch (e) {
    view.innerHTML = `<section class="panel"><h2>Couldn't load the parts catalogue</h2><p>${esc(e.message)}</p></section>`;
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
          <label class="btn small" for="filePick">Choose photo</label>
          <input type="file" id="filePick" accept="image/*" capture="environment" hidden>
          <button type="button" class="shutter" id="shutter" aria-label="Take photo"><span></span></button>
          <a class="btn small" href="#/add">Search by hand</a>
        </div>
      </section>
      <section class="panel" id="matches"></section>
      <section class="panel" id="sorterBox" hidden></section>
    </div>`;
  root = view.querySelector('#scanRoot');
  sorter = createSorter($r('#sorterBox'), {
    onSaved: () => showLive(),
    onChangePart: () => { root.classList.remove('compact'); $r('#matches').hidden = false; },
  });
  root.addEventListener('click', onClick);
  $r('#filePick').addEventListener('change', onFile);
  showLive();
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

// Back to the live camera, ready for the next piece.
function showLive() {
  if (!root?.isConnected) return;
  sorter?.clear();
  root.classList.remove('compact');
  $r('#still').hidden = true;
  $r('#cam').hidden = false;
  const sh = $r('#shutter');
  sh.classList.remove('again');
  sh.setAttribute('aria-label', 'Take photo');
  const m = $r('#matches');
  m.hidden = false;
  m.innerHTML = '<p class="hint">Put one piece in view and press the round button.</p>';
  window.scrollTo(0, 0);
}

async function select(part) {
  root.classList.add('compact');
  $r('#matches').hidden = true;
  await sorter.setPart(part);
  window.scrollTo(0, 0); // keep the photo in view above the sorting panel
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
  if (pick) { await select(JSON.parse(pick.dataset.part)); return; }
  if (e.target.closest('#unrec')) { await select({ unrec: true, part_num: '', name: 'Unrecognised piece', cat_id: null }); return; }
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
    sorter.clear();
    root.classList.remove('compact');
    matches.hidden = false;
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
    lastItems = res.items;
    await refreshInfo();
    drawMatches(res.items);
  } catch (e) {
    if (root?.isConnected) matches.innerHTML = `<p class="err-text">${esc(e.message || String(e))}</p><p class="hint">Press the round button to try again.</p>${unrecButton()}`;
  } finally {
    busy = false;
  }
}

const unrecButton = () => '<button class="btn block" id="unrec" type="button">I can’t identify this piece</button>';

function drawMatches(items) {
  const matches = $r('#matches');
  if (!items.length) {
    matches.innerHTML = `<p class="empty">No matches. Try again with the piece flatter, closer and on a plain background.</p>${unrecButton()}`;
    return;
  }
  const rows = items.slice(0, 6).map((it) => {
    const idx = refdata.ref.byNum.get(it.id.toLowerCase());
    const part = idx === undefined ? null : { part_num: refdata.ref.parts[idx][0], name: refdata.ref.parts[idx][1], cat_id: refdata.ref.parts[idx][2] };
    const score = it.score === null ? '' : `<span class="score">${Math.round(it.score * 100)}%</span>`;
    const inner = `
      <span class="thumb">${it.img ? `<img src="${esc(it.img)}" alt="" loading="lazy">` : ''}</span>
      <span class="pinfo">
        <span class="pname">${esc(part ? part.name : it.name)}</span>
        <span class="pmeta">${esc(it.id)}${part ? partTag(part.part_num) : ' · not in the parts catalogue'}</span>
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
