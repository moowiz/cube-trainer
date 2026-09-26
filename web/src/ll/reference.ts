// The last-layer case reference: every OCLL or PLL case with its picture,
// its alg (triggers labelled), what to look for, and what it chains to -
// the case a solved cube is at after the alg, so two cases can be drilled
// back to back with no scramble. Tapping a case drills it; its "play"
// button opens the 3D player in the card instead. The sheet itself (the
// cards' parts, the stars, the notes, the wiring) is ui/refsheet.ts, shared
// with the F2L finder's sheet.

import { inverse, moveCount } from '../cube/alg';
import { state } from '../cube/state';
import { CASES, isFavourite, type LLCase, type LLKind, matchesName } from './cases';
import { algAngle, features, type Features } from './features';
import { chainPartner } from './model';
import { ensurePicStyle, picSvg } from './pic';
import { esc } from '../ui/dom';
import { algHtml, altsHtml, chipHtml, foldOpen, nameBoxHtml, noteHtml, openRefSheet, starHtml } from '../ui/refsheet';

export { algHtml };

const TITLE: Record<LLKind, string> = { ocll: 'OCLL', pll: 'PLL' };

// ---- the filters: each chip is a predicate on a case's features; a case shows when every chip on matches ----
interface Filter { key: string; group: string; label: string; test(f: Features): boolean }
const FILTERS: Filter[] = [
  { key: 'c-solved', group: 'Corners', label: 'solved', test: (f) => f.corners === 'solved' },
  { key: 'c-3', group: 'Corners', label: '3-cycle', test: (f) => f.corners === '3-cycle' },
  { key: 'c-adj', group: 'Corners', label: 'adjacent swap', test: (f) => f.corners === 'adjacent swap' },
  { key: 'c-diag', group: 'Corners', label: 'diagonal swap', test: (f) => f.corners === 'diagonal swap' },
  { key: 'c-2', group: 'Corners', label: 'two swaps', test: (f) => f.corners === 'two swaps' },
  { key: 'e-solved', group: 'Edges', label: 'solved', test: (f) => f.edges === 'solved' },
  { key: 'e-3', group: 'Edges', label: '3-cycle', test: (f) => f.edges === '3-cycle' },
  { key: 'e-adj', group: 'Edges', label: 'adjacent swap', test: (f) => f.edges === 'adjacent swap' },
  { key: 'e-opp', group: 'Edges', label: 'opposite swap', test: (f) => f.edges === 'opposite swap' },
  { key: 'e-2', group: 'Edges', label: 'two swaps', test: (f) => f.edges === 'two swaps' },
  { key: 's-bar3', group: 'Sides', label: 'a bar of three', test: (f) => f.sides.bar3 > 0 },
  { key: 's-head', group: 'Sides', label: 'headlights', test: (f) => f.sides.headlights > 0 },
  { key: 's-nohead', group: 'Sides', label: 'no headlights', test: (f) => f.sides.headlights === 0 },
  { key: 's-bar2', group: 'Sides', label: 'a bar of two', test: (f) => f.sides.bar2 > 0 },
  { key: 's-nobar', group: 'Sides', label: 'no bars at all', test: (f) => f.sides.bar2 === 0 && f.sides.bar3 === 0 },
  { key: 's-blank', group: 'Sides', label: 'a side with nothing', test: (f) => f.sides.none > 0 },
];

/** The tag line under a case: its cycle types and what its sides show, with counts. */
function tagLine(f: Features): string {
  const sides = [f.sides.bar3 && `bar of three ×${f.sides.bar3}`, f.sides.headlights && `headlights ×${f.sides.headlights}`, f.sides.bar2 && `bar of two ×${f.sides.bar2}`, f.sides.none && `nothing ×${f.sides.none}`].filter(Boolean).join(', ');
  return `corners ${f.corners} · edges ${f.edges} · ${sides}`;
}

/** The chain summary: cases that undo themselves, pairs that undo each other, and one-way chains (an alg that permutes too). */
export function chainSummary(kind: LLKind): { self: LLCase[]; pairs: [LLCase, LLCase][]; oneWay: [LLCase, LLCase][] } {
  const self: LLCase[] = [], pairs: [LLCase, LLCase][] = [], oneWay: [LLCase, LLCase][] = [];
  const seen = new Set<string>();
  for (const c of CASES[kind]) {
    const p = chainPartner(kind, c);
    if (!p) continue;
    if (p.id === c.id) self.push(c);
    else if (chainPartner(kind, p)?.id === c.id) { if (!seen.has(c.id)) { pairs.push([c, p]); seen.add(p.id); } }
    else oneWay.push([c, p]);
    seen.add(c.id);
  }
  return { self, pairs, oneWay };
}

/**
 * Open the reference sheet for `kind`; `drill(setup)` is called with a case's setup alg when one is tapped,
 * `changed` when a case's main alg is changed with the star (the drill's case may be showing the old one).
 */
