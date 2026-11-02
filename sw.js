// MADZO service worker — makes the site installable and shows a friendly screen when offline.
// Data always comes live from the server, so nothing here can show stale products or orders.
const CACHE = 'madzo-shell-v1';
const OFFLINE = 'offline.html';
const ASSETS = [OFFLINE, 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const r = e.request;
  // Only page loads are handled: online → the normal live page; offline → the offline screen.
  if (r.mode === 'navigate') {
    e.respondWith(fetch(r).catch(() => caches.match(OFFLINE)));
  }
});
