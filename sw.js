const CACHE_NAME = 'word-recall-pwa-v3';
const ASSETS = ['./','./index.html','./styles.css','./app.js','./manifest.webmanifest','./icon-180.png','./icon-512.png'];
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request).then(response => {
    const cloned = response.clone();
    caches.open(CACHE_NAME).then(cache => cache.put(event.request, cloned));
    return response;
  }).catch(() => caches.match('./index.html'))));
});
