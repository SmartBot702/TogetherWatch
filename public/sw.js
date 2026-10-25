const CACHE = 'togetherwatch-shell-v1';
const SHELL = ['/', '/manifest.webmanifest', '/icon.svg', '/app.js', '/i18n.js'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io/') || url.pathname === '/health') return;
  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).then(response => {
      if (response.ok) caches.open(CACHE).then(cache => cache.put('/', response.clone()));
      return response;
    }).catch(async () => (await caches.match(req)) || (await caches.match('/'))));
    return;
  }
  event.respondWith(caches.match(req).then(cached => {
    const fresh = fetch(req).then(response => {
      if (response.ok && (url.pathname === '/app.js' || url.pathname === '/i18n.js' || url.pathname === '/icon.svg' || url.pathname === '/manifest.webmanifest')) {
        const copy = response.clone();
        caches.open(CACHE).then(cache => cache.put(req, copy));
      }
      return response;
    }).catch(() => cached);
    return cached || fresh;
  }));
});
