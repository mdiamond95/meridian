/* Meridian's service worker (plan Phase 7 §2). The build prepends two constants:
 *   VERSION  — a hash of the precache list, so each build gets its own cache;
 *   PRECACHE — every file the build emitted (the page, scripts, styles, data artefacts, packs),
 *              relative to this worker.
 * The page, its code and every artefact are cached on install, so after one visit the app and a
 * saved pack open with the network off. Basemap tiles are cached as they load, and the page tells the
 * worker which tiles its last view showed; the rest are dropped, so the tile cache holds the last
 * viewed extent and nothing more. Written as plain JavaScript: it is copied, not bundled.
 */
const APP_CACHE = `meridian-app-${VERSION}`;
const TILE_CACHE = 'meridian-tiles';
const scopeUrl = (path) => new URL(path, self.registration.scope).href;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(APP_CACHE)
      .then((cache) => cache.addAll(PRECACHE.map(scopeUrl)))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k.startsWith('meridian-app-') && k !== APP_CACHE).map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

// The page reports the tiles of its last settled view; everything else in the tile cache goes.
self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || data.type !== 'tiles' || !Array.isArray(data.urls)) return;
  const keep = new Set(data.urls);
  event.waitUntil(
    caches.open(TILE_CACHE).then(async (cache) => {
      for (const request of await cache.keys()) if (!keep.has(request.url)) await cache.delete(request);
    }),
  );
});

const isTile = (url) =>
  /\/\d+\/\d+\/\d+(@2x)?\.png$/.test(url.pathname) && url.origin !== self.location.origin;

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  // Pages: the network first, so a new deploy is picked up; the cached page when offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(
        async () => (await caches.match(scopeUrl('./index.html'), { ignoreVary: true })) ?? Response.error(),
      ),
    );
    return;
  }

  // Basemap tiles: the network first, and keep what arrives; the cached tile when offline.
  if (isTile(url)) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            event.waitUntil(caches.open(TILE_CACHE).then((cache) => cache.put(request, copy)));
          }
          return response;
        })
        .catch(async () => (await caches.match(request, { cacheName: TILE_CACHE })) ?? Response.error()),
    );
    return;
  }

  // Build artefacts are fingerprinted (or versioned, for packs), so the cached copy is the right one.
  // ignoreVary: a server that varies on Accept-Encoding or Origin would otherwise make a script's
  // request miss the copy the install step fetched with other headers.
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches
        .match(request, { cacheName: APP_CACHE, ignoreSearch: true, ignoreVary: true })
        .then((hit) => hit ?? fetch(request)),
    );
  }
});
