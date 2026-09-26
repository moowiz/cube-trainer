// The F2L picture: the cube with the pair's two pieces painted where they are
// (the corner's white sticker white, the rest by colour), the open slots grey,
// everything solved in its colour. The finder draws it live (tap a facelet to
// place a piece); the case sheet draws one per case, from the slot's own angle.

import { pieceType, posName, STICKERS } from '../cube/geometry';
import type { Cell, View } from '../cube/render';
import { faceHex } from '../cube/scheme';
import { DATA } from './data';
import { type CornerState, type SlotName, slotOf } from './model';

export const GREY = '#DDE1E7'; // the page's --grey-ll: SVG fill attributes cannot read a CSS variable

/** The angle each slot is seen from: its two side faces to the front. */
export const SLOT_VIEW: Record<SlotName, View> = { FR: { rx: 28, ry: -35 }, FL: { rx: 28, ry: 35 }, BR: { rx: 28, ry: -135 }, BL: { rx: 28, ry: 135 } };

/**
 * What to paint on every facelet for `slot`'s pair at `corner` / `edge` (either may be unplaced), with
 * `open` the slots not yet solved (the pair's own slot and the slots its pieces sit in are open too).
 */
export function caseCells(slot: SlotName, corner: CornerState | null, edge: string | null, open: Iterable<SlotName>): Cell[] {
  const D = DATA.slots[slot];
  const opened = new Set<string>(open);
  opened.add(slot);
  if (corner && !corner.pos.startsWith('U')) opened.add(corner.pos.slice(1));
  if (edge && !edge.startsWith('U')) opened.add(edge);
  const pairFill = (letter: string) => (letter === 'D' ? '#ffffff' : faceHex(letter)); // white pops against the white-ish D
  return STICKERS.map((s) => {
    const t = pieceType(s.pos), name = posName(s.pos), sl = slotOf(s.pos);
    if (t === 'center') return { fill: faceHex(s.face), cls: 'center' };
    if (t === 'corner' && corner && name === corner.pos) return { fill: pairFill(D.cmap[`${corner.pos}-${corner.o}`]?.[s.face] ?? s.face), cls: 'pair' };
    if (t === 'edge' && edge && name === edge) return { fill: pairFill(D.emap[edge]?.[s.face] ?? s.face), cls: 'pair' };
    const solved = (s.pos[1] === -1 && (sl === null || !opened.has(sl))) || (t === 'edge' && s.pos[1] === 0 && sl !== null && !opened.has(sl));
    return solved ? { fill: faceHex(s.face), cls: 'solved' } : { fill: GREY, cls: 'hit' };
  });
}
