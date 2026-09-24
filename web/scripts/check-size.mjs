// A ceiling on the built page's entry chunk (dist/assets/main-*.js), so a
// static import that drags a whole tab into the first download shows up in
// CI instead of on the phone. Run after `npm run build`. The ceiling is a
// ratchet: lower it when the chunk shrinks, never raise it without saying why
// in the commit (docs/maintenance-plan.md 2.5 is the plan to shrink it).
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// DECISION: 620 kB minified; measured 583 kB on 2026-09-23.
const CEILING_KB = 620;
const dir = new URL('../dist/assets/', import.meta.url).pathname;

const main = readdirSync(dir).filter((f) => /^main-.*\.js$/.test(f));
if (main.length !== 1) { console.error(`check-size: expected one main-*.js in dist/assets, found ${main.length} (run npm run build first)`); process.exit(2); }
const kb = statSync(join(dir, main[0])).size / 1024;
const ok = kb <= CEILING_KB;
console.log(`${ok ? 'ok' : 'FAIL'}: ${main[0]} is ${kb.toFixed(0)} kB (ceiling ${CEILING_KB} kB)`);
process.exit(ok ? 0 : 1);
