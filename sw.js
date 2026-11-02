// MADZO service worker — installable app + works offline.
// Pages and scripts are saved on the device (always fetched fresh first when online);
// data is handled separately by offline-sync.js (saved copy + queued changes).
const SHELL = 'madzo-shell-v2';
const RUNTIME = 'madzo-rt-v2';
const OFFLINE = 'offline.html';
const PRECACHE = [OFFLINE, 'index.html', 'admin.html', 'accounts.html', 'support.js', 'image-slot.js',
  'supabase-config.js', 'offline-sync.js', 'manifest.webmanifest', 'admin.webmanifest', 'icon-192.png', 'icon-512.png'];
const LIB_HOSTS = ['cdn.jsdelivr.net', 'cdnjs.cloudflare.com', 'unpkg.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => Promise.all(PRECACHE.map((u) => c.add(u).catch(() => {})))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== SHELL && k !== RUNTIME).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

function networkFirst(r, cacheName) {
  return fetch(r).then((res) => {
    if (res && res.ok) { const copy = res.clone(); caches.open(cacheName).then((c) => c.put(r, copy)); }
    return res;
  });
}
function staleWhileRevalidate(r) {
  return caches.open(RUNTIME).then((c) => c.match(r).then((hit) => {
    const net = fetch(r).then((res) => { if (res && (res.ok || res.type === 'opaque')) c.put(r, res.clone()); return res; }).catch(() => hit);
    return hit || net;
  }));
}

self.addEventListener('fetch', (e) => {
  const r = e.request;
  if (r.method !== 'GET') return;
  const u = new URL(r.url);

  if (r.mode === 'navigate') {
    e.respondWith(networkFirst(r, SHELL).catch(() => caches.match(r, { ignoreSearch: true }).then((hit) => hit || caches.match(OFFLINE))));
    return;
  }
  if (u.origin === location.origin) {
    // own scripts / styles / images: newest when online, saved copy when not
    e.respondWith(networkFirst(r, SHELL).catch(() => caches.match(r, { ignoreSearch: true }).then((hit) => hit || Response.error())));
    return;
  }
  // libraries, fonts, and product pictures stored in Supabase
  if (LIB_HOSTS.indexOf(u.hostname) > -1 || (/\.supabase\.co$/.test(u.hostname) && u.pathname.indexOf('/storage/v1/object/') === 0)) {
    e.respondWith(staleWhileRevalidate(r));
  }
});
