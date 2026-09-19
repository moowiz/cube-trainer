// Version chip shared by every page (trainer + labeler): a small fixed
// chip in the bottom-left corner (git revision + deployed detector runs,
// from version.json which the vite config emits) so a phone can say
// exactly what it is running. Plain script (no module) so it works both
// in vite pages and static public/ pages; loaded as <script src="nav.js"
// defer>. The floating page menu that used to live here went 2026-09-19
// (it sat on the recording preview); the pages link to each other instead.
(() => {
  const style = document.createElement('style');
  style.textContent = `
    #page-ver { position: fixed; left: 12px; bottom: 12px; z-index: 99998; cursor: pointer;
      font: 11px/1.3 ui-monospace, Menlo, Consolas, monospace; color: #e8eaf0;
      background: rgba(20,22,28,.78); border: 1px solid rgba(255,255,255,.18); border-radius: 8px;
      padding: 4px 8px; white-space: pre; opacity: .8; backdrop-filter: blur(4px); }
    #page-ver:hover, #page-ver.open { opacity: 1; }
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
    ver.addEventListener('click', (e) => { e.stopPropagation(); ver.classList.toggle('open'); ver.textContent = ver.classList.contains('open') ? long : short; });
    ver.hidden = false;
  }).catch(() => ver.remove());

  const mount = () => { document.body.append(style, ver); };
  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount);
})();
