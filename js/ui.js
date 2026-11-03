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
    d.onclose = () => {
      const value = d.returnValue;
      resolve(data ? { value, data: new FormData(d.querySelector('form')) } : value);
    };
    d.showModal();
    // Don't pop the keyboard up: move focus off the first input to the dialog itself.
    d.setAttribute('tabindex', '-1');
    d.focus({ preventScroll: true });
  });
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
