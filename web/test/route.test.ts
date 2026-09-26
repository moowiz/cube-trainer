// Following an alg on a cube (src/cube/route.ts): the moves done along a
// route, halfway through a double turn, the wrong turns and their undo.
// Shared by the last-layer drills and the F2L finder.

import { describe, expect, it } from 'vitest';
import { foldSlices, inHand, offList, offRoute, routeProgress, wrongTurns } from '../src/cube/route';
import { state } from '../src/cube/state';

const SETUP = "R U R' U'"; // any alg from solved: the routes are followed from here
const ROUTE = ['R', 'U', "R'", 'U2', "R'", 'F', 'R', "F'"];
const at = (moves: string) => state(`${SETUP} ${moves}`.trim());

describe('routeProgress', () => {
  it('counts the prefix the cube has made', () => {
    expect(routeProgress(SETUP, ROUTE, at(''))).toEqual({ done: 0, half: false, onRoute: true });
    expect(routeProgress(SETUP, ROUTE, at("R U R'"))).toEqual({ done: 3, half: false, onRoute: true });
    expect(routeProgress(SETUP, ROUTE, at(ROUTE.join(' ')))).toEqual({ done: ROUTE.length, half: false, onRoute: true });
  });
  it('a quarter turn into a double turn is halfway, either way round', () => {
    expect(routeProgress(SETUP, ROUTE, at("R U R' U"))).toEqual({ done: 3, half: true, onRoute: true });
    expect(routeProgress(SETUP, ROUTE, at("R U R' U'"))).toEqual({ done: 3, half: true, onRoute: true });
  });
  it('off the route, and with no belief, nothing is done', () => {
    expect(routeProgress(SETUP, ROUTE, at('L'))).toEqual({ done: 0, half: false, onRoute: false });
    expect(routeProgress(SETUP, ROUTE, null)).toEqual({ done: 0, half: false, onRoute: false });
  });
  it('a rotation is not done before it is made (the earliest matching prefix)', () => {
    expect(routeProgress(SETUP, ['x', 'R', "x'"], at(''))).toEqual({ done: 0, half: false, onRoute: true });
  });
});

describe('offRoute', () => {
  it('names the turns after the last state on the route, and where they left it', () => {
    expect(offRoute(SETUP, ROUTE, "R U L")).toEqual({ bad: ['L'], at: 2 });
    expect(offRoute(SETUP, ROUTE, "R U L D")).toEqual({ bad: ['L', 'D'], at: 2 });
  });
  it('an undone wrong turn is no longer bad', () => {
    expect(offRoute(SETUP, ROUTE, "R U L L'")).toEqual({ bad: [], at: 2 });
  });
});

describe('the wrong turns as shown', () => {
  it('foldSlices folds the two outer layers of a slice back into it', () => {
    expect(foldSlices(["L'", 'R', 'U'])).toEqual(['M', 'U']);
    expect(foldSlices(['R2', 'L2'])).toEqual(['M2']);
    expect(foldSlices(['R', 'U', "R'"])).toEqual(['R', 'U', "R'"]);
  });
  it('offList merges turns of one face', () => {
    expect(offList(['R', 'R'])).toEqual(['R2']);
    expect(offList(['R', "R'"])).toEqual([]);
  });
  it("inHand relabels the cube's letters into the hand's frame after the route's rotations", () => {
    expect(inHand(['x', 'R', 'U'], 3, 'F')).toBe('U'); // after an x the cube's F is the hand's U
    expect(inHand(['R', 'U'], 2, 'F')).toBe('F');
  });
  it('wrongTurns gives the turns and their undo, merged and folded', () => {
    expect(wrongTurns(ROUTE, 2, ['L', 'L', "R'"])).toEqual({ bad: ['L2', "R'"], undo: ['R', 'L2'] });
  });
});
