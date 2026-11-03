// Small helpers shared by every screen: DOM shortcuts, escaping, toasts and dialogs.
export const $ = (sel, root = document) => root.querySelector(sel);
export const view = $('#view');

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

// Rebrickable names can contain HTML entities such as &amp; or &#39;.
export function decode(s) {
  const t = document.createElement('textarea');
  t.innerHTML = s ?? '';
  return t.value;
}

export const fmt = (n) => Number(n || 0).toLocaleString('en-GB');
export const safeRgb = (rgb) => (/^[0-9a-f]{6}$/i.test(rgb || '') ? rgb : '999999');

export function setTitle(t) {
  $('#title').textContent = t;
  document.title = t === 'Overview' ? 'Brick Sorter' : `${t} · Brick Sorter`;
}

let toastTimer;
export function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3500);
}

// Shows html inside the shared <dialog>. Resolves with the clicked button's value
// ('' if dismissed), or { value, data } with the form's fields when data is true.
export function openDialog(html, { data = false } = {}) {
  return new Promise((resolve) => {
    const d = $('#dlg');
    d.innerHTML = `<form method="dialog">${html}</form>`;
    d.returnValue = '';
    // − / + buttons (see stepperHtml) adjust the number box they point at.
    d.onclick = (e) => {
      const b = e.target.closest('[data-step]');
      if (!b) return;
      const inp = d.querySelector(`#${b.dataset.for}`);
      if (!inp) return;
      const n = Number(inp.value) || Number(inp.min) || 0;
      inp.value = String(Math.min(Number(inp.max) || 99999, Math.max(Number(inp.min) || 0, n + Number(b.dataset.step))));
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    };
    d.onclose = () => {
      d.onclick = null;
      const value = d.returnValue;
      resolve(data ? { value, data: new FormData(d.querySelector('form')) } : value);
    };
    d.showModal();
    // Don't pop the keyboard up: move focus off the first input to the dialog itself.
    d.setAttribute('tabindex', '-1');
    d.focus({ preventScroll: true });
  });
}

// A one-button alert the person has to dismiss (unlike a toast, it doesn't fade).
export async function notify({ title, body, ok = 'OK' }) {
  await openDialog(`
    <h2>${esc(title)}</h2>
    <p>${esc(body)}</p>
    <div class="row"><button class="btn primary" value="ok">${esc(ok)}</button></div>`);
}

// A number box with − and + buttons, for use inside openDialog.
export function stepperHtml({ id, name, value, min = 1, max }) {
  return `<div class="stepper dlgstepper" role="group" aria-label="Quantity">
    <button type="button" data-step="-1" data-for="${id}" aria-label="One fewer">−</button>
    <input id="${id}" name="${name}" type="number" inputmode="numeric" min="${min}" max="${max}" step="1" required value="${value}">
    <button type="button" data-step="1" data-for="${id}" aria-label="One more">+</button>
  </div>`;
}

export async function ask({ title, body, ok = 'OK', cancel = 'Cancel', danger = false }) {
  const result = await openDialog(`
    <h2>${esc(title)}</h2>
    <p>${esc(body)}</p>
    <div class="row">
      <button class="btn" value="cancel" formnovalidate>${esc(cancel)}</button>
      <button class="btn ${danger ? 'danger' : 'primary'}" value="ok">${esc(ok)}</button>
    </div>`);
  return result === 'ok';
}
