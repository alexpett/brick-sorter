// Set pictures. A set with no picture gets a brick drawn in the set's main colour.
import * as db from './db.js';
import { esc } from './ui.js';
import { dominantColour } from './screens/sorter.js';

export const BRICK_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="3" y="9" width="18" height="10" rx="1.5"/><circle cx="8" cy="6.5" r="2"/><circle cx="16" cy="6.5" r="2"/></svg>';
const cache = new Map();

export async function placeholderColour(setNum) {
  if (cache.has(setNum)) return cache.get(setNum);
  const lines = await db.byIndex('setParts', 'set_num', setNum);
  const by = new Map();
  for (const l of lines) {
    const g = by.get(l.color_id) || { id: l.color_id, name: l.color_name, rgb: l.rgb, n: 0 };
    g.n += l.qty; by.set(l.color_id, g);
  }
  const c = by.size ? dominantColour([...by.values()]).bg : '#8a8580';
  cache.set(setNum, c);
  return c;
}

// The inside of a picture box: the image, or the placeholder brick (the box also needs class "nopic" and --c).
export async function setPicture(set, cls = 'setimg') {
  if (set.img) return `<div class="${cls}"><img src="${esc(set.img)}" alt="" loading="lazy"></div>`;
  return `<div class="${cls} nopic" style="--c:${await placeholderColour(set.set_num)}">${BRICK_ICON}</div>`;
}
