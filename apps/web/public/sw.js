// Offline support for the staff dashboard (Build Prompt §5.15).
// - Built assets (/_next/static) are immutable: cache first.
// - Pages: network first, falling back to the last cached copy, so the app opens without internet.
// - API calls are never cached here: the app keeps its own copy of today's schedule in IndexedDB.
const VERSION = "v1";
const STATIC = `static-${VERSION}`;
const PAGES = `pages-${VERSION}`;
const SHELL = [
  "/today",
  "/calendar",
  "/patients",
  "/more",
  "/login",
  "/manifest.webmanifest",
  "/icon-192.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(PAGES)
      .then((cache) => Promise.allSettled(SHELL.map((url) => cache.add(url))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => ![STATIC, PAGES].includes(k)).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;

  if (url.pathname.startsWith("/_next/static/") || /\.(png|svg|ico|woff2?)$/.test(url.pathname)) {
    event.respondWith(
      caches.match(request).then(
        (hit) =>
          hit ||
          fetch(request).then((res) => {
            if (res.ok) caches.open(STATIC).then((c) => c.put(request, res.clone()));
            return res;
          }),
      ),
    );
    return;
  }

  if (
    request.mode === "navigate" ||
    request.headers.get("accept")?.includes("text/html") ||
    url.searchParams.has("_rsc")
  ) {
    event.respondWith(
      fetch(request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(PAGES).then((c) => c.put(request, copy));
          }
          return res;
        })
        .catch(() =>
          caches
            .match(request, { ignoreSearch: true })
            .then((hit) => hit || caches.match("/today"))
            .then(
              (hit) =>
                hit || new Response("Offline", { status: 503, headers: { "content-type": "text/plain" } }),
            ),
        ),
    );
  }
});
