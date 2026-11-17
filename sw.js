/*
 * LocalGram service worker.
 * Pre-caches every asset on install and serves them cache-first, so the app
 * works fully offline after the first visit.
 *
 * To ship an update: change files, then bump CACHE_VERSION. Browsers fetch
 * sw.js on each visit; a changed byte installs the new worker, which caches
 * the new files and deletes the old cache on activation.
 */
const CACHE_VERSION = 'v1';
const CACHE_NAME = `localgram-${CACHE_VERSION}`;

// Relative URLs resolve against this file's location, so the app works
// from a sub-folder such as https://user.github.io/localgram/.
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './game.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      // cache: 'reload' bypasses the HTTP cache so we store fresh copies.
      .then((cache) => cache.addAll(ASSETS.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k.startsWith('localgram-') && k !== CACHE_NAME).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    try {
      const response = await fetch(request);
      if (response.ok) cache.put(request, response.clone());
      return response;
    } catch (err) {
      // Offline and not cached: fall back to the app shell for page loads.
      if (request.mode === 'navigate') return cache.match('./index.html');
      throw err;
    }
  })());
});
