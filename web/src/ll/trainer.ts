// The last-layer drill, mounted twice: once as the OCLL tab, once as PLL.
// A case (random, or a cube handed over by a scan or the previous stage),
// the top-down last-layer diagram in the trainer's colour scheme, hints
// that reveal the case, Check on the moves typed, and the standard alg with
// its AUFs in brackets. The drill scaffold owns timer, box, result, keys.

import { moveCount, tokens } from '../cube/alg';
import { toWca, WCA_HOLD } from '../cube/frame';
import { faceColorName, onSchemeChange } from '../cube/scheme';
import { state } from '../cube/state';
import { stageOf } from '../stage';
import { showTab, stages, type Stage } from '../shell';
import { mountDrill } from '../ui/drill';
import { triggers } from '../ui/fingertricks';
import { CASES, type LLKind } from './cases';
import { aufToSolve, done, randomSetup, scrambleFor, solution } from './model';
import { ensurePicStyle, picSvg } from './pic';
import { openLLReference } from './reference';

const TITLE: Record<LLKind, string> = { ocll: 'OCLL', pll: 'PLL' };
const BLURB: Record<LLKind, string> = {
  ocll: 'Orient the last layer’s corners. After EO the edges are already oriented, so there are 7 cases.',
  pll: 'Permute the last layer: 21 cases. Finish with the AUF so the cube is solved.',
};

const STYLE = `
  .ll-pic { max-width: 300px; margin: 0 auto; }
  .ll-case { font-size: 16px; min-height: 22px; }
  .ll-trig { display: inline-block; position: relative; padding: 0 2px 13px; margin: 0 2px; border-bottom: 2px solid var(--ink-2); line-height: 1.3; }
  .ll-trig i { position: absolute; left: 0; right: 0; bottom: -1px; font-size: 11px; font-style: normal; line-height: 1; text-align: center; white-space: nowrap; color: var(--ink-2); word-spacing: normal; letter-spacing: .02em; }
  .ll-case b { font-weight: 600; }
`;

