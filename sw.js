/* Walk in Light service worker: offline-first app shell. Bump CACHE on every release. */
const CACHE = 'wil-v3';
const SHELL = ['./', './index.html', './css/app.css', './js/seed.js', './js/app.js', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png', './icons/favicon-32.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const req = e.request; if (req.method !== 'GET') return;
  const sameOrigin = new URL(req.url).origin === location.origin;
  if (sameOrigin) {
    // network first for the app shell so updates arrive, cache fallback offline
    e.respondWith(fetch(req).then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); return res; }).catch(() => caches.match(req).then((r) => r || caches.match('./index.html'))));
  } else if (/fonts\.(googleapis|gstatic)\.com/.test(req.url)) {
    // fonts: cache first
    e.respondWith(caches.match(req).then((r) => r || fetch(req).then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); return res; }).catch(() => new Response('', { status: 503 }))));
  }
  // anything else (the GitHub API for sync) goes straight to the network
});
