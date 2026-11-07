// Part recognition through Brickognize. One photo in, a short ranked list of likely parts out.
// Kept separate from the camera screen so the service can be swapped without touching it.
import * as db from './db.js';
import * as sync from './sync.js';

const ENDPOINT = 'https://api.brickognize.com/predict/parts/';

export async function hasConsent() { return !!(await db.getSetting('recogConsent')); }
export async function giveConsent() { await db.setSetting('recogConsent', true); }

// Shrinks a photo so it uploads quickly. Returns { blob, canvas }.
// `crop` ({x, y, w, h} in source pixels) keeps only that part of the picture.
export async function prepare(source, max = 1024, crop = null) {
  const bmp = source instanceof Blob ? await createImageBitmap(source) : source;
  const fullW = bmp.videoWidth || bmp.width;
  const fullH = bmp.videoHeight || bmp.height;
  const r = crop || { x: 0, y: 0, w: fullW, h: fullH };
  const k = Math.min(1, max / Math.max(r.w, r.h));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(r.w * k));
  c.height = Math.max(1, Math.round(r.h * k));
  c.getContext('2d').drawImage(bmp, r.x, r.y, r.w, r.h, 0, 0, c.width, c.height);
  const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.85));
  if (!blob) throw new Error("Couldn’t prepare the photo.");
  return { blob, canvas: c };
}

const toBase64 = (blob) => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(String(r.result).split(',')[1] || '');
  r.onerror = () => rej(new Error("Couldn’t read the photo."));
  r.readAsDataURL(blob);
});

function normalise(json) {
  const items = (json?.items || []).filter((i) => i && i.id).map((i) => ({
    id: String(i.id),
    name: i.name || '',
    img: i.img_url || '',
    score: typeof i.score === 'number' ? i.score : null,
    category: i.category || '',
    type: i.type || 'part',
  }));
  return items;
}

// Tries Brickognize directly from the browser; if the browser blocks that (or it fails to connect)
// and the Google script is set up, sends it that way instead.
export async function identify(blob) {
  let direct = null;
  try {
    const form = new FormData();
    form.append('query_image', blob, 'photo.jpg');
    const res = await fetch(ENDPOINT, { method: 'POST', body: form });
    if (!res.ok) throw Object.assign(new Error(`Brickognize answered with status ${res.status}.`), { http: true });
    return { items: normalise(await res.json()), via: 'direct' };
  } catch (e) {
    if (e.http) throw e;
    direct = e;
  }
  if (await sync.isConfigured()) {
    try {
      const r = await sync.callScript({ action: 'recognise', image: await toBase64(blob) });
      return { items: normalise(r.result), via: 'script' };
    } catch (e) {
      throw new Error(`Couldn’t identify the photo (${e.message}). If you set up the Google script before the camera was added, update it from the apps-script folder and redeploy.`);
    }
  }
  void direct;
  throw new Error("Couldn’t reach Brickognize from the browser. Setting up Google Sheet backup in Settings lets the app send the photo through your Google script instead.");
}

// The part of a playing <video> that is actually visible inside its box when it is shown with
// object-fit: cover (the rest is cut off), in the video’s own pixels.
export function visibleCrop(video) {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const bw = video.clientWidth;
  const bh = video.clientHeight;
  if (!vw || !vh || !bw || !bh) return null;
  const scale = Math.max(bw / vw, bh / vh);
  const w = Math.min(vw, bw / scale);
  const h = Math.min(vh, bh / scale);
  return { x: (vw - w) / 2, y: (vh - h) / 2, w, h };
}
