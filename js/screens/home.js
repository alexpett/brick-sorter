// Overview: the landing page. Key figures roll up from zero, with quick actions and bin progress.
import * as bins from '../bins.js';
import { view, esc, fmt, setTitle, openDialog, toast } from '../ui.js';
import * as rewards from '../rewards.js';
import * as sync from '../sync.js';

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

  const rs = await rewards.loadStats(ctx);
  await rewards.checkNew().catch(() => {}); // first run: note what is already earned, quietly
  const earned = new Set(rewards.earnedIds(rs));
  const ring = Math.min(1, rs.today / rs.goal);
  const R = 34, C = 2 * Math.PI * R;
  const ms = rewards.nextMilestone(rs.total);
  const weekMax = Math.max(rs.goal, ...rs.week.map((d) => d.n));
  const today = `
    <section class="panel today" aria-label="Today">
      <div class="todayrow">
        <button type="button" class="ringbtn" id="goalBtn" aria-label="Daily goal: ${fmt(rs.today)} of ${fmt(rs.goal)} pieces. Tap to change the goal">
          <svg viewBox="0 0 80 80" width="88" height="88" aria-hidden="true">
            <circle cx="40" cy="40" r="${R}" class="ringbg"/>
            <circle cx="40" cy="40" r="${R}" class="ringfg" stroke-dasharray="${(C * ring).toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 40 40)"/>
          </svg>
          <span class="ringtext"><strong>${fmt(rs.today)}</strong><small>of ${fmt(rs.goal)}</small></span>
        </button>
        <div class="todaytext">
          <div class="todayhead">${rs.today >= rs.goal ? 'Goal reached today! 🎯' : `${fmt(rs.goal - rs.today)} to today’s goal`}</div>
          <div class="streak"><svg class="flame" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3c1 3 5 5 5 10a5 5 0 0 1-10 0c0-2 1-3 2-4 0 2 1 3 2 3 0-3-1-5 1-9z"/></svg> ${rs.streak} day${rs.streak === 1 ? '' : 's'} in a row${rs.best > rs.streak ? ` · best ${rs.best}` : ''}</div>
        </div>
      </div>
      <div class="week" aria-label="Last 7 days">${rs.week.map((d) => `<div class="wday${d.today ? ' now' : ''}"><i style="--h:${Math.round((d.n / weekMax) * 100)}%" title="${fmt(d.n)}"></i><span>${esc(d.label)}</span></div>`).join('')}</div>
      <div class="milestone">
        <div class="cardmeta">${ms.next ? `${fmt(ms.next - rs.total)} bricks to ${fmt(ms.next)}` : 'Every milestone reached!'}</div>
        <div class="bar solid" aria-hidden="true"><i style="--p:${ms.pct}%"></i></div>
      </div>
    </section>`;
  const badges = `
    <section>
      <h2 class="section-title">Badges <small>${earned.size} of ${rewards.BADGES.length}</small></h2>
      <ul class="badges">${rewards.BADGES.map((b) => `
        <li class="badge${earned.has(b.id) ? ' got' : ''}">
          <span class="bicon" aria-hidden="true">${earned.has(b.id) ? b.icon : '🔒'}</span>
          <span class="bname">${esc(b.name)}</span>
          <span class="bdesc">${esc(b.desc)}</span>
        </li>`).join('')}</ul>
    </section>`;

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
            <div class="cardmeta">${fmt(a.heldTotal)} of ${fmt(a.neededTotal)} bricks · ${pct}%</div>
            <div class="bar solid" aria-hidden="true"><i style="--p:${pct}%"></i></div>
          </div>
          <span class="chev" aria-hidden="true">›</span>
        </a>
      </li>`;
  }).join('');

  // Right after clearing browser data the app looks empty until the sheet has been read; say so.
  let restoring = '';
  if (setsAdded === 0 && (await sync.isConfigured().catch(() => false))) {
    restoring = `<section class="panel"><h2>${sync.state.running ? 'Restoring from your Google Sheet…' : 'Nothing on this device yet'}</h2>
      <p>${sync.state.running ? 'Your sets, bins and sorted bricks are being brought back, parts lists included. Nothing has been lost.' : 'Your data is safe in your Google Sheet. Open Settings and tap Sync now to bring it back.'}</p>
      ${sync.state.running ? '' : '<a class="btn primary" href="#/settings">Open Settings</a>'}</section>`;
  }
  view.innerHTML = `
    ${restoring}
    <section class="stats" id="stats">
      ${stat('Sets added', setsAdded)}
      ${stat('Bricks found', found, 'in your set bins')}
      ${stat('Total bricks sorted', sorted, 'including storage')}
      ${stat('Sets complete', complete)}
    </section>
    ${today}
    <section class="quick">
      <a class="btn primary block" href="#/add">Log pieces</a>
    </section>
    ${rows ? `<section><h2 class="section-title">In progress</h2><ul class="cards">${rows}</ul></section>` : `
    <section class="panel"><p class="empty">${setsAdded ? 'Open a set and choose “Start build” to give it a bin.' : 'Add a set to get started.'} <a href="#/sets">Go to Sets</a></p></section>`}`;
  view.insertAdjacentHTML('beforeend', badges);
  view.querySelector('#goalBtn').addEventListener('click', async () => {
    const { value, data } = await openDialog(`
      <h2>Daily goal</h2>
      <label for="dg">Pieces to sort each day</label>
      <input id="dg" name="goal" type="number" inputmode="numeric" min="1" max="99999" step="1" required value="${rs.goal}">
      <div class="row"><button class="btn" value="cancel" formnovalidate>Cancel</button><button class="btn primary" value="ok">Save</button></div>`, { data: true });
    if (value !== 'ok') return;
    const n = Number(data.get('goal'));
    if (!Number.isInteger(n) || n < 1 || n > 99999) { toast('Enter a whole number from 1 to 99,999.'); return; }
    await rewards.setGoal(n);
    await renderHome();
  });
  rollUp(view.querySelector('#stats'));
}
