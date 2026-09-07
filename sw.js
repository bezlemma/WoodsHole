/* Woods Hole conditions — service worker.
   Baked geometry (geo/flow/wind/tide rasters, chart tiles, versioned app
   assets) is cache-first: it never changes under a given URL. Everything
   live (NOAA, Open-Meteo, data JSONs with time-bucketed URLs) is
   network-first with cache fallback, so the page still opens on the water
   with the last-seen conditions when signal drops. */
const V = 'wh-v207';
const PRECACHE = [
  './',
  'index.html',
  'about.html',
  'style.css?v=106',
  'app.js?v=195',
  'vendor/leaflet.js',
  'vendor/leaflet.css',
  'manifest.webmanifest',
  'icon-192.png',
  'icon-512.png',
];

self.addEventListener('install', (e) => {
  // addAll is atomic: if it fails, let install FAIL, so the previous
  // worker and its complete cache keep serving (a swallowed failure here
  // used to skipWaiting into an empty cache and delete the old one)
  e.waitUntil(
    caches.open(V).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

// live-data cache survives app-version bumps: yesterday's forecast is
// still the best thing to show in a dead spot mid-Sound
const API = 'wh-api';

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== V && k !== API).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function cacheFirst(req) {
  return caches.match(req).then((hit) => hit || fetch(req).then((res) => {
    if (res && res.ok) {
      const copy = res.clone();
      caches.open(V).then((c) => c.put(req, copy));
    }
    return res;
  }));
}

function networkFirst(req) {
  return fetch(req).then((res) => {
    if (res && res.ok) {
      const copy = res.clone();
      caches.open(API).then((c) => c.put(req, copy));
    }
    return res;
  }).catch(() => caches.match(req).then((hit) => {
    if (hit) return hit;
    // time-bucketed URLs (necofs.json?b=NN) change their query every few
    // hours — offline, the previous bucket is still the freshest we have.
    // ONLY there: on shared-path APIs (CO-OPS datagetter) ignoreSearch
    // would hand back a different product/station as if it were this one
    if (url_endswith(req.url, '/data/necofs.json')) {
      return caches.match(req, { ignoreSearch: true }).then((h2) => {
        if (h2) return h2;
        throw new Error('offline, no cache');
      });
    }
    throw new Error('offline, no cache');
  }));
}

function url_endswith(u, tail) {
  try { return new URL(u).pathname.endsWith(tail); } catch (e) { return false; }
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  // the app's explicit cache-bypass retries (fetch(..., {cache:'reload'}))
  // must reach the network AND refresh our copy, not loop back into it
  if (req.cache === 'reload' || req.cache === 'no-cache' || req.cache === 'no-store') {
    e.respondWith(fetch(req).then((res) => {
      if (res && res.ok && req.cache !== 'no-store') {
        const copy = res.clone();
        caches.open(V).then((c) => c.put(req, copy));
      }
      return res;
    }));
    return;
  }
  const url = new URL(req.url);
  if (url.origin === location.origin) {
    // immutable under their URLs: chart tiles, versioned rasters/scripts, vendor
    const immutable = url.pathname.includes('/data/chart/')
      || /\/vendor\//.test(url.pathname)
      || /\.png$/.test(url.pathname)
      || (url.search.includes('v=') && /\.(js|css|json)$/.test(url.pathname));
    e.respondWith(immutable ? cacheFirst(req) : networkFirst(req));
  } else {
    e.respondWith(networkFirst(req));
  }
});
