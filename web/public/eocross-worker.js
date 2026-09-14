// EOCross solver: an exact distance table over (edge orientation of all 12 edges) x (positions of the four
// D-colour cross edges) = 4096 x 11880 = 48.7M states, one byte each, built by breadth-first search from the
// solved state. Optimal solutions are then read off by walking downhill. Runs in a Web Worker (the build is
// a few seconds); also loadable in node for analysis (see tools/eocross/), where it exports itself as globalThis.EOCross.
//
// Protocol:  in  {type:'init', perm:number[18][12], flip:boolean[18], home:number[4]}
//                 perm[m][i] = the slot whose edge lands in slot i under move m (the trainer's TRANS order,
//                 U U' U2 R R' R2 F F' F2 D D' D2 L L' L2 B B' B2); flip[m] = quarter turn of F or B;
//                 home = the solved slots of the four cross edges, in a fixed edge order
//            out {type:'progress', depth}   {type:'ready', hist:number[], ms}
//            in  {type:'solve', id, eo, slots:number[4], cap}   slots = current slot of each cross edge, same order
//            out {type:'solved', id, length, count, solutions:number[][] (move indices), truncated}
'use strict';
const N_EO = 4096, N_CR = 11880, NM = 18;
let T = null, eoT = null, crT = null, HOME = 0;

// cross coordinate: rank of the ordered 4-tuple of distinct slots in 12P4 (mixed radix over the remaining slots)
function rankCross(s) {
  let r = 0;
  for (let i = 0; i < 4; i++) { let k = s[i]; for (let j = 0; j < i; j++) if (s[j] < s[i]) k--; r = r * (12 - i) + k; }
  return r;
}
function unrankCross(r) {
  const d = new Array(4);
  for (let i = 3; i >= 0; i--) { d[i] = r % (12 - i); r = (r - d[i]) / (12 - i); }
  const avail = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], s = new Array(4);
  for (let i = 0; i < 4; i++) s[i] = avail.splice(d[i], 1)[0];
  return s;
}

function build(perm, flip, home) {
  const t0 = Date.now();
  // move tables
  eoT = new Uint16Array(N_EO * NM);
  for (let e = 0; e < N_EO; e++) for (let m = 0; m < NM; m++) {
    const p = perm[m]; let o = 0;
    for (let i = 0; i < 12; i++) { let bit = (e >> p[i]) & 1; if (flip[m] && p[i] !== i) bit ^= 1; o |= bit << i; }
    eoT[e * NM + m] = o;
  }
  const inv = perm.map(p => { const q = new Array(12); for (let i = 0; i < 12; i++) q[p[i]] = i; return q; }); // slot -> where it goes
  crT = new Uint16Array(N_CR * NM);
  for (let c = 0; c < N_CR; c++) { const s = unrankCross(c); for (let m = 0; m < NM; m++) crT[c * NM + m] = rankCross(s.map(x => inv[m][x])); }
  HOME = rankCross(home);
  // BFS by scanning: depth d states expand into 255 (unseen) neighbours
  T = new Uint8Array(N_EO * N_CR).fill(255);
  T[HOME * N_EO] = 0;
  const hist = [1];
  for (let d = 0; ; d++) {
    let n = 0;
    for (let idx = 0, c = 0; c < N_CR; c++) {
      const cb = c * NM;
      for (let e = 0; e < N_EO; e++, idx++) {
        if (T[idx] !== d) continue;
        const eb = e * NM;
        for (let m = 0; m < NM; m++) { const j = crT[cb + m] * N_EO + eoT[eb + m]; if (T[j] === 255) { T[j] = d + 1; n++; } }
      }
    }
    if (!n) break;
    hist.push(n);
    post({ type: 'progress', depth: d + 1 });
  }
  return { type: 'ready', hist, ms: Date.now() - t0 };
}

function solve(eo, slots, cap) {
  const start = rankCross(slots) * N_EO + eo, len = T[start];
  if (len === 255) return { length: -1, count: 0, solutions: [], truncated: false };
  // exact count of optimal solutions (memoised over the few states on optimal paths), then enumerate up to cap
  const memo = new Map();
  const count = idx => {
    if (T[idx] === 0) return 1;
    let v = memo.get(idx); if (v !== undefined) return v;
    const c = (idx / N_EO) | 0, e = idx % N_EO, d = T[idx]; v = 0;
    for (let m = 0; m < NM; m++) { const j = crT[c * NM + m] * N_EO + eoT[e * NM + m]; if (T[j] === d - 1) v += count(j); }
    memo.set(idx, v); return v;
  };
  const total = count(start), out = [], path = [];
  (function dfs(idx) {
    if (out.length >= cap) return;
    if (T[idx] === 0) { out.push(path.slice()); return; }
    const c = (idx / N_EO) | 0, e = idx % N_EO, d = T[idx];
    for (let m = 0; m < NM; m++) {
      const j = crT[c * NM + m] * N_EO + eoT[e * NM + m]; if (T[j] !== d - 1) continue;
      path.push(m); dfs(j); path.pop();
    }
  })(start);
  return { length: len, count: total, solutions: out, truncated: out.length < total };
}
// distance of a state without enumerating (for analysis)
function dist(eo, slots) { return T[rankCross(slots) * N_EO + eo]; }

let post = msg => self.postMessage(msg);
function onMessage(msg) {
  if (msg.type === 'init') return post(build(msg.perm, msg.flip, msg.home));
  if (msg.type === 'solve') return post({ type: 'solved', id: msg.id, ...solve(msg.eo, msg.slots, msg.cap || 3000) });
  if (msg.type === 'dist') return post({ type: 'dist', id: msg.id, d: dist(msg.eo, msg.slots) });
}
if (typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope) {
  self.onmessage = ev => onMessage(ev.data);
} else {
  // node (web/ is an ES-module package, so no module.exports): tools/eocross/ reads this off globalThis
  globalThis.EOCross = { build, solve, dist, rankCross, unrankCross, setPost: f => { post = f; } };
}
