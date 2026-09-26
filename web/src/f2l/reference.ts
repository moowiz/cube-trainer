// The F2L case reference: one slot's 83 cases (the four slots are mirrors,
// so the sheet shows the one you are solving) with the pair pictured where
// it is, the alg the finder leads with (a star makes any of a case's algs
// that one), your note on each alg, the other algs folded, and the case sent
// to the finder or played in 3D. Organised the way the ZZF2L sheet is: by
// section (last slot; edge, corner or both in a slot), then by where the
// corner is and which way its white faces - and filtered by any of that.
// The sheet itself (the cards' parts, the wiring) is ui/refsheet.ts, shared
// with the last-layer drills' sheet.

import { moveCount } from '../cube/alg';
import { render3d } from '../cube/render';
import { state } from '../cube/state';
import { esc } from '../ui/dom';
import { algHtml, altsHtml, chipHtml, foldOpen, nameBoxHtml, noteHtml, openRefSheet, starHtml } from '../ui/refsheet';
import { DATA } from './data';
import {
  allAlgs, caseId, caseOf, type CornerOrient, describe, type F2LCase, f2lIsFavourite, f2lMainAlg, fullAlg, invert, isSlot, normalizeAlg, SLOT_WORD, SLOTS, type SlotName, withAuf,
} from './model';
import { caseCells, SLOT_VIEW } from './pic';

const SECTIONS: readonly F2LCase['section'][] = ['Last slot', 'Edge in slot', 'Corner in slot', 'Both in slot'];
const SECTION_BLURB: Record<F2LCase['section'], string> = {
  'Last slot': 'both pieces out: on top, or in this very slot',
  'Edge in slot': 'the edge sits in another slot',
  'Corner in slot': 'the corner sits in another slot',
  'Both in slot': 'both pieces sit in other slots',
};
const WHITE: Record<CornerOrient, string> = { fb: 'white facing front/back', rl: 'white facing right/left', ud: 'white facing up/down' };

