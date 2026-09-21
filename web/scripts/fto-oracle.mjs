// Regenerates test/fixtures/fto-oracle.json, the FTO model's oracle: what two independent models say each alg
// does, as piece maps keyed by touch sets (for each position, the base moves whose layer holds it, in Ben's
// letters), so no sticker numbering has to agree between models. Ben's-notation algs run on cubing.js; the
// edge-in-front (lowcubes) algs run on lowcubes' own FTO image generator, whose move functions this script
// pulls out of the site's JS at run time (lowcubes.com/tools/fto-image-generator; its `Us` reuses a temporary
// and loses a sticker, fixed here). Both move stickers on a whole-puzzle rotation where ours turns the frame,
// so each alg is run with its net rotation undone (`ran`).
//
//   npm i --no-save cubing && node scripts/fto-oracle.mjs
//
// cubing.js is not a dependency on purpose: the fixture is committed, this runs once when the alg list changes.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { puzzles } from 'cubing/puzzles';

const OUT = new URL('../test/fixtures/fto-oracle.json', import.meta.url);
const BEN = ['U', 'F', 'L', 'R', 'D', 'B', 'BL', 'BR'];
const name = (set) => [...set].sort().join('+');

// ---- cubing.js, Ben's letters ----
const kp = await puzzles.fto.kpuzzle();
const pat = (alg) => kp.defaultPattern().applyAlg(alg).patternData;
const orbits = Object.keys(kp.definition.defaultPattern);
const cjTouch = Object.fromEntries(orbits.map((o) => [o, kp.definition.defaultPattern[o].pieces.map(() => new Set())]));
for (const m of BEN) { const p = pat(m); for (const o of orbits) p[o].pieces.forEach((v, i) => { if (v !== i) cjTouch[o][i].add(m); }); }
function cjPieces(alg) {
  const p = pat(alg), out = {};
  for (const o of orbits) p[o].pieces.forEach((v, i) => { if (v !== i) out[name(cjTouch[o][i])] = name(cjTouch[o][v]); });
  return out;
}

