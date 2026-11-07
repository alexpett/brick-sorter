// Set themes (Harry Potter, LEGO Friends, ...). Rebrickable sends a theme number with every set and the list of
// theme names once; nothing here needs the person to type anything. A set shows under its top-level theme.
import * as db from './db.js';
import * as rb from './rebrickable.js';

let cache = null; // Map id -> { name, parent }

export async function loadThemes({ fetchIfMissing = true } = {}) {
  if (cache) return cache;
  let list = await db.getSetting('themes');
  if (!Array.isArray(list) || !list.length) {
    const key = await db.getSetting('rebrickableKey');
    if (!fetchIfMissing || !key) return null;
    try {
      list = (await rb.getThemes(key)).map((t) => ({ id: t.id, name: t.name, parent: t.parent_id ?? null }));
      if (list.length) await db.setSetting('themes', list);
    } catch { return null; }
  }
  cache = new Map((list || []).map((t) => [t.id, t]));
  return cache.size ? cache : null;
}

// The top-level theme name for a theme number ("Hogwarts Moments" -> "Harry Potter"); null when unknown.
export function rootTheme(themes, id) {
  let t = themes?.get(id);
  for (let i = 0; t && t.parent != null && themes.has(t.parent) && i < 10; i++) t = themes.get(t.parent);
  return t ? t.name : null;
}

// Older sets were saved before themes were kept: fetch the number for each, quietly, once.
let backfilling = false;
export async function backfillThemeIds(onChange) {
  if (backfilling) return;
  const key = await db.getSetting('rebrickableKey');
  if (!key) return;
  backfilling = true;
  try {
    for (const s of (await db.all('sets')).filter((x) => !x.deleted && x.theme_id == null && !x.theme_checked)) {
      let info = null;
      try { info = await rb.getSet(s.set_num, key); } catch { break; }
      await db.put('sets', { ...s, theme_id: info?.theme_id ?? null, theme_checked: true, updated: new Date().toISOString() });
      onChange?.();
    }
  } finally { backfilling = false; }
}