/** Where a case's corner is: on top, in the pair's own slot, or in another one. */
const cornerPlace = (slot: SlotName, c: F2LCase): 'top' | 'own' | 'other' => (c.corner.startsWith('U') ? 'top' : c.corner.slice(1) === slot ? 'own' : 'other');
const edgePlace = (slot: SlotName, c: F2LCase): 'top' | 'own' | 'other' => (c.edge.startsWith('U') ? 'top' : c.edge === slot ? 'own' : 'other');
const PLACE_WORD = { top: 'on top', own: 'in its slot', other: 'in another slot' } as const;
const SIMPLE = /^[RLU][2']*$/;
const isSimple = (a: string) => normalizeAlg(a).split(' ').every((t) => SIMPLE.test(t));

// ---- the filters: each chip is a predicate on a case; a case shows when every chip on matches ----
interface Filter { key: string; group: string; label: string; test(slot: SlotName, c: F2LCase): boolean }
const FILTERS: Filter[] = [
  ...SECTIONS.map((s): Filter => ({ key: `sec-${s}`, group: 'Section', label: s.toLowerCase(), test: (_slot, c) => c.section === s })),
  ...(['fb', 'rl', 'ud'] as const).map((o): Filter => ({ key: `co-${o}`, group: "Corner's white", label: WHITE[o].replace('white facing ', ''), test: (_slot, c) => c.co === o })),
  ...(['top', 'own', 'other'] as const).map((p): Filter => ({ key: `c-${p}`, group: 'Corner', label: PLACE_WORD[p], test: (slot, c) => cornerPlace(slot, c) === p })),
  ...(['top', 'own', 'other'] as const).map((p): Filter => ({ key: `e-${p}`, group: 'Edge', label: PLACE_WORD[p], test: (slot, c) => edgePlace(slot, c) === p })),
  { key: 'a-simple', group: 'Algs', label: 'R/L/U only', test: (slot, c) => isSimple(f2lMainAlg(caseId(slot, c.n)) ?? c.algs[0]!) },
  { key: 'a-short', group: 'Algs', label: 'a slot shortcut', test: (_slot, c) => c.others.length > 0 },
  { key: 'a-key', group: 'Algs', label: 'keyhole', test: (_slot, c) => /keyhole/i.test(c.note) },
  { key: 'a-fav', group: 'Algs', label: 'your pick', test: (slot, c) => f2lIsFavourite(caseId(slot, c.n)) },
];

/** Does a case match the name box? Each word is a case number (exact) or a word of its description or note (prefix). */
function matches(slot: SlotName, c: F2LCase, pattern: string): boolean {
  const words = pattern.toLowerCase().split(/[\s,]+/).filter(Boolean);
  if (!words.length) return true;
  const text = `${c.section} ${describe({ pos: c.corner, o: c.co }, c.edge)} ${c.note} ${c.corner} ${c.edge}`.toLowerCase();
  return words.some((w) => (/^\d+$/.test(w) ? c.n === Number(w) : text.split(/[^a-z0-9/-]+/).some((t) => t.startsWith(w))));
}

/** An alg as the sheet writes it, its AUF in brackets and its triggers labelled. */
function f2lAlgHtml(a: string): string {
  const { pre, rest } = withAuf('', a);
  return `${pre ? `<span class="llr-auf">(${esc(pre)})</span> ` : ''}${algHtml(normalizeAlg(rest))}`;
}

/** The order the cases are listed in: by section, then the corner's place and orientation, then the edge's, then number. */
function order(slot: SlotName, c: F2LCase): string {
  const p = { top: 0, own: 1, other: 2 };
  return `${SECTIONS.indexOf(c.section)}${p[cornerPlace(slot, c)]}${['fb', 'rl', 'ud'].indexOf(c.co)}${p[edgePlace(slot, c)]}${String(c.n).padStart(3, '0')}`;
}
/** The sub-heading a case sits under: where its corner is, and which way its white faces. */
const subhead = (slot: SlotName, c: F2LCase): string => `Corner ${PLACE_WORD[cornerPlace(slot, c)]}, ${WHITE[c.co]}`;

/**
 * Open the reference sheet on `slot`; `pick(slot, case)` is called when a case's "Set in finder" is
 * tapped, `changed` when a case's main alg changes (the finder's case may be showing the old one).
 */
export function openF2LReference(slot: SlotName, pick: (slot: SlotName, c: F2LCase) => void, changed?: () => void): void {
  let shownSlot = slot;
  const active = new Set<string>();
  let namePat = '';
  const cases = () => Object.values(DATA.slots[shownSlot].cases);
  const shown = (c: F2LCase) => matches(shownSlot, c, namePat) && FILTERS.every((x) => !active.has(x.key) || x.test(shownSlot, c));
  const filterBar = () => {
    const slots = SLOTS.map((s) => `<button type="button" class="eo-chip${s === shownSlot ? ' on' : ''}" data-filter="slot-${s}">${SLOT_WORD[s]}</button>`).join('');
    const count = (x: Filter) => cases().filter((c) => matches(shownSlot, c, namePat) && x.test(shownSlot, c) && FILTERS.every((y) => y === x || !active.has(y.key) || y.test(shownSlot, c))).length;
    let group = '', chips = '';
    for (const x of FILTERS) {
      if (x.group !== group) { chips += `${group ? '<span class="gap"></span>' : ''}<span class="lbl">${esc(x.group)}</span>`; group = x.group; }
      chips += chipHtml(x.key, x.label, active.has(x.key), count(x));
    }
    const n = cases().filter(shown).length;
    return `<div class="llr-filters"><span class="lbl">Slot</span>${slots}<span class="gap"></span>${nameBoxHtml(namePat, '4 12, keyhole, UB')}
      <details class="llr-feats llr-fold" id="f2lr-feats"${foldOpen('f2lr-feats') ? ' open' : ''}><summary>By section, corner, edge and alg${active.size ? ` · ${active.size} on` : ''}</summary><div class="llr-chips">${chips}</div></details></div>
      <p class="llr-count">${active.size || namePat ? `${n} of ${cases().length} cases match${n ? '' : ': nothing has all of that'}.` : 'The four slots are mirrors of each other: pick the one you are solving. Type a case number or a word (keyhole, UB) or tap the chips to narrow the list; a case shows when it matches every chip that is on.'}</p>`;
  };
  const card = (c: F2LCase): string => {
    const id = caseId(shownSlot, c.n);
    const main = f2lMainAlg(id) ?? c.algs[0]!;
    const fav = f2lIsFavourite(id);
    const alts = allAlgs(c).filter((a) => a !== main).map((a) => {
      const o = c.others.find((x) => x.alg === a);
      return { alg: a, note: o ? `uses the ${o.free.map((s) => SLOT_WORD[s]).join(' and ')} slot${o.free.length > 1 ? 's' : ''}, which must be open or solved` : a === c.simple && c.simple_src === 'search' ? 'R/L/U only, found by search (not in the sheet)' : c.algs.includes(a) ? 'from the sheet' : '' };
    });
    const altsBox = altsHtml('f2l', id, alts, `case ${c.n}`, f2lAlgHtml);
    const tags = [c.section.toLowerCase(), c.note ? (/keyhole/i.test(c.note) ? 'keyhole' : c.note) : ''].filter(Boolean).join(' · ');
    return `<div class="llr-case" data-id="${esc(id)}">
      <div class="llr-head">
        <div class="llr-3d"><svg viewBox="-170 -170 340 340" data-pic="${esc(id)}" aria-label="case ${c.n}"></svg></div>
        <div>
          <div class="llr-name">Case ${c.n}<small>${moveCount(fullAlg('', main))} moves</small>${fav ? '<small>your pick</small>' : ''}</div>
          <div class="llr-hint">${esc(describe({ pos: c.corner, o: c.co }, c.edge))}</div>
        </div>
      </div>
      <div class="llr-alg">${f2lAlgHtml(main)}${alts.length ? starHtml(main, true) : ''}</div>
      ${noteHtml('f2l', id, main, `case ${c.n}`)}
      ${altsBox}
      <div class="llr-foot"><button type="button" class="llr-drill" data-go="${esc(id)}">Set in finder</button><button type="button" class="llr-play" data-play="${esc(id)}">▶ play it in 3D</button><span class="llr-tags">${esc(tags)}</span></div>
      <div class="llr-player"></div>
    </div>`;
  };
  const render = () => {
    const list = cases().filter(shown).sort((a, b) => order(shownSlot, a).localeCompare(order(shownSlot, b)));
    let out = filterBar();
    let sec: F2LCase['section'] | null = null, sub: string | null = null, grid = false;
    const closeGrid = () => { if (grid) { out += '</div>'; grid = false; } };
    for (const c of list) {
      if (c.section !== sec) {
        closeGrid(); sec = c.section; sub = null;
        out += `<h3 class="llr-group">${esc(sec)}<small>${cases().filter((x) => x.section === sec && shown(x)).length} of ${cases().filter((x) => x.section === sec).length} · ${esc(SECTION_BLURB[sec])}</small></h3>`;
      }
      const sh = subhead(shownSlot, c);
      if (sh !== sub) { closeGrid(); sub = sh; out += `<p class="llr-sub">${esc(sh)}</p>`; }
      if (!grid) { out += '<div class="llr-grid">'; grid = true; }
      out += card(c);
    }
    closeGrid();
    return out;
  };
  openRefSheet({
    kind: 'f2l',
    title: `ZZF2L: the ${cases().length} cases of a slot`,
    sub: 'Each case as it looks from the front, the pair marked (its white sticker white), the open slots grey. Set in finder puts the case on the finder; a star makes an alg the one the finder leads with and solves the pair with on "Solved, next pair".',
    render,
    mounted: (panel) => {
      for (const svg of panel.querySelectorAll<SVGSVGElement>('svg[data-pic]')) {
        const hit = caseOf(svg.dataset.pic!);
        if (hit) render3d(svg, caseCells(hit.slot, { pos: hit.c.corner, o: hit.c.co }, hit.c.edge, [hit.slot]), SLOT_VIEW[hit.slot]);
      }
    },
    onFilter: (k) => {
      if (k.startsWith('slot-')) { const s = k.slice(5); if (isSlot(s)) shownSlot = s; return; }
      if (active.has(k)) active.delete(k); else active.add(k);
    },
    onName: (v) => { namePat = v; },
    onGo: (id) => { const hit = caseOf(id); if (hit) pick(hit.slot, hit.c); },
    playFor: (id) => {
      const hit = caseOf(id);
      if (!hit) return null;
      const alg = fullAlg('', f2lMainAlg(id) ?? hit.c.algs[0]!);
      return { alg, setup: state(invert(alg)) };
    },
    onFavChange: changed,
  });
}
