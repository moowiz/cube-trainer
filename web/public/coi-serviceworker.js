// Cross-origin isolation on a static host (GitHub Pages sends no COOP/COEP
// headers): this service worker adds them to every same-origin response so
// the page becomes crossOriginIsolated and onnxruntime-web can use
// SharedArrayBuffer -> multi-threaded wasm inference (2-3x on a phone).
// The page registers it and reloads once; nothing here touches request
// bodies. Same idea as gzuidhof/coi-serviceworker, trimmed to what we use.
// DECISION: COEP is `credentialless`, not `require-corp`. Firestore's WebChannel
// closes with a no-cors request (Write/channel?TYPE=terminate); its opaque
// response carries no Cross-Origin-Resource-Policy header, and require-corp
// blocks it ("CORP prevented from serving the response" on every disconnect).
// credentialless lets no-cors responses through by fetching them without
// cookies, which Firestore does not use, and still grants SharedArrayBuffer.
// A browser that does not know the value ignores it and the page simply
// stays un-isolated: one wasm thread, which facekp.ts handles.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  const r = e.request;
  if (r.cache === 'only-if-cached' && r.mode !== 'same-origin') return;
  // the sign-in page needs its popup to reach window.opener, which COOP same-origin severs: serve it as is
  if (r.mode === 'navigate' && new URL(r.url).pathname.endsWith('/signin.html')) return;
  e.respondWith(fetch(r).then((res) => {
    if (res.status === 0 || res.type === 'opaque') return res;
    const h = new Headers(res.headers);
    h.set('Cross-Origin-Embedder-Policy', 'credentialless');
    h.set('Cross-Origin-Opener-Policy', 'same-origin');
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
  }));
});
