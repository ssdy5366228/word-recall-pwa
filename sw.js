const CACHE_NAME = 'word-recall-pwa-6.0.0-beta.4.8';
const AUDIO_CACHE_PREFIX = 'word-recall-pronunciation-';
const ASSETS = [
  './',
  './index.html',
  './index.html?v=6.0.0-beta.4.8',
  './styles.css?v=6.0.0-beta.4.8',
  './app.js?v=6.0.0-beta.4.8',
  './manifest.webmanifest?v=6.0.0-beta.4.8',
  './icon-180.png?v=6.0.0-beta.4.8',
  './icon-512.png?v=6.0.0-beta.4.8'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME && !key.startsWith(AUDIO_CACHE_PREFIX)).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);

  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          const cloned = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put('./index.html', cloned));
          return response;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  if (url.origin === self.location.origin && url.pathname.includes('/audio/')) {
    // Pronunciation files may be added to GitHub Pages after the app release.
    // Use network-first, cache only successful responses, and fall back to a
    // previously cached MP3 when offline. Never persist 404 responses.
    event.respondWith(
      caches.match(event.request).then(cached =>
        fetch(event.request)
          .then(response => {
            if (response.ok) {
              const cloned = response.clone();
              caches.open(CACHE_NAME).then(cache => cache.put(event.request, cloned));
            }
            return response.ok ? response : (cached || response);
          })
          .catch(() => cached || Response.error())
      )
    );
    return;
  }

  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(event.request).then(cached => {
        const networkFetch = fetch(event.request)
          .then(response => {
            const cloned = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, cloned));
            return response;
          })
          .catch(() => cached);
        return cached || networkFetch;
      })
    );
  }
});
