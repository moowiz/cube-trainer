// The last-layer drill, mounted twice: once as the OCLL tab, once as PLL.
// A case (random, or a cube handed over by a scan or the previous stage),
// the top-down last-layer diagram in the trainer's colour scheme, hints
// that reveal the case, Check on the moves typed, and the standard alg with
// its AUFs in brackets. The drill scaffold owns timer, box, result, keys.

import { moveCount, tokens } from '../cube/alg';
import { toWca, WCA_HOLD } from '../cube/frame';
import { type Vec } from '../cube/geometry';
import { faceColorName, faceHex, onSchemeChange } from '../cube/scheme';
import { state } from '../cube/state';
import { stageOf } from '../stage';
import { showTab, stages, type Stage } from '../shell';
import { mountDrill } from '../ui/drill';
import { type LLKind } from './cases';
import { aufToSolve, done, pllArrows, randomSetup, solution } from './model';

const TITLE: Record<LLKind, string> = { ocll: 'OCLL', pll: 'PLL' };
const BLURB: Record<LLKind, string> = {
  ocll: 'Orient the last layer’s corners. After EO the edges are already oriented, so there are 7 cases.',
  pll: 'Permute the last layer: 21 cases. Finish with the AUF so the cube is solved.',
};

// top-view layout: the U face reads U1..U9 back-left to front-right; the side strips read left to right
// (back: B3 B2 B1, front: F1 F2 F3) or back to front (left: L1 L2 L3, right: R3 R2 R1) in Kociemba indices
const SIDES = { back: [47, 46, 45], front: [18, 19, 20], left: [36, 37, 38], right: [11, 10, 9] };

const STYLE = `
  .ll-pic { max-width: 300px; margin: 0 auto; }
  .ll-pic .ll-arrow { fill: none; stroke: #1b222c; stroke-width: 3; stroke-linecap: round; }
  .ll-pic .ll-arrow-halo { fill: none; stroke: #fff; stroke-width: 7; stroke-linecap: round; opacity: .85; }
  .ll-pic .ll-head { fill: #1b222c; stroke: #fff; stroke-width: 1.5; }
  .ll-pic svg { display: block; width: 100%; height: auto; }
  .ll-pic rect { stroke: #2b3340; stroke-width: 1.2; }
  .ll-case { font-size: 16px; min-height: 22px; }
  .ll-case b { font-weight: 600; }
`;