// ---- lowcubes' model, from its page ----
// (a piece twisted in place is not recorded on either side: the maps say where pieces went, not how they turned)
// node's fetch ignores the sandbox's proxy variables; curl honours them
const get = async (url) => { try { return await (await fetch(url)).text(); } catch { return execFileSync('curl', ['-sL', url], { encoding: 'utf8', maxBuffer: 1 << 26 }); } };
const page = await get('https://www.lowcubes.com/tools/fto-image-generator');
const chunks = [...new Set(page.match(/\/_next\/static\/chunks\/[^"]+\.js/g))];
let src = '';
for (const c of chunks) { const js = await get(`https://www.lowcubes.com${c}`); if (js.includes('"Rt"')) { src = js; break; } }
if (!src) throw new Error('lowcubes: no chunk defines the FTO moves');
const fnNames = { R: 'T', U: 'O', F: 'K', L: '$', D: 'q', B: 'P', Bl: 'G', Br: 'X', Rs: 'Y', Ls: 'J', Us: 'Q', Fs: 'ee', Rt: 'et', Lt: 'er', Ft: 'ea' };
const fns = {};
for (const [move, fn] of Object.entries(fnNames)) {
  const m = new RegExp(`(?<![\\w$])${fn.replace('$', '\\$')}=e=>\\{(.*?)\\}`).exec(src);
  if (!m) throw new Error(`lowcubes: no function ${fn} for ${move}`);
  let body = m[1];
  if (move === 'Us') body = body.replace('e.l2=t,e.r4=e.b6', 'e.l2=t,t=e.r4,e.r4=e.b6'); // their bug
  fns[move] = new Function('e', body);
}
const EIF = ['U', 'F', 'L', 'R', 'D', 'B', 'Bl', 'Br'];
const seq = { Rw: ['R', 'Rs'], Lw: ['L', 'Ls'], Uw: ['U', 'Us'], Fw: ['F', 'Fs'], Dw: ['D', 'Us', 'Us'], Bw: ['B', 'Fs', 'Fs'], Blw: ['Bl', 'Rs', 'Rs'], Brw: ['Br', 'Ls', 'Ls'],
  Ro: ['R', 'Rs', 'Bl', 'Bl'], Lo: ['L', 'Ls', 'Br', 'Br'], Uo: ['U', 'Us', 'D', 'D'], Fo: ['F', 'Fs', 'B', 'B'] };
const lcSolved = () => { const s = {}; for (const f of ['u', 'f', 'r', 'l', 'd', 'e', 'i', 'b']) for (let k = 1; k <= 9; k++) s[f + k] = f + k; return s; };
function lcApply(alg) {
  const state = lcSolved();
  for (const tok of alg.split(/\s+/).filter(Boolean)) {
    const m = /^([A-Za-z]+?)(2'|2|')?$/.exec(tok); if (!m) throw new Error(tok);
    const [, base, suf] = m, order = base.endsWith('t') ? 4 : 3;
    const times = suf === "'" ? order - 1 : suf === '2' ? 2 : suf === "2'" ? order - 2 : 1;
    for (let i = 0; i < times; i++) for (const p of seq[base] ?? [base]) fns[p](state);
  }
  return state;
}
const CHI = { U: 'B', F: 'U', L: 'L', R: 'R', D: 'F', B: 'D', Bl: 'BL', Br: 'BR' }; // cube/fto.ts EIF_TO_BEN
const lcTouch = Object.fromEntries(Object.keys(lcSolved()).map((k) => [k, new Set()]));
for (const m of EIF) { const st = lcApply(m); for (const k in st) if (st[k] !== k) lcTouch[k].add(CHI[m]); }
function lcPieces(alg) {
  const st = lcApply(alg), out = {};
  for (const k in st) { if (st[k] === k) continue; const p = name(lcTouch[k]), q = name(lcTouch[st[k]]); if (p === q) continue; if (out[p] && out[p] !== q) throw new Error(`split piece at ${p} in ${alg}`); out[p] = q; }
  return out;
}
const same = (a, b) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
for (const m of EIF) if (!same(lcPieces(m), cjPieces(CHI[m]))) throw new Error(`lowcubes ${m} is not cubing.js ${CHI[m]}: the letter map is wrong`);

// ---- the algs ----
const ben = [];
for (const m of BEN) for (const s of ['', "'"]) ben.push(m + s);
for (const a of BEN) for (const b of BEN) if (a !== b) ben.push(`${a} ${b}`);
ben.push('U F L', 'U L F', 'F R BL', 'BL R F', 'U D B', 'L BR D', 'U 2U', '2U U', 'U 2F', '2F U', 'F 2L R', '2BL 2D 2F',
  'U Fv U', 'F Dv F', 'L Uv F', 'BR Lv F', 'U Rv F', 'U Bv F', 'R BLv U', 'F BRv L', 'U D_F_L_BLv2 U', 'R U_L_F_Rv2 R', 'F D_BR_R_Fv2 L',
  "R' L R L'", "R B' R' B", "F' U F' D' F U' F' D F'", "F D' F U F' D F U' F", "BL R' L' R L BL'");
const TCP = { A1: "U' R U R'", A2: "Uo' U R' U' R' D' R U R' D R U' R Uo", A3: "Fo R' D R' U' R D R U R' D R Fo'", A4: "Rt2 U D' R U' R' D Lo' U R' U' R Ro'", A5: "Rt2 U Rw' U' R U Rw R2' U' R Rt2", A6: "Rt2 R' U' Rw' R U' R U R' Rw U Rt2",
  B1: "Fo R U' R' U Fo'", B2: "U' R U R D R' U' R D' R' U R'", B3: "F' R' D' R U' R' D' R' U R D' R", B4: "Fo U' D R' U R D' Ro R' U R U' Rt2", B5: "Fo U' Rw U R' U' Rw2 R' U R' Fo'", B6: "Fo R U R' Rw U R' U' R Rw' U' Fo'",
  C1: "U' R' D R' U R D' R", C2: "Uo' U R D' R U' R' D R' Uo", C3: "Fo' F R Br R' L R Br' R2' L' R Fo", C4: "F' R' D' R U' R' D R2 U R'", C5: "Uo R' U' R D' R U' R' D R' U' R Uo'", C6: "R U' R' U Ro R' U R U' Ro'" };
const eif = [...EIF.flatMap((m) => [m, m + "'", m + '2', m + "2'"]), 'Rw', "Lw'", 'Uw', 'Fw', 'Dw', 'Bw', 'Blw', 'Brw', 'Rs', 'Ls', 'Us', 'Fs', 'Uo', "Fo'", 'Ro', 'Lo', 'Rt', 'Lt', 'Ft', 'Rt2', "Lt'",
  'U Rt R', 'F Lt2 U', 'R Ft D', 'F Lt U', "L Lt' F", "D Ft' U", "U Rt' L", 'Uo U', "Fo' R Fo", 'Ro U', 'Lo F', 'Rw U', 'Us R', 'Fs U', 'Ls R', 'Dw U', 'Bw R', 'Blw U', 'Brw F', ...Object.values(TCP)];

const invTok = (t) => (t.endsWith("2'") ? t.slice(0, -1) : t.endsWith('2') ? `${t}'` : t.endsWith("'") ? t.slice(0, -1) : `${t}'`);
const undo = (alg, isRot) => alg.split(' ').filter(isRot).reverse().map(invTok).join(' ');
const benRun = (alg) => `${alg} ${undo(alg, (t) => /v/.test(t))}`.trim();
const eifRun = (alg) => `${alg} ${undo(alg, (t) => /^(Uo|Fo|Ro|Lo|Rt|Lt|Ft)/.test(t))}`.trim();
const fixture = {
  note: "Generated by scripts/fto-oracle.mjs: piece maps 'position <- source' keyed by touch sets in Ben's letters. ben: cubing.js. eif: lowcubes' FTO image-generator model, letters mapped by EIF_TO_BEN. Both move stickers on a whole-puzzle rotation and ours keeps the starting frame, so each alg was run with its net rotation undone (ran).",
  ben: ben.map((alg) => ({ alg, ran: benRun(alg), pieces: cjPieces(benRun(alg)) })),
  eif: eif.map((alg) => ({ alg, ran: eifRun(alg), pieces: lcPieces(eifRun(alg)) })),
};
writeFileSync(OUT, `${JSON.stringify(fixture)}\n`);
console.log(`wrote ${OUT.pathname}: ${fixture.ben.length} algs in Ben's notation, ${fixture.eif.length} in EIF`);
