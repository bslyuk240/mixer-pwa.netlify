// sw.js — Virtual Mixer Trainer
// Cache version: bump this when you deploy new assets
const CACHE = "mixer-v2";

// Static assets you want available offline.
// These paths assume all files are in the site root on Netlify.
const ASSETS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-512-maskable.png",
  "./apple-touch-icon.png",
  "./splash-dark.png",
  "./splash-light.png"
  // Add more here if you later add CSS/JS files
  // e.g. "./styles.css", "./app.js"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS))
  );
  // Activate this SW immediately after install
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.map((k) => (k !== CACHE ? caches.delete(k) : undefined)))
    )
  );
  // Control all open clients without a reload
  self.clients.claim();
});

// Network strategies:
// - Navigations: network-first, fallback to cached index.html when offline.
// - Same-origin requests for other assets: stale-while-revalidate.
// - Cross-origin: just pass-through (don’t cache).
self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Only handle GET
  if (req.method !== "GET") return;

  // Navigations (address bar / SPA routes)
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          // Cache a copy for offline
          caches.open(CACHE).then((c) => c.put(req, res.clone()));
          return res;
        })
        .catch(async () => {
          // Offline fallback to cached page or index.html
          return (await caches.match(req)) || (await caches.match("./index.html"));
        })
    );
    return;
  }

  // Only cache same-origin non-navigation requests
  if (url.origin === location.origin) {
    event.respondWith(
      caches.match(req).then((cached) => {
        const fetchPromise = fetch(req)
          .then((networkRes) => {
            // Put a fresh copy in cache (ignore opaque/error responses)
            if (networkRes && networkRes.status === 200) {
              caches.open(CACHE).then((c) => c.put(req, networkRes.clone()));
            }
            return networkRes;
          })
          .catch(() => cached); // use cache if network fails

        // Stale-while-revalidate: serve cache immediately, update in background
        return cached || fetchPromise;
      })
    );
  }
  // Else: cross-origin – don’t cache; let it go to network
});
