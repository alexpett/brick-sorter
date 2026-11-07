// "Create order": turns what a set bin is still missing into a file for BrickLink or Rebrickable.
import * as db from './db.js';
import * as rb from './rebrickable.js';
import { $, esc, fmt, toast, openDialog } from './ui.js';

export const FORMATS = {
  bricklink: { label: 'BrickLink Wanted List', hint: 'XML for BrickLink’s Upload Wanted List page. Uses BrickLink part and colour numbers.', ext: 'xml', mime: 'application/xml' },
  rebrickable: { label: 'Rebrickable CSV', hint: 'Part, Color, Quantity. Import it as a Rebrickable parts list.', ext: 'csv', mime: 'text/csv' },
  csv: { label: 'Plain CSV', hint: 'A spreadsheet with part number, name, colour and quantity.', ext: 'csv', mime: 'text/csv' },
};

const xml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
const csvCell = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

// What to order: the missing lines, less anything already waiting in storage when asked.
export function orderItems(missing, { skipStorage }) {
  return missing
    .map((l) => ({ part_num: l.part_num, name: l.name, color_id: l.color_id, color_name: l.color_name, qty: skipStorage ? l.rem - (l.avail || 0) : l.rem }))
    .filter((l) => l.qty > 0);
}

// BrickLink numbers differ from Rebrickable's, so ask Rebrickable for its cross-reference for this set.
async function blIds(set, key) {
  const results = await rb.getSetParts(set.set_num, key);
  if (set.figs_at) { try { results.push(...await rb.getSetFigureParts(set.set_num, key)); } catch { /* the set's own parts are enough */ } }
  const parts = new Map(); const colours = new Map();
  for (const r of results) {
    const p = r.part || {}; const c = r.color || {};
    const bp = p.external_ids?.BrickLink?.[0]; if (bp) parts.set(String(p.part_num), String(bp));
    const bc = c.external_ids?.BrickLink?.ext_ids?.[0]; if (bc != null) colours.set(c.id, bc);
  }
  return { parts, colours };
}

export async function buildOrder(format, items, set, key) {
  const date = new Date().toISOString().slice(0, 10);
  if (format === 'rebrickable') {
    return { text: ['Part,Color,Quantity', ...items.map((i) => `${csvCell(i.part_num)},${i.color_id},${i.qty}`)].join('\n') + '\n', unmatched: 0 };
  }
  if (format === 'csv') {
    return { text: ['Set,Part,Name,Colour,Quantity', ...items.map((i) => [set.set_num, i.part_num, i.name, i.color_name, i.qty].map(csvCell).join(','))].join('\n') + '\n', unmatched: 0 };
  }
  let ids = { parts: new Map(), colours: new Map() };
  if (key) ids = await blIds(set, key);
  let unmatched = 0;
  const rows = items.map((i) => {
    const part = ids.parts.get(String(i.part_num)); const colour = ids.colours.get(i.color_id);
    if (!part || colour == null) unmatched++;
    return `  <ITEM>\n    <ITEMTYPE>P</ITEMTYPE>\n    <ITEMID>${xml(part || i.part_num)}</ITEMID>\n    <COLOR>${xml(colour ?? i.color_id)}</COLOR>\n    <MINQTY>${i.qty}</MINQTY>\n    <REMARKS>${xml(`${set.set_num} ${date}`)}</REMARKS>\n  </ITEM>`;
  });
  return { text: `<INVENTORY>\n${rows.join('\n')}\n</INVENTORY>\n`, unmatched };
}

export async function orderDialog({ set, missing }) {
  const key = (await db.getSetting('rebrickableKey')) || '';
  const hasStorage = missing.some((l) => (l.avail || 0) > 0);
  let format = (await db.getSetting('orderFormat')) || 'bricklink';
  if (!FORMATS[format]) format = 'bricklink';
  let skipStorage = hasStorage;
  let built = null;
  const d = $('#dlg');
  const ctl = new AbortController();
  const summary = () => {
    const items = orderItems(missing, { skipStorage });
    return { items, pieces: items.reduce((n, i) => n + i.qty, 0) };
  };
  const draw = () => {
    const s = summary();
    $('#ordFormats').innerHTML = Object.entries(FORMATS).map(([k, f]) => `
      <label class="check ordfmt"><input type="radio" name="fmt" value="${k}"${k === format ? ' checked' : ''}> <span><strong>${esc(f.label)}</strong><small>${esc(f.hint)}</small></span></label>`).join('');
    $('#ordSummary').textContent = s.items.length ? `${fmt(s.pieces)} pieces in ${fmt(s.items.length)} lines` : 'Nothing to order. Every missing piece is already in storage.';
    $('#ordGo').disabled = $('#ordCopy').disabled = !s.items.length;
    $('#ordNote').textContent = format === 'bricklink' && !key ? 'Add your Rebrickable key in Settings so BrickLink numbers can be looked up. Without it the file uses Rebrickable numbers, which don’t always match.' : '';
  };
  const make = async () => {
    const s = summary();
    const go = $('#ordGo'); const label = go.textContent; go.disabled = true; go.textContent = 'Preparing…';
    try { built = await buildOrder(format, s.items, set, key); } catch (e) { toast(e.message || 'Couldn’t prepare the order.'); return null; } finally { go.textContent = label; go.disabled = !s.items.length; }
    await db.setSetting('orderFormat', format);
    if (built.unmatched) $('#ordNote').textContent = `${fmt(built.unmatched)} ${built.unmatched === 1 ? 'line' : 'lines'} had no BrickLink number and use the Rebrickable one. Check ${built.unmatched === 1 ? 'it' : 'them'} after uploading.`;
    return built;
  };
  const p = openDialog(`
    <h2>Create order</h2>
    <p class="hint">Make a list of what ${esc(set.name || 'this set')} is still missing, ready to upload to a BrickLink wanted list.</p>
    <div id="ordFormats" role="radiogroup" aria-label="File type"></div>
    ${hasStorage ? '<label class="check"><input type="checkbox" id="ordSkip" checked> Leave out pieces already in storage</label>' : ''}
    <p id="ordSummary" class="hint" role="status"></p>
    <p id="ordNote" class="hint" role="status"></p>
    <div class="row">
      <button type="button" class="btn primary" id="ordGo">Download file</button>
      <button type="button" class="btn" id="ordCopy">Copy</button>
      <span class="grow"></span>
      <button class="btn" value="close" formnovalidate>Close</button>
    </div>`);
  draw();
  d.addEventListener('change', (e) => {
    if (e.target.name === 'fmt') { format = e.target.value; draw(); }
    if (e.target.id === 'ordSkip') { skipStorage = e.target.checked; draw(); }
  }, { signal: ctl.signal });
  d.addEventListener('click', async (e) => {
    if (e.target.closest('#ordGo')) {
      const r = await make(); if (!r) return;
      const f = FORMATS[format];
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([r.text], { type: f.mime }));
      a.download = `order-${set.set_num}-${format}.${f.ext}`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      toast('File saved.');
    } else if (e.target.closest('#ordCopy')) {
      const r = await make(); if (!r) return;
      try { await navigator.clipboard.writeText(r.text); toast('Copied.'); } catch { toast('Couldn’t copy. Use Download file instead.'); }
    }
  }, { signal: ctl.signal });
  await p;
  ctl.abort();
}
