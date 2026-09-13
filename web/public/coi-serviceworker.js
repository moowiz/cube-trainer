// Cross-origin isolation on a static host (GitHub Pages sends no COOP/COEP
// headers): this service worker adds them to every same-origin response so
// the page becomes crossOriginIsolated and onnxruntime-web can use
// SharedArrayBuffer -> multi-threaded wasm inference (2-3x on a phone).
// The page registers it and reloads once; nothing here touches request
// bodies. Same idea as gzuidhof/coi-serviceworker, trimmed to what we use.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  const r = e.request;
  if (r.cache === 'only-if-cached' && r.mode !== 'same-origin') return;
  e.respondWith(fetch(r).then((res) => {
    if (res.status === 0 || res.type === 'opaque') return res;
    const h = new Headers(res.headers);
    h.set('Cross-Origin-Embedder-Policy', 'require-corp');
    h.set('Cross-Origin-Opener-Policy', 'same-origin');
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
  }));
});
