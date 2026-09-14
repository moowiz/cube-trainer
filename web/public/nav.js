// Floating page switcher shared by every page (trainer + standalone pages).
// Plain script (no module) so it works both in vite pages and static
// public/ pages; loaded as <script src="nav.js" defer>. Injects a small
// fixed button that expands into links to all pages, so nothing collides
// with each page's own layout. Also a version chip in the opposite corner
// (git revision + deployed detector runs, from version.json which the vite
// config emits) so a phone can say exactly what it is running.
(() => {
  const pages = [
    ['./', 'Trainer', 'index.html'],
    ['./?tab=scan', 'Scan cube', 'index.html?tab=scan'],   // opens the trainer with the scan sheet up
    ['label.html', 'Labeler'],
  ];
  const here = (location.pathname.split('/').pop() || 'index.html') + (location.search.includes('tab=scan') ? '?tab=scan' : '');

  const style = document.createElement('style');
  style.textContent = `
    #page-nav { position: fixed; right: 12px; bottom: 12px; z-index: 99999;
      font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      font-size: 14px; display: flex; flex-direction: column; align-items: flex-end; gap: 6px; }
    #page-nav .pn-toggle { border: 1px solid rgba(255,255,255,.25); cursor: pointer;
      background: rgba(20,22,28,.88); color: #e8eaf0; border-radius: 999px;
      padding: 8px 14px; font: inherit; line-height: 1;
      box-shadow: 0 2px 10px rgba(0,0,0,.35); backdrop-filter: blur(4px); }
    #page-nav .pn-menu { display: none; flex-direction: column; gap: 2px;
      background: rgba(20,22,28,.94); border: 1px solid rgba(255,255,255,.22);
      border-radius: 12px; padding: 6px; min-width: 150px;
      box-shadow: 0 4px 18px rgba(0,0,0,.45); backdrop-filter: blur(4px); }
    #page-nav.open .pn-menu { display: flex; }
    #page-nav .pn-menu a { color: #e8eaf0; text-decoration: none;
      padding: 8px 12px; border-radius: 8px; }
    #page-nav .pn-menu a:hover { background: rgba(255,255,255,.10); }
    #page-nav .pn-menu a.pn-here { color: #7fb5ff; font-weight: 600; pointer-events: none; }
    #page-ver { position: fixed; left: 12px; bottom: 12px; z-index: 99998; cursor: pointer;
      font: 11px/1.3 ui-monospace, Menlo, Consolas, monospace; color: #e8eaf0;
      background: rgba(20,22,28,.78); border: 1px solid rgba(255,255,255,.18); border-radius: 8px;
      padding: 4px 8px; white-space: pre; opacity: .8; backdrop-filter: blur(4px); }
    #page-ver:hover, #page-ver.open { opacity: 1; }
  `;

  const box = document.createElement('div');
  box.id = 'page-nav';
  const menu = document.createElement('div');
  menu.className = 'pn-menu';
  for (const [href, label, alias] of pages) {
    const a = document.createElement('a');
    a.href = href;
    a.textContent = label;
    const file = alias || href;
    if (here === file) a.className = 'pn-here';
    menu.appendChild(a);
  }
  const btn = document.createElement('button');
  btn.className = 'pn-toggle';
  btn.type = 'button';
  btn.textContent = '☰ pages';
  btn.setAttribute('aria-label', 'Switch page');
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    box.classList.toggle('open');
  });
  document.addEventListener('click', () => box.classList.remove('open'));

  box.append(menu, btn);

  // version chip: short form "hash · box17 / kpft8", tap for build time and which model is which
  const ver = document.createElement('div');
  ver.id = 'page-ver';
  ver.hidden = true;
  fetch('version.json', { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : Promise.reject())).then((v) => {
    const short = `${v.hash} · ${v.models.cubebox} / ${v.models.facekp}`;
    const long = `build ${v.hash} · ${v.time}
box ${v.models.cubebox} · corners ${v.models.facekp}`;
    ver.textContent = short;
    ver.title = long;
    ver.addEventListener('click', (e) => { e.stopPropagation(); ver.classList.toggle('open'); ver.textContent = ver.classList.contains('open') ? long : short; });
    ver.hidden = false;
  }).catch(() => ver.remove());

  const mount = () => { document.body.append(style, box, ver); };
  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount);
})();