export function mountLL(root: HTMLElement, kind: LLKind): Stage {
  if (!document.getElementById('ll-style')) {
    const s = document.createElement('style'); s.id = 'll-style'; s.textContent = STYLE; document.head.appendChild(s);
  }
  const id = (n: string) => `${kind}-${n}`;
  const drill = mountDrill(root, {
    id: kind, title: TITLE[kind], blurb: BLURB[kind], newLabel: 'New case',
    hints: [{ key: 'name', label: 'Hint: case name' }, { key: 'look', label: 'Hint: what to look for' }],
    movesLabel: 'Moves you did', placeholder: kind === 'pll' ? "e.g. U R U R' U' R' F R2 U' R' U' R U R' F' U2" : "e.g. U2 R U R' U R U2 R'",
    note: 'Solve it on your cube. Space starts and stops the timer, N is a new case.',
    showLabel: 'Show the alg',
    left: `
      <div class="ll-pic"><svg id="${id('pic')}" viewBox="0 0 200 200" aria-label="last layer"></svg></div>
      <div class="eo-status"><div class="ll-case" id="${id('case')}"></div><div class="eo-timer" id="${id('timer')}">0.00</div></div>
      <div class="eo-scramble" id="${id('setup')}"></div>
      <p class="eo-note" id="${id('orient')}"></p>`,
  }, { onNew: newCase, onCheck: check, onHint: hintText, onShow: onShow, onClear: () => { shown = null; render(); } });

  // state: the drill is an alg from solved; the check is that alg plus the moves typed
  let setup = '';
  let sol: ReturnType<typeof solution> = null;
  let shown: string | null = null; // the alg whose state the picture shows (setup + moves after a Check)
  let assisted = false, recorded = false;
  const results: { t: number; n: number; std: number }[] = [];

  function drawPic(): void {
    const f = state(shown ?? setup);
    const cell = (x: number, y: number, w: number, h: number, letter: string) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="3" fill="${faceHex(letter)}"/>`;
    let out = '';
    for (let i = 0; i < 9; i++) out += cell(41 + (i % 3) * 40, 41 + Math.floor(i / 3) * 40, 38, 38, f[i]);
    SIDES.back.forEach((k, i) => { out += cell(41 + i * 40, 24, 38, 13, f[k]); });
    SIDES.front.forEach((k, i) => { out += cell(41 + i * 40, 163, 38, 13, f[k]); });
    SIDES.left.forEach((k, i) => { out += cell(24, 41 + i * 40, 13, 38, f[k]); });
    SIDES.right.forEach((k, i) => { out += cell(163, 41 + i * 40, 13, 38, f[k]); });
    if (kind === 'pll') out += arrowsSvg(pllArrows(f) ?? []);
    drill.$('pic').innerHTML = out;
  }

  /** The arrows over the top face: a 2-cycle as one double-headed arrow, a cycle as one arrow per piece, corners nudged off the edge lines. */
  function arrowsSvg(arrows: { from: Vec; to: Vec }[]): string {
    const at = (p: Vec): [number, number] => [100 + p[0] * 40, 100 + p[2] * 40]; // cell centres: x from the R axis, y from the F axis (front is down)
    const key = (a: Vec, b: Vec) => `${a[0]},${a[2]}>${b[0]},${b[2]}`;
    const seen = new Set<string>();
    let out = '';
    for (const { from, to } of arrows) {
      if (seen.has(key(from, to))) continue;
      seen.add(key(from, to));
      const back = arrows.some((o) => o.from[0] === to[0] && o.from[2] === to[2] && o.to[0] === from[0] && o.to[2] === from[2]);
      if (back) seen.add(key(to, from));
      const [x1, y1] = at(from), [x2, y2] = at(to);
      const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy), ux = dx / len, uy = dy / len;
      const pad = 11, ax = x1 + ux * pad, ay = y1 + uy * pad, bx = x2 - ux * pad, by = y2 - uy * pad;
      const head = (x: number, y: number, dxx: number, dyy: number) => `<polygon class="ll-head" points="${x},${y} ${x - dxx * 10 + dyy * 5.5},${y - dyy * 10 - dxx * 5.5} ${x - dxx * 10 - dyy * 5.5},${y - dyy * 10 + dxx * 5.5}"/>`;
      out += `<line class="ll-arrow-halo" x1="${ax}" y1="${ay}" x2="${bx}" y2="${by}"/><line class="ll-arrow" x1="${ax}" y1="${ay}" x2="${bx}" y2="${by}"/>${head(bx, by, ux, uy)}${back ? head(ax, ay, -ux, -uy) : ''}`;
    }
    return out;
  }

  function caseText(): string {
    if (sol) return `<b>${sol.case.name}</b>`;
    const r = stageOf(state(setup));
    if (r.stage === 'solved') return kind === 'pll' ? 'Solved already: a PLL skip.' : 'Solved already.';
    if (kind === 'ocll' && r.stage === 'pll') return 'Corners already oriented: an OCLL skip.';
    return `Not ${kind === 'ocll' ? 'an' : 'a'} ${TITLE[kind]} case: this cube is at ${r.stage === 'eo' ? 'EO' : r.stage === 'f2l' ? 'F2L' : r.stage.toUpperCase()}.`;
  }

  function render(): void {
    drawPic();
    const named = root.querySelector('.eo-chip[data-hint="name"].open');
    drill.$('case').innerHTML = named || (drill.result.visible() && recorded) || !sol ? caseText() : '';
    const su = drill.$('setup');
    su.innerHTML = setup ? 'Setup: <span></span>' : '';
    if (setup) su.querySelector('span')!.textContent = toWca(setup);
    drill.$('orient').textContent = `Apply the setup to a solved cube held ${WCA_HOLD}, then turn it white down with ${faceColorName('F')} facing you (${faceColorName('R')} on the right). Or just make the top layer match the picture.`;
    if (results.length) {
      const mt = results.reduce((a, r) => a + r.t, 0) / results.length, mn = results.reduce((a, r) => a + r.n, 0) / results.length, ms = results.reduce((a, r) => a + r.std, 0) / results.length;
      drill.setStats(`This session: ${results.length} solved, mean ${mt.toFixed(2)}s, ${mn.toFixed(1)} moves (standard algs mean ${ms.toFixed(1)}).`);
    } else drill.setStats('');
  }

  function load(alg: string): void {
    setup = alg.trim();
    sol = solution(kind, setup);
    shown = null; assisted = false; recorded = false;
    drill.begin();
    render();
  }
  function newCase(): void { load(randomSetup(kind).setup); }

  /** The standard solution as a line: the alg with its AUFs in brackets, [U] R U R' ... [U']. */
  const algPlain = () => (sol ? [sol.pre, sol.case.alg, sol.post].filter(Boolean).join(' ') : '');
  const algShown = () => (sol ? [sol.pre && `[${sol.pre}]`, sol.case.alg, sol.post && `[${sol.post}]`].filter(Boolean).join(' ') : '');
  const AUF_NOTE = ` <small>[U] is the AUF: turn the top layer that way first, the alg is what follows${kind === 'pll' ? '; a bracket at the end lines the layer up after it' : ''}.</small>`;
  const algLine = () => (sol ? `<div class="ll-alg" data-alg="${algPlain().replace(/"/g, '&quot;')}">${algShown()}${sol.pre || sol.post ? AUF_NOTE : ''}</div>` : '');

  function check(txt: string): void {
    let toks: string[];
    try { toks = tokens(txt); } catch (err) { drill.flash(err instanceof Error ? err.message : String(err)); return; }
    drill.flash('');
    const alg = `${setup} ${toks.join(' ')}`;
    shown = alg;
    const { n, t, ts } = drill.attempt(txt);
    drill.result.handoff.innerHTML = ''; drill.result.body.innerHTML = '';
    let ok = done(kind, alg), note = '';
    if (kind === 'pll' && !ok) { const auf = aufToSolve(alg); if (auf) { ok = true; note = ` Solved up to the AUF: add ${auf}.`; } }
    if (!ok) {
      const rep = stageOf(state(alg));
      drill.result.show(`${TITLE[kind]} not done yet`, rep.pairs < 4 ? `F2L is broken (${rep.pairs}/4 pairs).` : rep.eoBad ? `${rep.eoBad} edge${rep.eoBad === 1 ? ' is' : 's are'} flipped.` : !rep.ocll ? 'Some corners are still not oriented.' : 'The last layer is not permuted yet.');
      render(); return;
    }
    if (!recorded) { recorded = true; results.push({ t: t ?? 0, n, std: sol ? moveCount(algPlain()) : n }); }
    drill.result.show(`${TITLE[kind]} done in ${n} moves${ts}`, (sol ? `Case: ${sol.case.name}. The standard alg is ${moveCount(algPlain())} moves.` : '') + note + (assisted ? ' You peeked at the alg.' : ''));
    drill.result.body.innerHTML = algLine();
    if (kind === 'ocll' && stages.pll) {
      const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'btn eo-primary'; btn.style.marginTop = '8px';
      btn.textContent = 'Continue to PLL with this cube';
      btn.addEventListener('click', () => { stages.pll!.load(alg); showTab('pll'); window.scrollTo({ top: 0 }); });
      drill.result.handoff.appendChild(btn);
    }
    render();
  }

  function hintText(key: string): string {
    const plain = caseText().replace(/<[^>]+>/g, '');
    if (key === 'name') { setTimeout(render); return sol ? sol.case.name : plain; }
    return sol ? sol.case.hint : plain;
  }

  function onShow(open: boolean): void {
    drill.setShowLabel(open ? 'Hide the alg' : 'Show the alg');
    if (!open) return;
    assisted = true;
    if (!sol) { drill.result.show('No tabled alg', caseText().replace(/<[^>]+>/g, '')); drill.result.body.innerHTML = ''; return; }
    drill.result.show(`${sol.case.name}: ${moveCount(algPlain())} moves`, sol.case.hint);
    drill.result.body.innerHTML = algLine();
  }

  onSchemeChange(render);
  newCase();
  return { load, render, scramble: () => setup || null, newScramble: newCase };
}
