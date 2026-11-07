// The Swatch: a picture of the user’s physical colour plate (8 x 8 studs of 1 x 1 plates). Each square is a
// colour id or null (an empty place on the plate). The layout is editable in Settings and synced.
import * as db from './db.js';
import * as refdata from './data.js';
import { esc } from './ui.js';

export const SIZE = 8;

// Rows left to right, top to bottom, as on the first plate: greys, browns, warm colours, pinks and purples,
// greens, blues, then transparent. Empty places are null.
export const DEFAULT_SWATCH = [
  15, 503, 151, 71, 7, 72, 8, 0,
  78, 19, 28, 84, 70, 6, 308, null,
  226, 14, 191, 25, 484, 4, 320, null,
  29, 1050, 5, 26, 31, 30, 85, null,
  158, 27, 10, 2, 288, 326, 378, 323,
  212, 379, 73, 321, 322, 1, 3, 272,
  47, 41, 36, 182, 46, 33, null, null,
  null, null, null, null, null, null, null, null,
];

export async function getSwatch() {
  const s = await db.getSetting('swatch');
  if (Array.isArray(s) && s.length === SIZE * SIZE) return s.map((x) => (x === null || x === undefined ? null : Number(x)));
  return DEFAULT_SWATCH.slice();
}

export const setSwatch = (cells) => db.setSetting('swatch', cells);

export async function swatchOpensFirst() {
  return (await db.getSetting('swatchDefault')) === true;
}

// The grid as buttons (interactive) with a stud on each square, like a plate seen from above.
//  attr     - the data attribute that carries the colour id (or the cell number when editing)
//  current  - colour id to outline
//  byCell   - give each button its position instead of its colour (the editor)
export function swatchGrid(cells, { current = null, byCell = false } = {}) {
  return `<div class="swgrid" role="group" aria-label="Colour swatch">${cells.map((id, i) => {
    const c = id === null ? null : refdata.ref.colorById.get(id);
    if (!c) {
      return byCell
        ? `<button type="submit" class="swcell empty" name="cell" value="${i}" aria-label="Empty square, tap to set a colour" formnovalidate><span class="swstud"></span></button>`
        : '<span class="swcell empty" aria-hidden="true"><span class="swstud"></span></span>';
    }
    const pressed = current === c.id;
    return byCell
      ? `<button type="submit" class="swcell${c.is_trans ? ' trans' : ''}" name="cell" value="${i}" style="--c:#${esc(c.rgb)}" aria-label="${esc(c.name)}" formnovalidate><span class="swstud"></span></button>`
      : `<button type="button" class="swcell${c.is_trans ? ' trans' : ''}" data-swcolor="${c.id}" style="--c:#${esc(c.rgb)}" aria-label="${esc(c.name)}" aria-pressed="${pressed}"><span class="swstud"></span></button>`;
  }).join('')}</div>`;
}