export function mountLL(root: HTMLElement, kind: LLKind): Stage {
  if (!document.getElementById('ll-style')) {
    const s = document.createElement('style'); s.id = 'll-style'; s.textContent = STYLE; document.head.appendChild(s);
  }
  ensurePicStyle();
  const id = (n: string) => `${kind}-${n}`;
  const drill = mountDrill(root, {
    id: kind, stage: kind, title: TITLE[kind], blurb: BLURB[kind], newLabel: 'New case',
    hints: [{ key: 'name', label: 'Hint: case name' }, { key: 'look', label: 'Hint: what to look for' }],
    movesLabel: 'Moves you did', placeholder: kind === 'pll' ? "e.g. U R U R' U' R' F R2 U' R' U' R U R' F' U2" : "e.g. U2 R U R' U R U2 R'",
    note: 'Solve it on your cube. Space starts and stops the timer, N is a new case.',
    showLabel: 'Show the alg',
    left: `
      <div class="ll-pic"><svg id="${id('pic')}" viewBox="0 0 200 200" aria-label="last layer"></svg></div>
      <div class="eo-status"><div class="ll-case" id="${id('case')}"></div><div class="eo-timer" id="${id('timer')}">0.00</div></div>
      <div class="eo-scramble" id="${id('setup')}"></div>
      <p class="eo-note" id="${id('orient')}"></p>`,
  }, { onNew: newCase, onCheck: check, onHint: hintText, onShow: onShow, onClear: () => { shown = null; render(); },
    // a cube feeding the box is done when the case is (the AUF included: it is timed too)
    isDone: (txt) => { try { return done(kind, `${setup} ${tokens(txt).join(' ')}`); } catch { return false; } },
    base: () => setup, onApply: (alg) => { shown = `${setup} ${alg}`; render(); } });

  // state: the drill is an alg from solved; the check is that alg plus the moves typed
  let setup = '';
  let scramble: string | null = null; // PLL: a short face-turn scramble for `setup` (the setup itself is an alg backwards)
  let scrambleGen = 0;
  let sol: ReturnType<typeof solution> = null;
  let shown: string | null = null; // the alg whose state the picture shows (setup + moves after a Check)
  let assisted = false, recorded = false;
  const results: { t: number; n: number; std: number }[] = [];

  function drawPic(): void { drill.$('pic').innerHTML = picSvg(state(shown ?? setup), kind); }

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
    const pending = kind === 'pll' && scramble === null;
    su.innerHTML = setup ? `${kind === 'pll' ? 'Scramble' : 'Setup'}: <span></span>` : '';
    if (setup) su.querySelector('span')!.textContent = pending ? '…' : toWca(scramble ?? setup);
    drill.$('orient').textContent = `Apply the ${kind === 'pll' ? 'scramble' : 'setup'} to a solved cube held ${WCA_HOLD}, then turn it white down with ${faceColorName('F')} facing you (${faceColorName('R')} on the right). Or just make the top layer match the picture.`;
    if (results.length) {
      const mt = results.reduce((a, r) => a + r.t, 0) / results.length, mn = results.reduce((a, r) => a + r.n, 0) / results.length, ms = results.reduce((a, r) => a + r.std, 0) / results.length;
      drill.setStats(`This session: ${results.length} solved, mean ${mt.toFixed(2)}s, ${mn.toFixed(1)} moves (standard algs mean ${ms.toFixed(1)}).`);
    } else drill.setStats('');
  }

  function load(alg: string): void {
    setup = alg.trim();
    sol = solution(kind, setup);
    shown = null; assisted = false; recorded = false;
    // the setup is an alg backwards (rotations, slices, 20 moves for an N perm): a PLL drill shows
    // a short face-turn scramble for the same state instead. DECISION: solved on a timeout, not
    // here: the first solve builds the pruning tables (~200 ms), which would otherwise sit in the
    // page's mount; the setup is shown if the state is somehow not a PLL.
    scramble = null;
    const gen = ++scrambleGen;
    if (kind === 'pll') setTimeout(() => { if (gen !== scrambleGen) return; scramble = scrambleFor(setup) ?? setup; render(); });
    drill.begin();
    render();
  }
  function newCase(): void { load(randomSetup(kind).setup); }

  /** The standard solution as a line: the alg with its AUFs in brackets, [U] R U R' ... [U']. */
  const algPlain = () => (sol ? [sol.pre, sol.case.alg, sol.post].filter(Boolean).join(' ') : '');
  const algShown = () => (sol ? [sol.pre && `[${sol.pre}]`, sol.case.alg, sol.post && `[${sol.post}]`].filter(Boolean).join(' ') : '');
  const AUF_NOTE = ` <small>[U] is the AUF: turn the top layer that way first, the alg is what follows${kind === 'pll' ? '; a bracket at the end lines the layer up after it' : ''}.</small>`;
  const algLine = (): HTMLElement | null => {
    if (!sol) return null;
    const d = drill.algLine(algShown(), algPlain()); d.classList.add('ll-alg');
    markTriggers(d, sol.case.alg, sol.pre ? 1 : 0);
    if (sol.pre || sol.post) d.insertAdjacentHTML('beforeend', AUF_NOTE);
    return d;
  };
  /** Label the named triggers (sexy, sledge...) on a built alg line: the case's moves start at move `offset` (after a [U] AUF). */
  function markTriggers(line: HTMLElement, alg: string, offset: number): void {
    const mvs = [...line.querySelectorAll<HTMLElement>('.mv')];
    for (const g of triggers(alg)) {
      const first = mvs[offset + g.at], last = mvs[offset + g.at + g.n - 1];
      if (!first || !last) continue;
      const wrap = document.createElement('span'); wrap.className = 'll-trig';
      first.before(wrap);
      for (let node: ChildNode | null = first; node; ) { const next: ChildNode | null = node.nextSibling; wrap.appendChild(node); if (node === last) break; node = next; }
      const lab = document.createElement('i'); lab.textContent = g.label; wrap.appendChild(lab);
    }
  }
  const putAlgLine = () => { drill.result.body.innerHTML = ''; const d = algLine(); if (d) drill.result.body.appendChild(d); };

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
    if (!recorded) {
      recorded = true;
      results.push({ t: t ?? 0, n, std: sol ? moveCount(algPlain()) : n });
      drill.save({ scramble: setup, moves: toks.join(' '), optimal: sol ? moveCount(algPlain()) : undefined, caseId: sol?.case.name, assisted });
    }
    drill.result.show(`${TITLE[kind]} done in ${n} moves${ts}`, (sol ? `Case: ${sol.case.name}. The standard alg is ${moveCount(algPlain())} moves.` : '') + note + (assisted ? ' You peeked at the alg.' : ''));
    putAlgLine();
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
    putAlgLine();
  }

  // the case list, as a chip after the hints: tap a case there to drill it
  const refBtn = document.createElement('button'); refBtn.type = 'button'; refBtn.className = 'eo-chip'; refBtn.id = id('ref');
  refBtn.textContent = `All ${CASES[kind].length} cases`;
  refBtn.addEventListener('click', () => openLLReference(kind, (alg) => { load(alg); window.scrollTo({ top: 0 }); }));
  drill.$('hints').appendChild(refBtn);
  onSchemeChange(render);
  newCase();
  return { load, render, scramble: () => scramble || setup || null, newScramble: newCase, feed: (text, t, source) => drill.feed(text, t, source), armed: (t) => drill.armed(t) };
}
