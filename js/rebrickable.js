// Rebrickable API v3 client. The key is passed as a query parameter so the browser
// treats each call as a simple request (no CORS preflight).
const BASE = 'https://rebrickable.com/api/v3/lego';
const MIN_GAP_MS = 1000; // Rebrickable asks for about one request per second.

export class ApiError extends Error {
  constructor(message, status, kind) {
    super(message);
    this.status = status;
    this.kind = kind;
  }
}

let nextSlot = 0;
let throttleHook = null;

export function setThrottleHook(fn) {
  throttleHook = fn;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function takeSlot() {
  const now = Date.now();
  const wait = Math.max(0, nextSlot - now);
  nextSlot = Math.max(now, nextSlot) + MIN_GAP_MS;
  if (wait) await sleep(wait);
}

async function throttleSeconds(res) {
  const header = Number(res.headers.get('Retry-After'));
  if (header > 0) return header;
  try {
    const body = await res.json();
    const m = /(\d+)\s*second/i.exec(body?.detail || '');
    if (m) return Number(m[1]);
  } catch { /* ignore */ }
  return 10;
}

async function call(path, params, key) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);
  url.searchParams.set('key', key);

  for (let attempt = 0; attempt < 4; attempt++) {
    await takeSlot();
    let res;
    try {
      res = await fetch(url, { headers: { Accept: 'application/json' } });
    } catch {
      throw new ApiError("Couldn't reach Rebrickable. Check your connection and try again.", 0, 'network');
    }
    if (res.status === 429) {
      const secs = Math.min(60, await throttleSeconds(res));
      if (attempt === 3) throw new ApiError('Rebrickable is rate limiting requests. Wait a minute and try again.', 429, 'throttle');
      if (throttleHook) throttleHook(secs);
      await sleep(secs * 1000);
      continue;
    }
    if (res.status === 401 || res.status === 403) {
      throw new ApiError('Rebrickable rejected the API key. Check it in Settings.', res.status, 'key');
    }
    if (res.status === 404) throw new ApiError('Not found on Rebrickable.', 404, 'notfound');
    if (!res.ok) throw new ApiError(`Rebrickable returned an error (${res.status}).`, res.status, 'http');
    return res.json();
  }
  throw new ApiError('Rebrickable request failed.', 0, 'http');
}

// Follows page=1,2,3... until there is no "next" page.
async function allPages(path, params, key, onPage) {
  const results = [];
  for (let page = 1; page < 50; page++) {
    const data = await call(path, { ...params, page }, key);
    results.push(...(data.results || []));
    if (onPage) onPage(results.length, data.count);
    if (!data.next) break;
  }
  return results;
}

export function testKey(key) {
  return call('/colors/', { page_size: 1 }, key);
}

export function getSet(setNum, key) {
  return call(`/sets/${encodeURIComponent(setNum)}/`, {}, key);
}

export async function searchSets(query, key) {
  const data = await call('/sets/', { search: query, page_size: 50 }, key);
  return data.results || [];
}

export function getSetParts(setNum, key, onPage) {
  return allPages(
    `/sets/${encodeURIComponent(setNum)}/parts/`,
    { page_size: 1000, inc_part_details: 1 },
    key,
    onPage,
  );
}

// Rebrickable part(s) that BrickLink knows by this number (the scanner returns BrickLink numbers).
export async function findByBricklink(id, key) {
  const data = await call('/parts/', { bricklink_id: id, page_size: 5 }, key);
  return data.results || [];
}

export function getCategories(key) {
  return allPages('/part_categories/', { page_size: 1000 }, key);
}
