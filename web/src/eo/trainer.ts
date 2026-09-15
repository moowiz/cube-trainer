// The EO / EOCross drill: a random scramble (or a cube handed over by a scan),
// the 3D or net picture, hints, every optimal solution grouped into
// families, the per-scramble strategy note, and Continue to F2L. Built on
// the drill scaffold; the cube is a facelet string, the solving is on the
// 12-edge model.

import { faceMoves, movesStr, tokens, type Move } from '../cube/alg';
import { toWca, WCA_HOLD } from '../cube/frame';
import { badEdgePositions, crossSolved, edgeState, eoSolved, type EdgeState } from '../cube/pieces';
import { DEFAULT_VIEW, orbit, render3d, renderNet, type Cell, type View } from '../cube/render';
import { STICKERS, key } from '../cube/geometry';
import { faceColorName, faceHex, onSchemeChange } from '../cube/scheme';
import { state } from '../cube/state';
import { stageOf } from '../stage';
import { showTab, stages, type Stage } from '../shell';
import { mountDrill, type Drill } from '../ui/drill';
import { EOCrossClient, STRATEGY_SHORT, caseStrategy, eoOutlook, type EoOutlook } from './eocross';
import { applyMoves, canonical, crossTail, fbPlan, randomScramble, solveEO, type Group, type SolutionSet } from './solver';

interface Settings { count: 'on' | 'off'; mark: 'on' | 'off'; view: '3d' | 'net'; target: string; goal: 'eo' | 'cross' }
const SETTINGS_KEY = 'zz-eo-settings';
const PER_GROUP = 6;

const GOALS = {
  eo: { name: 'EO', solved: (st: EdgeState) => eoSolved(st) },
  cross: { name: 'EOCross', solved: (st: EdgeState) => eoSolved(st) && crossSolved(st) },
};

