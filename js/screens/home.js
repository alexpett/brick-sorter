// Overview: the landing page. Key figures roll up from zero, with quick actions and bin progress.
import * as bins from '../bins.js';
import { view, esc, fmt, setTitle } from '../ui.js';

const reduced = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

// Counts each [data-count] element up from 0 with an ease-out curve.
function rollUp(root) {
  const els = [...root.querySelectorAll('[data-count]')];
  if (reduced()) { for (const el of els) el.textContent = fmt(Number(el.dataset.count)); return; }
  const start = performance.now();
  const duration = 1300;
  const tick = (now) => {
    let running = false;
    els.forEach((el, i) => {
      const target = Number(el.dataset.count);
      const t = Math.min(1, Math.max(0, (now - start - i * 120) / duration));
      const eased = 1 - (1 - t) ** 3;
      el.textContent = fmt(Math.round(target * eased));
      if (t < 1) running = true;
    });
    if (running && root.isConnected) requestAnimationFrame(tick);
    else for (const el of els) el.textContent = fmt(Number(el.dataset.count));
  };
  requestAnimationFrame(tick);
}

export async function renderHome() {
  setTitle('Overview');
  const ctx = await bins.loadContext();
  const setsAdded = ctx.sets.filter((s) => !s.deleted).length;
  const found = ctx.active.reduce((n, a) => n + a.heldTotal, 0);
  const sorted = [...ctx.byBin.values()].flat().reduce((n, l) => n + l.qty, 0);
  const complete = ctx.active.filter((a) => a.neededTotal > 0 && a.heldTotal >= a.neededTotal).length;

  const stat = (label, value, hint = '') => `
    <div class="stat">
      <div class="statnum" data-count="${value}" aria-label="${esc(label)}: ${fmt(value)}">0</div>
      <div class="statlabel">${esc(label)}</div>
      ${hint ? `<div class="stathint">${esc(hint)}</div>` : ''}
    </div>`;

  const rows = ctx.active.map((a) => {
    const pct = Math.round(a.frac * 100);
    return `
      <li>
        <a class="card binrow" href="#/bin/${encodeURIComponent(a.bin.id)}">
          <span class="binchip big"${bins.chipStyle(a.bin)}>Bin ${a.bin.number}</span>
          <div class="cardtext">
            <div class="cardname">${esc(a.set.name)}</div>
            <div class="cardmeta">${fmt(a.heldTotal)} of ${fmt(a.neededTotal)} pieces · ${pct}%</div>
            <div class="bar solid" aria-hidden="true"><i style="--p:${pct}%"></i></div>
          </div>
          <span class="chev" aria-hidden="true">›</span>
        </a>
      </li>`;
  }).join('');

  view.innerHTML = `
    <section class="stats" id="stats">
      ${stat('Sets added', setsAdded)}
      ${stat('Pieces found', found, 'in your set bins')}
      ${stat('Total pieces sorted', sorted, 'including storage')}
      ${stat('Sets complete', complete)}
    </section>
    <section class="quick">
      <a class="btn primary block" href="#/scan">Scan a piece</a>
      <a class="btn block" href="#/add">Log a piece by hand</a>
    </section>
    ${rows ? `<section><h2 class="section-title">In progress</h2><ul class="cards">${rows}</ul></section>` : `
    <section class="panel"><p class="empty">${setsAdded ? 'Open a set and choose “Start rebuilding this set” to give it a bin.' : 'Add a set to get started.'} <a href="#/sets">Go to Sets</a></p></section>`}`;
  rollUp(view.querySelector('#stats'));
}
