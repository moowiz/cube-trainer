// The F2L case reference: one slot's 83 cases (the four slots are mirrors,
// so the sheet shows the one you are solving) with the pair pictured where
// it is, the alg the finder leads with (a star makes any of a case's algs
// that one), your note on each alg, the other algs folded, and the case sent
// to the finder or played in 3D. Organised by where the pieces are (on top, in
// the pair's own slot, in another), then by which of the corner's stickers
// faces up (or down) - that one does not change with an AUF, where the sheet's
// "white facing right/left" does - and filtered by any of that. A case's number
// is its front-right twin's, the same on every slot; a card can be picked to
// practise (pool.ts), which the finder's targeted scrambles draw from.
// The sheet itself (the cards' parts, the wiring) is ui/refsheet.ts, shared
// with the last-layer drills' sheet.

import { moveCount } from '../cube/alg';
import { render3d } from '../cube/render';
import { state } from '../cube/state';
import { faceColorName } from '../cube/scheme';
import { ensureStyle, esc } from '../ui/dom';
import { algHtml, altsHtml, chipHtml, foldOpen, nameBoxHtml, noteHtml, openRefSheet, starHtml } from '../ui/refsheet';
import { DATA } from './data';
import {
  allAlgs, byLength, caseGroup, caseId, caseOf, describe, type F2LCase, f2lIsFavourite, f2lMainAlg, fullAlg, GROUP_WORD, GROUPS, invert, isSlot, normalizeAlg, pairShape,
  SLOT_WORD, SLOTS, type SlotName, twinOf, withAuf,
} from './model';
import { caseCells, SLOT_VIEW } from './pic';
import { isPicked, pool, setPicks, togglePick } from './pool';

/** Where a case's pieces are: on top, in the pair's own slot, or in another one. */
const cornerPlace = (slot: SlotName, c: F2LCase): 'top' | 'own' | 'other' => (c.corner.startsWith('U') ? 'top' : c.corner.slice(1) === slot ? 'own' : 'other');
const edgePlace = (slot: SlotName, c: F2LCase): 'top' | 'own' | 'other' => (c.edge.startsWith('U') ? 'top' : c.edge === slot ? 'own' : 'other');
const PLACE_WORD = { top: 'on top', own: 'in its slot', other: 'in another slot' } as const;
/**
 * Which of the corner's stickers faces up (on top) or down (in a slot): white, the pair's front/back colour, or its
 * right/left colour. Unlike the sheet's "white facing right/left" (which an AUF turns into front/back) this is the
 * same at every AUF, and the same on the four mirrors.
 */
