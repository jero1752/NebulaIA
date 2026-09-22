const CACHE = "mi-ia-v2";
const FILES = ["./", "./index.html", "./manifest.json"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  // La app misma va de caché; los mensajes al Worker de IA siempre van a la red
  if (e.request.method !== "GET") return;
  e.respondWith(
    caches.match(e.request).then((cached) => cached || fetch(e.request))
  );
});
