// Caches the app shell so Brick Sorter opens offline. Rebrickable calls are never cached here.
const CACHE = 'brick-sorter-v81';
const SHELL = [
  './',
  'index.html',
  'css/style.css',
  'js/app.js',
  'js/db.js',
  'js/rebrickable.js',
  'js/ui.js',
  'js/sync.js',
  'js/data.js',
  'js/bins.js',
  'js/swatch.js',
  'js/order.js',
  'js/setpic.js',
  'js/themes.js',
  'js/screens/scan.js',
  'js/screens/sorter.js',
  'js/screens/home.js',
  'js/rewards.js',
  'js/recog.js',
  'js/screens/bins.js',
  'data/colors.json',
  'data/categories.json',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Network first for our own files, so an update is picked up on the next open and the
// app's files never come from two different versions. The cache is only the offline fallback.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  event.respondWith(
    fetch(event.request, { cache: 'no-cache' }) // always check with the server, never the browser's own copy
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(event.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(event.request).then((hit) => hit || caches.match('index.html'))),
  );
});
