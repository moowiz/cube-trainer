// Cross-origin isolation via service worker (public/coi-serviceworker.js) so
// ort-web gets SharedArrayBuffer and wasm threads on GitHub Pages. First
// visit: register, then reload once so the page loads under the worker's
// headers; a sessionStorage flag stops any reload loop. Called when the
// scanner mounts, which is at page load (so the models are ready before the
// scan sheet is first opened): the one-time reload lands before the user has
// done anything on the page.

export function ensureCrossOriginIsolated(): void {
  if (self.crossOriginIsolated || !('serviceWorker' in navigator) || location.protocol !== 'https:') return;
  const flag = 'coi-reloaded';
  navigator.serviceWorker.register(`${import.meta.env.BASE_URL}coi-serviceworker.js`).then((reg) => {
    if (navigator.serviceWorker.controller || sessionStorage.getItem(flag)) return;
    sessionStorage.setItem(flag, '1');
    const sw = reg.installing ?? reg.waiting;
    if (sw) sw.addEventListener('statechange', () => { if (sw.state === 'activated') location.reload(); });
    else if (reg.active) location.reload();
  }).catch(() => undefined);
}
