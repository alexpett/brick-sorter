// Bundled reference data (parts, colours, categories) built from Rebrickable’s downloads.
let loading = null;

export const ref = {
  loaded: false,
  parts: [], // [part_num, name, category id]
  lower: [], // lower-case "part_num name" for searching
  byNum: new Map(), // lower-case part_num -> index in parts
  colors: [], // { id, name, rgb, is_trans }
  colorById: new Map(),
  categories: new Map(), // id -> name
};

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Couldn’t load ${url} (${res.status}).`);
  return res.json();
}

export function loadRef() {
  loading ??= (async () => {
    const [parts, colors, cats] = await Promise.all([
      getJson('data/parts.json'),
      getJson('data/colors.json'),
      getJson('data/categories.json'),
    ]);
    ref.parts = parts;
    ref.lower = parts.map((p) => `${p[0]} ${p[1]}`.toLowerCase());
    ref.byNum = new Map(parts.map((p, i) => [p[0].toLowerCase(), i]));
    ref.colors = colors.map((c) => ({
      id: c[0],
      name: c[1],
      rgb: /^[0-9a-f]{6}$/i.test(c[2]) ? c[2] : '999999',
      is_trans: !!c[3],
      popularity: Number(c[4]) || 0,
    }));
    ref.colorById = new Map(ref.colors.map((c) => [c.id, c]));
    ref.categories = new Map(Object.entries(cats).map(([k, v]) => [Number(k), v]));
    ref.loaded = true;
  })().catch((e) => { loading = null; throw e; });
  return loading;
}

const asPart = (i) => ({ part_num: ref.parts[i][0], name: ref.parts[i][1], cat_id: ref.parts[i][2] });

// Part number first, then parts from your own sets, then everything else.
export function searchParts(query, yours = new Set(), limit = 40) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const terms = q.split(/\s+/);
  const exact = ref.byNum.get(q);
  const hits = [];
  for (let i = 0; i < ref.parts.length; i++) {
    if (i === exact) continue;
    const hay = ref.lower[i];
    let ok = true;
    for (const t of terms) if (!hay.includes(t)) { ok = false; break; }
    if (!ok) continue;
    const pn = ref.parts[i][0].toLowerCase();
    const rank = pn.startsWith(q) ? 1 : yours.has(ref.parts[i][0]) ? 2 : 3;
    hits.push([rank, ref.parts[i][1].length, i]);
    if (hits.length >= 4000) break;
  }
  hits.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out = hits.slice(0, limit).map((h) => asPart(h[2]));
  return exact !== undefined ? [asPart(exact), ...out.slice(0, limit - 1)] : out;
}

export function categoryName(id) {
  return ref.categories.get(id) || (id == null ? 'Other' : `Category ${id}`);
}

// Colours offered in the picker: everything except Rebrickable’s placeholder entries.
export function pickerColors() {
  return ref.colors
    .filter((c) => c.id !== -1 && c.id !== 9999)
    .sort((a, b) => Number(a.is_trans) - Number(b.is_trans) || a.name.localeCompare(b.name));
}

// Window frames that are normally sold with glass, and the part number of that glass.
const GLASS_FOR = { 60592: '60601', 60593: '60602', 60594: '60603', 3853: '3855' };
export const CLEAR_GLASS = 47; // Trans-Clear
export function glassFor(partNum) {
  const g = GLASS_FOR[String(partNum)];
  const i = g === undefined ? undefined : ref.byNum.get(g);
  return i === undefined ? null : { part_num: ref.parts[i][0], name: ref.parts[i][1], cat_id: ref.parts[i][2] };
}

// The scanner returns BrickLink numbers, which are not always Rebrickable’s. Best local guess:
// drop the print suffix (87079pb0722L -> 87079), drop an assembly suffix (60592c01 -> 60592, a window with its
// glass already fitted), and try the usual letter variants (3069 -> 3069b).
export function guessCatalogue(id) {
  const lower = String(id).toLowerCase();
  const unassembled = lower.replace(/c\d+(pb\d+|pr\d+)?[a-z]*$/, '');
  const base = unassembled.replace(/pb\d+[a-z]*$/, '').replace(/(pr|pat)\d+[a-z]*$/, '');
  const tries = [...new Set([base, `${base}b`, `${base}a`, `${base}c`])].filter((x) => x !== lower);
  for (const t of tries) {
    const i = ref.byNum.get(t);
    if (i !== undefined) return { part_num: ref.parts[i][0], name: ref.parts[i][1], cat_id: ref.parts[i][2], approx: true, assembly: unassembled !== lower };
  }
  return null;
}

// Groups shown in the picker’s "All" tab, in this order.
export const COLOR_GROUPS = ['Black & white', 'Greys', 'Reds', 'Oranges & yellows', 'Greens', 'Blues', 'Pinks & purples', 'Browns', 'Metallic', 'Translucent'];

export function colorGroup(c) {
  const n = c.name.toLowerCase();
  if (c.is_trans) return 'Translucent';
  if (/gr[ae]y/.test(n)) return 'Greys';
  if (/metallic|chrome|pearl|glitter|speckle|copper|silver|gold|bronze/.test(n)) return 'Metallic';
  if (/(^|\s)(black|white)$/.test(n)) return 'Black & white';
  if (/brown|\btan\b|nougat|flesh|dark orange/.test(n)) return 'Browns';
  if (/pink|magenta|purple|lavender|lilac/.test(n)) return 'Pinks & purples';
  const r = parseInt(c.rgb.slice(0, 2), 16) / 255, g = parseInt(c.rgb.slice(2, 4), 16) / 255, b = parseInt(c.rgb.slice(4, 6), 16) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  if (d < 0.08) return mx < 0.2 || mx > 0.92 ? 'Black & white' : 'Greys';
  let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  if (h < 15 || h >= 345) return 'Reds';
  if (h < 70) return 'Oranges & yellows';
  if (h < 165) return 'Greens';
  if (h < 255) return 'Blues';
  return 'Pinks & purples';
}

// Picture for a part. Parts from your sets use the picture Rebrickable gave us;
// anything else is a best-effort guess and is hidden if it fails to load.
export function partImg(partNum, colorId, known) {
  if (known) return known;
  if (!partNum) return null;
  return `https://cdn.rebrickable.com/media/parts/ldraw/${colorId ?? 15}/${encodeURIComponent(partNum)}.png`;
}
