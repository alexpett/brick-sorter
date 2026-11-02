// Add pieces by hand: search for the part, then use the sorting panel (colour, quantity, bins).
import * as refdata from '../data.js';
import { view, esc, setTitle } from '../ui.js';
import { createSorter, info, refreshInfo, loadColorState, partTag, thumb } from './sorter.js';

let sorter = null;
let root = null;
let results = [];
let query = '';

const $r = (sel) => root.querySelector(sel);

export async function renderAdd() {
  setTitle('Log pieces');
  view.innerHTML = '<p class="empty">Loading the parts catalogue…</p>';
  try {
    await refdata.loadRef();
  } catch (e) {
    view.innerHTML = `<section class="panel"><h2>Couldn't load the parts catalogue</h2><p>${esc(e.message)}</p></section>`;
    return;
  }
  await refreshInfo();
  await loadColorState();
  query = '';
  view.innerHTML = `
    <div id="addRoot">
      <section class="panel" id="stepPart"></section>
      <section class="panel" id="sorterBox" hidden></section>
    </div>`;
  root = view.querySelector('#addRoot');
  sorter = createSorter($r('#sorterBox'), {
    onSaved: () => { query = ''; drawPart(); },
    onChangePart: () => drawPart(),
  });
  root.addEventListener('click', onClick);
  root.addEventListener('input', onInput);
  drawPart();
}

function drawPart() {
  const el = $r('#stepPart');
  el.hidden = false;
  el.innerHTML = `
    <h2>Find the part</h2>
    <a class="btn primary block scanbtn" href="#/scan">Scan a piece with the camera</a>
    <label for="q" class="sr">Search parts</label>
    <input id="q" type="search" placeholder="Part number or words, e.g. 3001 or plate 2 x 4" autocomplete="off" autocapitalize="off" spellcheck="false">
    <div id="results" aria-live="polite"></div>
    <button class="btn block" id="unrec" type="button">I can't identify this piece</button>`;
  $r('#q').value = query;
  drawResults();
}

function drawResults() {
  const el = $r('#results');
  if (!el) return;
  if (!query.trim()) {
    results = [];
    el.innerHTML = '<p class="hint">Parts from your sets are listed first.</p>';
    return;
  }
  results = refdata.searchParts(query, info.yours, 40);
  if (!results.length) { el.innerHTML = '<p class="empty">No parts match.</p>'; return; }
  el.innerHTML = `<ul class="parts results">${results.map((p, i) => `
    <li>
      <button type="button" class="result" data-pick="${i}">
        ${thumb(p.part_num, null)}
        <span class="pinfo">
          <span class="pname">${esc(p.name)}</span>
          <span class="pmeta">${esc(p.part_num)} · ${esc(refdata.categoryName(p.cat_id))}${partTag(p.part_num)}</span>
        </span>
      </button>
    </li>`).join('')}</ul>`;
}

async function choose(part) {
  $r('#stepPart').hidden = true;
  await sorter.setPart(part);
  $r('#sorterBox').scrollIntoView({ block: 'nearest' });
}

function onClick(e) {
  const t = e.target.closest('[data-pick],#unrec');
  if (!t) return;
  if (t.dataset.pick !== undefined) choose(results[Number(t.dataset.pick)]);
  else choose({ unrec: true, part_num: '', name: 'Unrecognised piece', cat_id: null });
}

function onInput(e) {
  if (e.target.id === 'q') { query = e.target.value; drawResults(); }
}
