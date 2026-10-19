// CrocoAI service worker (docs/design-pwa-ui.md §C). Served by server.js (GET /sw.js, Cache-Control: no-cache),
// which fills in VERSION (a hash of the shell, so every deploy that changes a file gets a fresh cache) and
// PRECACHE (the shell: CSS, JS, icons, local fonts, /offline.html, manifest) - see src/pwa.js.
// Rules: navigations = network-first, fallback /offline.html; shell assets = cache-first; /api/* and anything
// that is not a same-origin GET is never touched (authenticated data never lands in the cache).
const VERSION = "__VERSION__";
const CACHE = `crocoai-${VERSION}`;
const PRECACHE = __PRECACHE__;
const OFFLINE_URL = "/offline.html";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(PRECACHE.map((url) => new Request(url, { cache: "reload" }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("crocoai-") && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function isShellAsset(url) {
  return PRECACHE.includes(url.pathname);
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return; // never cached, never intercepted

  if (req.mode === "navigate") {
    event.respondWith(fetch(req).catch(() => caches.match(OFFLINE_URL).then((r) => r || Response.error())));
    return;
  }
  if (isShellAsset(url)) {
    event.respondWith(caches.match(url.pathname).then((hit) => hit || fetch(req)));
  }
  // everything else (photos, uploads, downloads...) goes straight to the network
});
