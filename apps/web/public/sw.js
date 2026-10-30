// Minimal service worker: makes Wisp installable and keeps the app shell available offline.
const SHELL = "wisp-shell-v4";
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(["/", "/manifest.webmanifest", "/icon.svg", "/storage-migration.js"])));
  self.skipWaiting();
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => (k.startsWith("wisp-") || k.startsWith("warren-")) && k !== SHELL).map((k) => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.pathname.startsWith("/api/") || url.pathname.startsWith("/ws")) return;
  // network first, fall back to cache (so updates show up immediately when online)
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok && url.origin === location.origin) {
          const copy = res.clone();
          caches.open(SHELL).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      // only page navigations fall back to the app shell; a missing script must stay an error
      .catch(() => caches.match(e.request).then((r) => r ?? (e.request.mode === "navigate" ? caches.match("/") : Response.error()))),
  );
});

// Push from the hub: an agent wrote to you or wants your OK. Payload: { title, body, tag, url }.
self.addEventListener("push", (e) => {
  let n = {};
  try {
    n = e.data ? e.data.json() : {};
  } catch {
    n = { body: e.data ? e.data.text() : "" };
  }
  e.waitUntil(self.registration.showNotification(n.title || "Wisp", { body: n.body || "", tag: n.tag, icon: "/icon-192.png", badge: "/icon-192.png", data: { url: n.url || "/" } }));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || "/", self.location.origin).href;
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
      const win = wins.find((w) => new URL(w.url).origin === self.location.origin);
      if (win) return win.focus().then(() => win.navigate(url));
      return self.clients.openWindow(url);
    }),
  );
});
