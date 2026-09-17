// The belief (docs/smart-cube-design.md 3.1-3.2): what the app thinks the
// cube looks like, in the cube's own letters - its last report or resync
// with every turn since applied - held against the cube's own reports. A
// pure reducer over capture events, so a live session and a replayed
// capture go through the same code.

import { applyMove } from '../moves/moves';
import type { CaptureEvent, Caps } from './capture';

export interface CubeStatus {
  connected: boolean;
  name: string | null;
  mac: string | null;
  protocol: string | null;
  caps: Caps | null;
  hardware: string | null;
  battery: number | null;
  /** the belief, in the cube's letters; null until the cube has reported or been resynced */
  belief: string | null;
  /** the cube's last own report */
  reported: string | null;
  /** did the last report match the belief? null while unknown or inconclusive */
  agree: boolean | null;
  /** turns applied since the belief was last set from a report or resync */
  movesSinceSync: number;
  /** all turns this session */
  moves: number;
  lastMoveT: number | null;
  lastMove: string | null;
  lastReportT: number | null;
}

export const EMPTY_STATUS: CubeStatus = {
  connected: false, name: null, mac: null, protocol: null, caps: null, hardware: null, battery: null,
  belief: null, reported: null, agree: null, movesSinceSync: 0, moves: 0, lastMoveT: null, lastMove: null, lastReportT: null,
};

// DECISION: a report that arrives within this many ms of a turn may have
// been generated before that turn reached us (the two travel separately on
// GAN cubes), so a mismatch then is inconclusive, not drift.
export const REPORT_SETTLE_MS = 300;

export function reduce(s: CubeStatus, e: CaptureEvent): CubeStatus {
  switch (e.kind) {
    case 'connect':
      return { ...EMPTY_STATUS, connected: true, name: e.name, mac: e.mac, protocol: e.protocol, caps: e.caps };
    case 'hardware':
      return { ...s, hardware: [e.hardwareName, e.hardwareVersion && `hw ${e.hardwareVersion}`, e.softwareVersion && `sw ${e.softwareVersion}`].filter(Boolean).join(' ') || s.hardware };
    case 'battery':
      return { ...s, battery: e.level };
    case 'move': {
      const belief = s.belief === null ? null : applyMove(s.belief, e.move);
      return { ...s, belief, movesSinceSync: s.movesSinceSync + 1, moves: s.moves + 1, lastMoveT: e.t, lastMove: e.move, agree: s.agree === false ? false : null };
    }
    case 'facelets': {
      if (s.belief === null) return { ...s, belief: e.facelets, reported: e.facelets, agree: true, movesSinceSync: 0, lastReportT: e.t };
      const settled = s.lastMoveT === null || e.t - s.lastMoveT >= REPORT_SETTLE_MS;
      const same = s.belief === e.facelets;
      // a matching report confirms the belief whatever the timing; a mismatch counts only once the turns have settled
      const agree = same ? true : settled ? false : s.agree;
      return { ...s, reported: e.facelets, agree, movesSinceSync: same ? 0 : s.movesSinceSync, lastReportT: e.t };
    }
    case 'resync':
      return { ...s, belief: e.facelets, agree: null, movesSinceSync: 0 };
    case 'disconnect':
      return { ...s, connected: false };
    case 'note':
      return s;
  }
}

/** The status a run of events leaves, from nothing. */
export function statusAfter(events: readonly CaptureEvent[], from: CubeStatus = EMPTY_STATUS): CubeStatus {
  let s = from;
  for (const e of events) s = reduce(s, e);
  return s;
}
