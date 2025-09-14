const CACHE = "mixer-v1";
const ASSETS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png"
  // If later you split CSS/JS into files, list them here too so they cache offline.
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  // Network-first for navigations; cache-first for assets
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req).then(r => {
        caches.open(CACHE).then(c => c.put(req, r.clone()));
        return r;
      }).catch(() => caches.match(req).then(r => r || caches.match("./index.html")))
    );
  } else {
    e.respondWith(
      caches.match(req).then(r => r || fetch(req).then(resp => {
        caches.open(CACHE).then(c => c.put(req, resp.clone()));
        return resp;
      }))
    );
  }
});
