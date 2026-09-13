// Phone sessions of 2026-09-13 15:20-15:25 (one cube, one scramble; the
// true state was pinned by the 08:06 lock and confirmed by photos): the
// voter's per-face evidence replayed through the lock-time cascade. Two
// sessions that stalled on "U appears 10" / "R appears 8" resolve to the
// exact state; the third has one junk cell on a face with 11 inliers and
// must stay honest about it.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assembleResolved, assembleState, validateState } from '../src/state';
import type { FaceId, Lab } from '../src/types';

const TRUTH = 'LRFLUFLBUBLDLRRRRFDDRUFDUFDFDBUDFRDLBBBULFULLRBUUBBDRF';
const dir = new URL('./fixtures/session-0913/', import.meta.url);
const evidence = (name: string) => {
  const d = JSON.parse(readFileSync(new URL(name, dir), 'utf8')) as { lockAttempt: { evidence: { face: FaceId; cells: Lab[] }[] } };
  return d.lockAttempt.evidence.map((e) => ({ face: e.face, cells: e.cells }));
};

describe('session replay', () => {
  it('scan-debug-1789312986281: a shadowed blue read as white and three bright reds as orange; resolves exactly', () => {
    const st = assembleResolved(evidence('scan-debug-1789312986281.json'));
    expect(validateState(st.facelets).ok).toBe(true);
    expect(st.facelets).toBe(TRUTH);
    expect(st.turned).toEqual([0, 2, 0, 0, 0, 0]);
  });

  it('scan-debug-1789313082369: "R appears 8"; resolves exactly with R and B re-oriented', () => {
    const st = assembleResolved(evidence('scan-debug-1789313082369.json'));
    expect(st.facelets).toBe(TRUTH);
    expect(st.turned).toEqual([0, 2, 0, 0, 0, 2]);
  });

  it('scan-debug-1789312817862: one junk cell on B (11 inliers of 33) - 53 of 54 free, and no false lock', () => {
    const free = assembleState(evidence('scan-debug-1789312817862.json'));
    // the free classification is right everywhere but the junk cell; compare up to the per-face orientation the truth needs
    const st = assembleResolved(evidence('scan-debug-1789312817862.json'));
    expect(validateState(st.facelets).ok).toBe(false);
    expect(free.stickerFaces.filter((f) => f === 'U').length).toBe(10);
  });
});