type Facing = 'white' | 'fb' | 'rl';
function facing(slot: SlotName, c: F2LCase): Facing {
  const letter = DATA.slots[slot].cmap[`${c.corner}-${c.co}`]![c.corner.startsWith('U') ? 'U' : 'D'];
  return letter === 'D' ? 'white' : letter === 'F' || letter === 'B' ? 'fb' : 'rl';
}
/** That sticker in words, by colour: "white up", "green down". */
function facingWord(slot: SlotName, f: Facing, top: boolean | null): string {
  const col = f === 'white' ? 'white' : faceColorName(f === 'fb' ? slot[0] as 'F' | 'B' : slot[1] as 'R' | 'L');
  return top === null ? `${col} up/down` : `${col} ${top ? 'up' : 'down'}`;
}
const SHAPE_WORD = { joined: 'joined as a pair', touching: 'touching, not paired', apart: 'apart' } as const;
const SIMPLE = /^[RLU][2']*$/;
const isSimple = (a: string) => normalizeAlg(a).split(' ').every((t) => SIMPLE.test(t));
const usesFace = (a: string, re: RegExp) => normalizeAlg(a).split(' ').some((t) => re.test(t));

// ---- the filters: each chip is a predicate on a case; a case shows when every chip on matches ----
interface Filter { key: string; group: string; label: (slot: SlotName) => string; test(slot: SlotName, c: F2LCase): boolean }
const mainAlg = (slot: SlotName, c: F2LCase) => f2lMainAlg(caseId(slot, c.n)) ?? c.algs[0]!;
const FILTERS: Filter[] = [
  ...(['top', 'own', 'other'] as const).map((p): Filter => ({ key: `c-${p}`, group: 'Corner', label: () => PLACE_WORD[p], test: (slot, c) => cornerPlace(slot, c) === p })),
  ...(['top', 'own', 'other'] as const).map((p): Filter => ({ key: `e-${p}`, group: 'Edge', label: () => PLACE_WORD[p], test: (slot, c) => edgePlace(slot, c) === p })),
  ...(['white', 'fb', 'rl'] as const).map((f): Filter => ({ key: `w-${f}`, group: 'Corner facing up/down', label: (slot) => facingWord(slot, f, null), test: (slot, c) => facing(slot, c) === f })),
  ...(['joined', 'touching', 'apart'] as const).map((sh): Filter => ({ key: `p-${sh}`, group: 'Both on top', label: () => SHAPE_WORD[sh], test: (slot, c) => pairShape(slot, c) === sh })),
  { key: 'a-simple', group: 'Algs', label: () => 'R/L/U only', test: (slot, c) => isSimple(mainAlg(slot, c)) },
  { key: 'a-d', group: 'Algs', label: () => 'D turns', test: (slot, c) => usesFace(mainAlg(slot, c), /^D/) },
  { key: 'a-fb', group: 'Algs', label: () => 'F/B turns', test: (slot, c) => usesFace(mainAlg(slot, c), /^[FB]/) },
  { key: 'a-wide', group: 'Algs', label: () => 'wide/slice', test: (slot, c) => usesFace(mainAlg(slot, c), /^[rlfbuMSEx]/) },
  { key: 'a-short', group: 'Algs', label: () => 'a slot shortcut', test: (_slot, c) => c.others.length > 0 },
  { key: 'a-fav', group: 'Algs', label: () => 'your pick', test: (slot, c) => f2lIsFavourite(caseId(slot, c.n)) },
  { key: 'a-pick', group: 'Practice', label: () => 'picked to practise', test: (slot, c) => isPicked(caseId(slot, c.n)) },
];

/** Does a case match the name box? Each word is a case number (exact) or a word of its description or note (prefix). */
function matches(slot: SlotName, c: F2LCase, pattern: string): boolean {
  const words = pattern.toLowerCase().split(/[\s,]+/).filter(Boolean);
  if (!words.length) return true;
  const text = `${GROUP_WORD[caseGroup(slot, c)]} ${describe({ pos: c.corner, o: c.co }, c.edge)} ${c.note} ${c.corner} ${c.edge}`.toLowerCase();
  return words.some((w) => (/^\d+$/.test(w) ? twinOf(slot, c.n) === Number(w) : text.split(/[^a-z0-9/-]+/).some((t) => t.startsWith(w))));
}

/** An alg as the sheet writes it, its AUF in brackets and its triggers labelled. */
function f2lAlgHtml(a: string): string {
  const { pre, rest } = withAuf('', a);
  return `${pre ? `<span class="llr-auf">(${esc(pre)})</span> ` : ''}${algHtml(normalizeAlg(rest))}`;
}

/** The order the cases are listed in: by group, then which sticker faces up/down, then the edge's place, then number. */
function order(slot: SlotName, c: F2LCase): string {
  const p = { top: 0, own: 1, other: 2 };
  return `${GROUPS.indexOf(caseGroup(slot, c))}${['white', 'fb', 'rl'].indexOf(facing(slot, c))}${p[edgePlace(slot, c)]}${String(twinOf(slot, c.n)).padStart(3, '0')}`;
}
/** The sub-heading a case sits under: which of the corner's stickers faces up (or down, in a slot). */
const subhead = (slot: SlotName, c: F2LCase): string => `Corner ${facingWord(slot, facing(slot, c), c.corner.startsWith('U'))}`;

/**
 * Open the reference sheet on `slot`; `pick(slot, case)` is called when a case's "Set in finder" is
 * tapped, `changed` when a case's main alg changes (the finder's case may be showing the old one).
 */
export function openF2LReference(slot: SlotName, pick: (slot: SlotName, c: F2LCase) => void, changed?: () => void): void {
  ensureStyle('f2lr-style', '.llr-drill.on { background: var(--ink); color: #fff; border-color: var(--ink); }');
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
      chips += chipHtml(x.key, x.label(shownSlot), active.has(x.key), count(x));
    }
    const n = cases().filter(shown).length;
    const picks = pool.ids.length;
    const pickRow = `<p class="llr-count">Practise: <b>${picks ? `${picks} case${picks === 1 ? '' : 's'} picked` : 'none picked'}</b>${pool.mirrors ? ' (and their mirrors on the other slots)' : ''}. <button type="button" class="eo-link" data-filter="pick-shown">pick the ${n} shown</button>${picks ? ' <button type="button" class="eo-link" data-filter="pick-none">clear</button>' : ''} · the finder's <b>Practise picked cases</b> puts one on its pair.</p>`;
    return `<div class="llr-filters"><span class="lbl">Slot</span>${slots}<span class="gap"></span>${nameBoxHtml(namePat, '4 12, keyhole, UB')}
      <details class="llr-feats llr-fold" id="f2lr-feats"${foldOpen('f2lr-feats') ? ' open' : ''}><summary>By corner, edge, which sticker is up, and alg${active.size ? ` · ${active.size} on` : ''}</summary><div class="llr-chips">${chips}</div></details></div>
      <p class="llr-count">${active.size || namePat ? `${n} of ${cases().length} cases match${n ? '' : ': nothing has all of that'}.` : 'The four slots are mirrors of each other, and a case has the same number on all four: pick the slot you are solving. Type a case number or a word (keyhole, UB) or tap the chips to narrow the list; a case shows when it matches every chip that is on.'}</p>${pickRow}`;
  };
  const card = (c: F2LCase): string => {
    const id = caseId(shownSlot, c.n);
    const main = f2lMainAlg(id) ?? c.algs[0]!;
    const fav = f2lIsFavourite(id);
    const alts = byLength(allAlgs(c).filter((a) => a !== main)).map((a) => {
      const o = c.others.find((x) => x.alg === a);
      // a shortcut goes through the other slot and leaves it changed: that slot must still be open (unsolved)
      return { alg: a, note: o ? `goes through the ${o.free.map((s) => SLOT_WORD[s]).join(' and ')} slot${o.free.length > 1 ? 's' : ''}, which must still be open` : a === c.simple && c.simple_src === 'search' ? 'R/L/U only, found by search (not in the sheet)' : c.algs.includes(a) ? 'from the sheet' : '' };
    });
    const num = twinOf(shownSlot, c.n);
    const altsBox = altsHtml('f2l', id, alts, `case ${num}`, f2lAlgHtml);
    const shape = pairShape(shownSlot, c);
    const tags = [shape ? `pair ${SHAPE_WORD[shape]}` : '', c.note ? (/keyhole/i.test(c.note) ? 'keyhole' : c.note) : '', `sheet row ${c.n}`].filter(Boolean).join(' · ');
    const picked = isPicked(id);
    return `<div class="llr-case" data-id="${esc(id)}">
      <div class="llr-head">
        <div class="llr-3d"><svg viewBox="-170 -170 340 340" data-pic="${esc(id)}" aria-label="case ${num}"></svg></div>
        <div>
          <div class="llr-name">Case ${num}<small>${moveCount(fullAlg('', main))} moves</small>${fav ? '<small>your pick</small>' : ''}</div>
          <div class="llr-hint">${esc(describe({ pos: c.corner, o: c.co }, c.edge))}</div>
        </div>
      </div>
      <div class="llr-alg">${f2lAlgHtml(main)}${alts.length ? starHtml(main, true) : ''}</div>
      ${noteHtml('f2l', id, main, `case ${num}`)}
      ${altsBox}
      <div class="llr-foot"><button type="button" class="llr-drill" data-go="${esc(id)}">Set in finder</button><button type="button" class="llr-play" data-play="${esc(id)}">▶ play it in 3D</button><button type="button" class="llr-drill${picked ? ' on' : ''}" data-filter="pick-${esc(id)}" aria-pressed="${picked}">${picked ? '✓ Practising' : 'Practise'}</button><span class="llr-tags">${esc(tags)}</span></div>
      <div class="llr-player"></div>
    </div>`;
  };
  const render = () => {
    const list = cases().filter(shown).sort((a, b) => order(shownSlot, a).localeCompare(order(shownSlot, b)));
    let out = filterBar();
    let sec: string | null = null, sub: string | null = null, grid = false;
    const closeGrid = () => { if (grid) { out += '</div>'; grid = false; } };
    for (const c of list) {
      const g = caseGroup(shownSlot, c);
      if (g !== sec) {
        closeGrid(); sec = g; sub = null;
        const inG = cases().filter((x) => caseGroup(shownSlot, x) === g);
        out += `<h3 class="llr-group">${esc(GROUP_WORD[g])}<small>${inG.filter(shown).length} of ${inG.length}</small></h3>`;
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
    sub: 'Each case seen from its slot\'s corner, the pair marked (its white sticker white), the open slots grey. Set in finder puts the case on the finder; a star makes an alg the one the finder leads with and solves the pair with on "Solved, next pair".',
    render,
    mounted: (panel) => {
      for (const svg of panel.querySelectorAll<SVGSVGElement>('svg[data-pic]')) {
        const hit = caseOf(svg.dataset.pic!);
        if (hit) render3d(svg, caseCells(hit.slot, { pos: hit.c.corner, o: hit.c.co }, hit.c.edge, [hit.slot]), SLOT_VIEW[hit.slot]);
      }
    },
    onFilter: (k) => {
      if (k.startsWith('slot-')) { const s = k.slice(5); if (isSlot(s)) shownSlot = s; return; }
      // the practice picks ride on the chip plumbing (a tap redraws the sheet)
      if (k === 'pick-shown') { setPicks([...pool.ids, ...cases().filter(shown).map((c) => caseId(shownSlot, c.n))]); changed?.(); return; }
      if (k === 'pick-none') { setPicks([]); changed?.(); return; }
      if (k.startsWith('pick-')) { togglePick(k.slice(5)); changed?.(); return; }
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
