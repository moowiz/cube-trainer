// Version chip shared by every page (trainer + labeler): a small fixed
// chip in the bottom-left corner (git revision + deployed detector runs,
// from version.json which the vite config emits) so a phone can say
// exactly what it is running. Plain script (no module) so it works both
// in vite pages and static public/ pages; loaded as <script src="nav.js"
// defer>. The floating page menu that used to live here went 2026-09-19
// (it sat on the recording preview); the pages link to each other instead.
// The chip also watches for a new deploy: version.json is fetched again
// every few minutes, whenever the tab comes back into view, and when a
// solve or drill attempt finishes (the app's 'zz-solved' event), on a tap, and when
// its hash changes the chip turns amber and offers a reload (a tap; never
// by itself - a solve or a recording may be running).
(() => {
  const style = document.createElement('style');
  style.textContent = `
    #page-ver { position: fixed; left: 12px; bottom: 12px; z-index: 99998; cursor: pointer;
      font: 11px/1.3 ui-monospace, Menlo, Consolas, monospace; color: #e8eaf0;
      background: rgba(20,22,28,.78); border: 1px solid rgba(255,255,255,.18); border-radius: 8px;
      padding: 4px 8px; white-space: pre; opacity: .8; backdrop-filter: blur(4px); }
    #page-ver:hover, #page-ver.open { opacity: 1; }
    #page-ver.update { opacity: 1; color: #1B222C; background: #FFE9A8; border-color: #E0B24B; font-weight: 600; font-size: 13px; padding: 8px 12px; box-shadow: 0 4px 16px rgba(0,0,0,.25); }
  `;

  // version chip: short form "hash · box17 / kpft8", tap for build time and which model is which
  const ver = document.createElement('div');
  ver.id = 'page-ver';
  ver.hidden = true;
  fetch('version.json', { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : Promise.reject())).then((v) => {
    const short = `${v.hash} · ${v.models.cubebox} / ${v.models.facekp}`;
    const detail = `App version: git commit ${v.hash}, built ${v.time}\nScanner models: ${v.models.cubebox} (finds the cube), ${v.models.facekp} (finds face corners)`;
    const long = `${detail}\nTap to shrink`;
    ver.textContent = short;
    ver.title = `${detail}\nTap for details`;
    ver.addEventListener('click', (e) => {
      e.stopPropagation();
      if (ver.classList.contains('update')) { location.reload(); return; }
      ver.classList.toggle('open'); ver.textContent = ver.classList.contains('open') ? long : short;
      check(true); // a tap also looks for a new deploy right now, and says when there is none
    });
    ver.hidden = false;

    // a new deploy: the chip becomes the update notice
    let checking = false;
    // `told`: the tap's check reports "up to date" for a moment on the chip; the timed checks stay silent
    const check = (told) => {
      if (checking || ver.classList.contains('update') || document.hidden) return;
      checking = true;
      const said = (msg) => {
        if (!told) return;
        const was = ver.classList.contains('open') ? long : short;
        ver.textContent = `${was}\n${msg}`;
        setTimeout(() => { if (!ver.classList.contains('update')) ver.textContent = ver.classList.contains('open') ? long : short; }, 2500);
      };
      // a fresh query string: 'no-cache' only skips the browser's copy, and Pages' CDN keeps version.json up to
      // ten minutes after a deploy under the same URL (a solve right after a push found the old hash)
      fetch(`version.json?t=${Date.now()}`, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : Promise.reject())).then((n) => {
        if (n.hash === v.hash) { said('✓ up to date'); return; }
        ver.classList.remove('open'); ver.classList.add('update');
        ver.textContent = `↻ New version ${n.hash} · tap to reload`;
        ver.title = `You are on ${v.hash}; ${n.hash} was deployed ${n.time}. Tap to reload (finish the solve or the recording first).`;
      }).catch(() => said('could not check (offline?)')).finally(() => { checking = false; });
    };
    setInterval(() => check(false), 5 * 60 * 1000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) check(false); });
    window.addEventListener('focus', () => check(false));
    document.addEventListener('zz-solved', () => check(false)); // the app: a solve or a drill attempt just finished
  }).catch(() => ver.remove());

  const mount = () => { document.body.append(style, ver); };
  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount);
})();
