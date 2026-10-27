// Guarda a tela de ponto no celular para abrir mesmo sem internet.
const CACHE = "ponto-gobox-v3";
const ESSENCIAIS = ["ponto.html", "ponto.js", "common.js", "config.js", "style.css", "logo.png", "cube.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ESSENCIAIS)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
// Rede primeiro (para receber atualizações); se falhar, usa a cópia guardada.
self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const proprio = url.origin === location.origin;
  const libs = url.hostname === "www.gstatic.com" || url.hostname.endsWith("fonts.googleapis.com") || url.hostname.endsWith("fonts.gstatic.com");
  if (!proprio && !libs) return;
  if (proprio && url.pathname.endsWith(".apk")) return;
  e.respondWith(
    fetch(req).then(res => {
      if (res && (res.ok || res.type === "opaque")) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }))
  );
});
