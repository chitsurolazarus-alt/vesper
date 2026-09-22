// Minimal app-shell service worker for Vesper's "Add to Home Screen" PWA
// install prompt. Deliberately not a full offline cache — chat, the Supabase
// Edge Function, and the local agent all need live network, so this only
// ever caches the static shell (markup/styles/script/icons) and leaves every
// other request (POST calls, cross-origin fetches to Supabase/Groq/the local
// agent) untouched.

const CACHE_NAME = "vesper-shell-v2";
const SHELL_FILES = [
  "./",
  "./index.html",
  "./style.css",
  "./script.js",
  "./config.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(
        names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))
      ))
      .then(() => self.clients.claim())
  );
});

const SHELL_URLS = new Set(SHELL_FILES.map((f) => new URL(f, self.registration.scope).href));

self.addEventListener("fetch", (event) => {
  const req = event.request;

  // Only ever handle same-origin GETs for known shell files — everything
  // else (API calls, the local agent, cross-origin requests, non-GET
  // methods) is left completely alone so it hits the network normally.
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (!SHELL_URLS.has(req.url) && !SHELL_URLS.has(url.href)) return;

  // Network-first: this app is under active development, so a plain
  // reload should always get the latest deployed code when there's a
  // connection. The cache is purely an offline fallback, not a speed-up —
  // cache-first here would mean every reload serves last visit's code,
  // one deploy behind, until a second reload catches up. Not what we want.
  event.respondWith(
    fetch(req).then((resp) => {
      if (resp.ok) {
        const copy = resp.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
      }
      return resp;
    }).catch(() => caches.match(req))
  );
});
