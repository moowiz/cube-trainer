// Regenerates web/index.html from the original ZZ trainer HTML at the repo
// root, wiring in the scanner's "Scan cube" tab. Run from the repo root:
//   node tools/patch-trainer-into-web.js
// Re-run this if the trainer HTML file is ever updated, instead of editing
// web/index.html by hand.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src = path.join(root, '5df7b1a9-0af0-4614-8dc7-6a365ca30928.html');
const dst = path.join(root, 'web', 'index.html');
let html = fs.readFileSync(src, 'utf8');

const patches = [
  // 1. third tab button
  [
    '<button type="button" data-t="f2l">ZZF2L</button>',
    '<button type="button" data-t="f2l">ZZF2L</button>\n  <button type="button" data-t="scan">Scan cube</button>',
  ],
  // 2. the scan panel div, before the shared-bus script (must exist before showTab runs)
  [
    '<script>\n// shared bus between the two trainers',
    '<div id="scan-panel" hidden></div>\n\n<script>\n// shared bus between the two trainers',
  ],
  // 3. include scan in the tab switcher
  ["for(const k of ['eo','f2l'])", "for(const k of ['eo','f2l','scan'])"],
  // 4. allow restoring the scan tab on load
  [
    "ZZ.showTab(tab==='eo'?'eo':'f2l');",
    "ZZ.showTab(['eo','f2l','scan'].includes(tab)?tab:'f2l');",
  ],
  // 5. scanner module (deferred; runs after all inline scripts)
  ['</body>', '<script type="module" src="/src/trainer-main.ts"></script>\n</body>'],
];

for (const [from, to] of patches) {
  const n = html.split(from).length - 1;
  if (n !== 1) {
    console.error(`FAIL: pattern found ${n} times (expected 1): ${JSON.stringify(from.slice(0, 60))}`);
    process.exit(1);
  }
  html = html.replace(from, to);
}
fs.writeFileSync(dst, html);
console.log(`OK: wrote ${dst} (${html.length} bytes), ${patches.length} patches applied`);