export function mountEO(root: HTMLElement): Stage {
  const settings: Settings = { count: 'off', mark: 'off', view: '3d', target: 'any', goal: 'eo' };
  try { Object.assign(settings, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')); } catch { /* no storage */ }
  const saveSettings = () => { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* no storage */ } };
  const goal = () => GOALS[settings.goal] ?? GOALS.eo;

  const drill: Drill = mountDrill(root, {
    id: 'eo', title: 'EO trainer', blurb: '', newLabel: 'New scramble',
    hints: [{ key: 'bad', label: 'Hint: bad edges' }, { key: 'len', label: 'Hint: move count' }, { key: 'plan', label: 'Hint: F/B plan' }],
    afterHints: '<div class="eo-note eo-stratnote" id="eo-strat" hidden></div>',
    movesLabel: 'Moves you did (EO, then the cross)', placeholder: "e.g. F R' B U F  R2 D L' D2",
    note: 'Solve EO on your cube (then the cross if you want to carry on into F2L). Space starts and stops the timer.',
    showLabel: 'Show optimal EO solutions',
    left: `
      <div class="eo-stage"><svg id="eo-cube" viewBox="-170 -170 340 340" aria-label="cube"></svg></div>
      <div class="eo-corner">
        <button id="eo-peekBack" class="btn" type="button" title="Look at the back">Peek back</button>
        <button id="eo-resetView" class="btn" type="button" title="Reset view">Reset view</button>
        <span class="eo-hint" id="eo-hint">or drag to rotate</span>
      </div>
      <div class="eo-status"><div class="eo-bad" id="eo-bad"></div><div class="eo-timer" id="eo-timer">0.00</div></div>
      <div class="eo-scramble" id="eo-scramble"></div>
      <p class="eo-note" id="eo-orient"></p>`,
  }, { onNew: newScramble, onCheck: check, onHint: hintText, onShow: onShow, onHintsClick: onHintsClick, onKey: onKey, onClear: () => { shown = null; render(); } });
  // the strategy chips sit with the hints but toggle a note instead of revealing anything about the scramble
  drill.$('hints').insertAdjacentHTML('beforeend',
    '<button type="button" class="eo-chip eo-strat" data-strat="short" hidden>Hint: EOCross strategy</button>' +
    '<button type="button" class="eo-chip eo-strat" data-strat="long" hidden>Strategy for this scramble</button>');
  const svg = drill.$('cube') as unknown as SVGSVGElement;

  // ---- state ----
  let scramble = '';           // trainer frame (white down, chosen colour front)
  let facelets = '';           // the scramble's state
  let start: EdgeState = { eo: 0, slots: [4, 5, 6, 7] };
  let shown: string | null = null; // facelets after the moves typed, once checked
  let solution: SolutionSet = solveEO(0);
  let xsol: SolutionSet | null = null;   // every optimal EOCross solution, from the worker
  let outlook: EoOutlook | null = null;
  let assisted = false, recorded = false;
  const results: { t: number; n: number; opt: number }[] = [];
  const view: View = { ...DEFAULT_VIEW };
  const xc = new EOCrossClient();
  xc.onStatus = onXStatus;

  const goalSol = () => (settings.goal === 'cross' ? xsol : solution);
  const solLabel = () => `${drill.showOpen() ? 'Hide' : 'Show'} optimal ${goal().name} solutions`;

  function requestCross(): void {
    const mine = facelets;
    outlook = null;
    xc.solve(start).then(async (r) => {
      if (mine !== facelets) return;
      xsol = r; onXStatus();
      const o = await eoOutlook(xc, start, solution, r.length);
      if (mine !== facelets) return;
      outlook = o; onXStatus();
    }).catch(() => undefined);
  }

  function load(scr: string): void {
    scramble = scr.trim();
    facelets = state(scramble);
    start = edgeState(facelets);
    shown = null;
    solution = solveEO(start.eo);
    xsol = null; assisted = false; recorded = false;
    if (settings.goal === 'cross' || xc.status !== 'off') requestCross();
    drill.begin();
    drill.setShowLabel(solLabel());
    resetStrategy();
    render();
  }

  function newScramble(): void {
    // a scramble with the wanted number of bad edges (any = at least two)
    for (let attempt = 0; attempt < 400; attempt++) {
      const seq = randomScramble();
      const bad = stageOf(state(movesStr(seq))).eoBad;
      if (settings.target === 'any' ? bad >= 2 : bad === Number(settings.target)) { load(movesStr(seq)); return; }
    }
    load(movesStr(randomScramble()));
  }

  // ---- check the moves typed after solving on the real cube ----
  function check(txt: string): void {
    let toks: string[];
    try { toks = tokens(txt); } catch (err) { drill.flash(err instanceof Error ? err.message : String(err)); return; }
    drill.flash('');
    const after = state(`${scramble} ${toks.join(' ')}`);
    shown = after;
    const { n, t, ts } = drill.attempt(txt);
    const rep = stageOf(after);
    drill.result.handoff.innerHTML = ''; drill.result.body.innerHTML = '';
    if (rep.eoBad > 0) {
      drill.result.show(`EO not solved yet: ${rep.eoBad} bad edge${rep.eoBad === 1 ? '' : 's'}`, 'The cube shows the state after your moves. Turn on the marks under Settings to see which edges are wrong.');
      render(); return;
    }
    const done = settings.goal === 'cross' ? rep.cross === 4 : true;
    if (done && !recorded) { recorded = true; results.push({ t: t ?? 0, n, opt: settings.goal === 'cross' && xsol ? xsol.length : solution.length }); }
    const optX = xsol ? `, optimal EOCross is ${xsol.length}` : '';
    if (rep.cross < 4) {
      drill.result.show(`EO solved${ts}`, `${n} moves so far (optimal EO is ${solution.length}${optX}). Cross is ${rep.cross}/4: add the cross moves to hand the cube to F2L.`);
      render(); return;
    }
    drill.result.show(`EOCross done in ${n} moves${ts}`, `Optimal EO alone is ${solution.length} moves${optX}.${assisted ? ' You peeked at a solution.' : ''}`);
    const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'btn eo-primary'; btn.style.marginTop = '8px';
    btn.textContent = 'Continue to F2L with this cube';
    btn.addEventListener('click', () => { stages.f2l?.load(`${scramble} ${toks.join(' ')}`); showTab('f2l'); window.scrollTo({ top: 0 }); });
    drill.result.handoff.appendChild(btn);
    render();
  }

  /** The moves in the box up to the point the goal is first reached, or null if they aren't plain face turns. */
  function userSolve(): Move[] | null {
    let ms: Move[] | null;
    try { ms = faceMoves(drill.moves()); } catch { return null; }
    if (!ms) return null;
    let st = start;
    const path: Move[] = [];
    for (const m of ms) {
      if (goal().solved(st)) break;
      st = applyMoves(st, [m]); path.push(m);
    }
    return goal().solved(st) ? path : null;
  }

  // ---- the solutions list ----
  const groupOf = (moves: readonly Move[]): Group => (settings.goal === 'cross' ? crossTail(moves) : fbPlan(start, moves));

  function showSolutions(): void {
    const el = drill.result.body;
    el.innerHTML = ''; el.className = 'eo-sol';
    const gs = goalSol();
    if (!gs) { drill.result.show(`Optimal ${goal().name}`, xc.note()); return; }
    // one line per family; the group is read off the reordered moves (F' B' and B' F' are one line, so
    // they must be one group too); a family whose starred directions would give different groups is filed
    // under its first member's
    const fam = new Map<string, { n: number; group: Group }>();
    let starred = false;
    for (const sol of gs.solutions) {
      const c = canonical(start, sol, goal().solved);
      const f = fam.get(c.txt);
      if (f) { f.n++; continue; }
      fam.set(c.txt, { n: 1, group: groupOf(c.moves) });
      if (c.starred.some(Boolean)) starred = true;
    }
    const groups = new Map<string, { group: Group; lines: Map<string, number> }>();
    for (const [txt, f] of fam) {
      const g = groups.get(f.group.key) ?? { group: f.group, lines: new Map() };
      groups.set(f.group.key, g); g.lines.set(txt, f.n);
    }
    const mine = userSolve();
    const mineTxt = mine && mine.length === gs.length ? canonical(start, mine, goal().solved).txt : null;
    const total = gs.count, listed = gs.solutions.length, families = fam.size;
    drill.result.show(`Optimal ${goal().name}: ${gs.length} moves`,
      `${total} optimal solution${total === 1 ? '' : 's'}${gs.truncated ? ` (first ${listed} listed)` : ''}${families < listed ? `, ${families} line${families === 1 ? '' : 's'} once turns that work either way (*) and commuting pairs are merged` : ''}.${mineTxt ? ' Yours is marked.' : ''}`);
    const order = [...groups.values()].sort((a, b) => (settings.goal === 'cross' ? a.group.order - b.group.order : b.lines.size - a.lines.size));
    for (const g of order) {
      const box = document.createElement('div'); box.className = 'grp';
      if (order.length > 1 || g.group.text) { const h = document.createElement('div'); h.className = 'grp-h'; h.textContent = `${g.group.text || 'no F/B turns'} · ${g.lines.size} line${g.lines.size === 1 ? '' : 's'}`; box.appendChild(h); }
      const lines = [...g.lines.entries()].sort((a, b) => Number(b[0] === mineTxt) - Number(a[0] === mineTxt) || b[1] - a[1] || a[0].localeCompare(b[0]));
      lines.forEach(([txt], i) => {
        const d = document.createElement('div'); d.textContent = txt; d.dataset.alg = txt.replace(/\*/g, '');
        if (txt === mineTxt) { const y = document.createElement('em'); y.className = 'yours'; y.textContent = 'yours'; d.appendChild(y); }
        if (i >= PER_GROUP) d.hidden = true;
        box.appendChild(d);
      });
      if (lines.length > PER_GROUP) {
        const b = document.createElement('button'); b.type = 'button'; b.className = 'eo-link'; b.textContent = `Show ${lines.length - PER_GROUP} more`;
        b.addEventListener('click', () => { box.querySelectorAll<HTMLElement>('div[data-alg]').forEach((d) => { d.hidden = false; }); b.remove(); });
        box.appendChild(b);
      }
      el.appendChild(box);
    }
    const n = document.createElement('p'); n.style.cssText = 'margin:6px 0 0;font-size:13px;color:var(--ink-2)';
    n.textContent = `${starred ? 'A * means that turn works in either direction (in any combination). ' : ''}Tap one to put it in the moves box.`;
    el.appendChild(n);
  }

  function onShow(open: boolean): void {
    drill.setShowLabel(solLabel());
    if (!open) { drill.result.body.className = ''; return; }
    assisted = true;
    showSolutions();
  }

  // ---- hints ----
  function hintText(kind: string): string {
    if (kind === 'bad') { const b = stageOf(facelets).eoBad; return `${b} bad edge${b === 1 ? '' : 's'}`; }
    if (kind === 'len') return settings.goal === 'cross' ? `EO ${solution.length} · EOCross ${xsol ? xsol.length : '…'}` : `${solution.length} moves`;
    assisted = true;
    const gs = goalSol();
    if (!gs) return xc.note();
    const seen = new Set<string>(), plans: string[] = [];
    for (const sol of gs.solutions) { const p = fbPlan(start, sol); if (seen.has(p.key)) continue; seen.add(p.key); plans.push(p.text); }
    return plans.filter(Boolean).join(' · ') || 'no F/B turns needed';
  }
  const stratChips = () => [...root.querySelectorAll<HTMLButtonElement>('.eo-strat')];
  function resetStrategy(): void {
    // the strategy note is scramble-independent in the short form and only follows the goal
    stratChips().forEach((b) => { b.hidden = settings.goal !== 'cross'; });
    if (settings.goal !== 'cross') { drill.$('strat').hidden = true; stratChips().forEach((b) => b.classList.remove('open')); }
  }
  function renderStrategy(): void {
    const open = stratChips().find((b) => b.classList.contains('open'));
    if (!open) return;
    const note = drill.$('strat');
    note.innerHTML = open.dataset.strat === 'short' ? STRATEGY_SHORT : xsol ? caseStrategy(start, solution, xsol, outlook) : `<p style="margin:0">${xc.note()}</p>`;
    note.hidden = false;
  }
  function onHintsClick(t: HTMLElement): boolean {
    const s = t.closest<HTMLButtonElement>('.eo-strat');
    if (!s) return false;
    const open = s.classList.contains('open');
    stratChips().forEach((x) => x.classList.remove('open'));
    if (open) drill.$('strat').hidden = true; else { s.classList.add('open'); renderStrategy(); }
    return true;
  }
  function onXStatus(): void {
    if (drill.showOpen()) showSolutions();
    renderStrategy();
    drill.refreshHints();
  }

  // ---- picture and text ----
  function render(): void {
    const f = shown ?? facelets;
    if (!f) return;
    const marks = settings.mark === 'on' ? badEdgePositions(f) : new Set<string>();
    const cells: Cell[] = STICKERS.map((s) => ({ fill: faceHex(f[s.idx]), mark: marks.has(key(s.pos)) }));
    if (settings.view === '3d') render3d(svg, cells, view); else renderNet(svg, cells);
    const rep = stageOf(f), el = drill.$('bad');
    if (settings.count === 'on') { el.innerHTML = rep.eoBad === 0 ? `<b>EO solved</b> · cross ${rep.cross}/4` : `<b>${rep.eoBad}</b> bad edge${rep.eoBad === 1 ? '' : 's'}`; el.classList.toggle('zero', rep.eoBad === 0); }
    else { el.innerHTML = shown ? '<span style="color:var(--ink-2)">after your moves</span>' : ''; el.classList.remove('zero'); }
    drill.$('scramble').innerHTML = 'Scramble: <span></span>';
    drill.$('scramble').querySelector('span')!.textContent = toWca(scramble);
    drill.$('orient').textContent = `Apply it to a solved cube held ${WCA_HOLD} (the standard scrambling orientation). Then turn it white down with ${faceColorName('F')} facing you (${faceColorName('R')} on the right), the way you hold it for F2L: the picture shows what you should see.`;
    drill.$('sub').textContent = `Orient every edge to the ${faceColorName('F')}/${faceColorName('B')} axis${settings.goal === 'cross' ? ' and build the white cross' : ''}. White down, ${faceColorName('F')} facing you.`;
    for (const id of ['peekBack', 'resetView', 'hint']) drill.$(id).style.display = settings.view === '3d' ? '' : 'none';
    if (results.length) {
      const mt = results.reduce((a, r) => a + r.t, 0) / results.length, mn = results.reduce((a, r) => a + r.n, 0) / results.length, mo = results.reduce((a, r) => a + r.opt, 0) / results.length;
      drill.setStats(`This session: ${results.length} solved, mean ${mt.toFixed(2)}s, ${mn.toFixed(1)} moves (optimal ${goal().name} mean ${mo.toFixed(1)}).`);
    } else drill.setStats('');
  }
  function onKey(ev: KeyboardEvent): boolean {
    if (ev.key.toLowerCase() !== 'm') return false;
    settings.mark = settings.mark === 'on' ? 'off' : 'on'; syncSeg(); saveSettings(); render();
    return true;
  }
  drill.$('resetView').onclick = () => { Object.assign(view, DEFAULT_VIEW); render(); };
  drill.$('peekBack').onclick = () => { view.rx = 28; view.ry = view.ry > 0 ? 135 : -135; render(); };
  orbit(svg, view, () => { if (settings.view === '3d') render(); }, () => settings.view === '3d');
  onSchemeChange(render);

  // ---- settings (the segments live in the settings sheet) ----
  const segs = () => [...document.querySelectorAll<HTMLElement>('#eo-settings .eo-seg')];
  function syncSeg(): void {
    segs().forEach((seg) => seg.querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.classList.toggle('on', b.dataset.v === settings[seg.dataset.set as keyof Settings])));
  }
  function goalChanged(): void {
    if (settings.goal === 'cross' && !xsol) requestCross();
    drill.resetHints(); drill.setShowLabel(solLabel()); resetStrategy(); onXStatus(); render();
  }
  segs().forEach((seg) => seg.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button'); if (!b) return;
    (settings as unknown as Record<string, string>)[seg.dataset.set!] = b.dataset.v!;
    syncSeg(); saveSettings();
    if (seg.dataset.set === 'target') newScramble(); else if (seg.dataset.set === 'goal') goalChanged(); else render();
  }));
  syncSeg();
  newScramble();
  drill.setShowLabel(solLabel());

  return { load, render, scramble: () => scramble, newScramble };
}