export function openLLReference(kind: LLKind, drill: (setup: string) => void, changed?: () => void): void {
  ensurePicStyle();
  const feats = () => new Map(CASES[kind].map((c) => [c.id, features(state(inverse(c.alg)))]));
  let feat = feats();
  const active = new Set<string>();
  let namePat = ''; // the name box: "G", "R*", "Ja Jb"
  const shown = (c: LLCase) => { const f = feat.get(c.id); return matchesName(c, namePat) && (!f || FILTERS.every((x) => !active.has(x.key) || x.test(f))); };
  const filterBar = () => {
    const nameBox = nameBoxHtml(namePat, 'G, R*, Ja Jb');
    if (kind !== 'pll') return `<div class="llr-filters">${nameBox}</div>`;
    const count = (x: Filter) => CASES[kind].filter((c) => { const f = feat.get(c.id); return f && matchesName(c, namePat) && x.test(f) && FILTERS.every((y) => y === x || !active.has(y.key) || y.test(f)); }).length;
    let group = '', chips = '';
    for (const x of FILTERS) {
      if (x.group !== group) { chips += `${group ? '<span class="gap"></span>' : ''}<span class="lbl">${x.group}</span>`; group = x.group; }
      chips += chipHtml(x.key, x.label, active.has(x.key), count(x));
    }
    // the piece and side chips fold away (user, 2026-09-24: rarely used); open or closed is remembered
    const out = `<div class="llr-filters">${nameBox}<details class="llr-feats llr-fold" id="llr-feats"${foldOpen('llr-feats') ? ' open' : ''}><summary>By corners, edges and sides${active.size ? ` · ${active.size} on` : ''}</summary><div class="llr-chips">${chips}</div></details>`;
    const n = CASES[kind].filter(shown).length;
    return `${out}</div><p class="llr-count">${active.size || namePat ? `${n} of ${CASES[kind].length} cases match${n ? '' : ': nothing has all of that'}.` : 'Type a name (G, R*, Ja Jb) or tap the chips to narrow the list; a case shows when it matches every chip that is on.'}</p>`;
  };
  const render = () => {
    const { self, pairs, oneWay } = chainSummary(kind);
    const names = (cs: LLCase[]) => cs.map((c) => `<b>${esc(c.name)}</b>`).join(', ');
    return `
      <p class="llr-chains">${[
        pairs.length ? `Chains: ${pairs.map(([a, b]) => `<b>${esc(a.name)}</b> ↔ <b>${esc(b.name)}</b>`).join(', ')}` : '',
        self.length ? `their own inverse: ${names(self)}` : '',
        oneWay.length ? `one way: ${oneWay.map(([a, b]) => `<b>${esc(a.name)}</b> → <b>${esc(b.name)}</b>`).join(', ')}` : '',
      ].filter(Boolean).join(' · ')}.</p>
      ${filterBar()}
      <div class="llr-grid">${CASES[kind].filter(shown).map((c) => {
        const p = chainPartner(kind, c);
        const f = feat.get(c.id);
        const chain = !p ? '' : `<span class="llr-chain" title="${p.id === c.id ? 'The alg again solves it' : 'After the alg, that is the case on the cube'}">${p.id === c.id ? '↻ itself' : `↔ ${esc(p.name)}`}</span>`;
        const alts = c.alts ?? [];
        return `<div class="llr-case" data-id="${esc(c.id)}">
          <div class="llr-head">
            <div class="ll-pic"><svg viewBox="0 0 200 200" aria-label="${esc(c.name)}">${picSvg(state(inverse(c.alg)), kind)}</svg></div>
            <div class="llr-name">${esc(c.name)}<small>${moveCount(c.alg)} moves</small>${isFavourite(kind, c.id) ? '<small>your pick</small>' : ''}</div>
            ${chain}
          </div>
          <div class="llr-alg">${algHtml(c.alg)}${alts.length ? starHtml(c.alg, true) : ''}</div>
          <div class="llr-hint">${esc(c.hint[0]!.toUpperCase() + c.hint.slice(1))}.${kind === 'pll' ? ` <b>For the alg:</b> ${esc(algAngle(c))}.` : ''}</div>
          ${noteHtml(kind, c.id, c.alg, c.name)}
          ${altsHtml(kind, c.id, alts, `this ${c.name}`)}
          <div class="llr-foot"><button type="button" class="llr-drill" data-go="${esc(c.id)}">Drill this case</button><button type="button" class="llr-play" data-play="${esc(c.id)}">▶ play it in 3D</button>${f ? `<span class="llr-tags">${esc(tagLine(f))}</span>` : ''}</div>
          <div class="llr-player"></div>
        </div>`;
      }).join('')}</div>`;
  };
  const caseOf = (id: string) => CASES[kind].find((x) => x.id === id);
  openRefSheet({
    kind,
    title: `${TITLE[kind]}: the ${CASES[kind].length} cases`,
    sub: kind === 'pll'
      ? 'The arrows show where each piece goes. Drill this case sets the drill on it, a star makes an alg the one the drill uses. A chain is what an alg leaves on a solved cube: those two drill back to back, no scramble.'
      : 'Each case as it looks from the front, any permutation. Drill this case sets the drill on it, a star makes an alg the one the drill uses. A chain is what an alg leaves on a solved cube: those two drill back to back, no scramble.',
    render,
    onFilter: (k) => { if (active.has(k)) active.delete(k); else active.add(k); },
    onName: (v) => { namePat = v; },
    onGo: (id) => { const c = caseOf(id); if (c) drill(inverse(c.alg)); },
    playFor: (id) => { const c = caseOf(id); return c ? { alg: c.alg, setup: state(inverse(c.alg)) } : null; },
    onFavChange: () => { feat = feats(); changed?.(); },
  });
}
