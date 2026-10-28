// The Delivery Photos Service Worker: keeps a local copy of the tool itself
// (its "app shell" - page, scripts, styles, the Data Matrix / QR Code
// decoder and its WebAssembly, icons) on the iPad, so the tool still opens,
// scans and takes photographs with no connection to the Windows PC at all.
//
// It NEVER handles photographs or the Photo Service API: every /api/ request
// goes straight to the network exactly as before, so uploads, pairing and
// session-complete reports behave the same as without this file, and nothing
// here ever stores a photograph (the offline queue lives in IndexedDB - see
// offline-queue.js).
//
// The two placeholders below are filled in by the Windows app when it serves
// this file (see src/delivery-photos/web-shell.js): the list of shell files
// and a version stamp computed from their contents. A new Windows build with
// any changed file therefore changes this script, the browser installs the
// new version (fetching a complete fresh copy of every file), and only then
// is the old copy removed - so the iPad never runs a mix of old and new files.
'use strict';

const VERSION = '__SHELL_VERSION__';
const SHELL_FILES = '__SHELL_FILES__';
const CACHE_PREFIX = 'delivery-photos-shell-';
const CACHE_NAME = CACHE_PREFIX + VERSION;

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      // cache: 'reload' - always the server's current file, never a stale
      // copy from the browser's ordinary HTTP cache.
      await cache.addAll(SHELL_FILES.map((url) => new Request(url, { cache: 'reload' })));
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME) await caches.delete(name);
      }
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/sw.js') return; // always the real network

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = (await cache.match(request, { ignoreSearch: true })) || (request.mode === 'navigate' ? await cache.match('/') : undefined);
      return cached || fetch(request);
    })()
  );
});
