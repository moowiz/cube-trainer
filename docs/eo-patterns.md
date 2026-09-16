# EO: what optimal solutions look like

Measured 2026-09-16 with `tools/eocross/eo-patterns.ts` over every EO state
(2048, all 124 908 optimal solutions between them) on the trainer's own
2^12 table. EO = every edge oriented to the front/back axis; the cross is
not part of it (that is `docs/eocross-patterns.md`). The EO trainer's
`Hint: EO strategy` note is written from this page, and its `Strategy for
this scramble` note checks the rules below against the scramble in front of
you.

## How many cases

2048 states (twelve edges, each good or bad, an even number bad). Up to the
16 symmetries that keep the front/back axis (turns about it, flipping the
cube end for end, mirrors) that is **186 patterns**; 298 without the
mirrors. Fixing the cross colour breaks the symmetry down further: 592
patterns with mirrors, 1056 without, which is why EOCross recognition is
more "read the case" than pure EO.

Where the bad edges are is all that matters - the pieces themselves are
interchangeable.

## The numbers

| bad edges | optimal, mean | by length |
|---|---|---|
| 2 | 3.45 | 3: 40, 4: 22, 5: 4 states |
| 4 | 3.75 | 1: 2, 2: 24, 3: 134, 4: 276, 5: 56, 6: 3 |
| 6 | 4.94 | 3: 8, 4: 200, 5: 556, 6: 160 |
| 8 | 4.80 | 2: 1, 3: 20, 4: 122, 5: 284, 6: 68 |
| 10 | 6.18 | 6: 54, 7: 12 |
| 12 | 7 | one state |

Mean over all states 4.51; the longest EO is 7 moves (12 bad, and two of
the 10-bad patterns).

## The skeleton every solution has

- **The last move is always an F or B quarter turn on a face whose four
  edges are all bad.** A side turn cannot change the number of bad edges,
  so nothing else can finish. EO is always "gather four bad edges on one
  front/back face and turn it"; the rest is what you do before that.
- **The count fixes the number of F/B turns and, nearly always, the plan**
  (bad edges on the face at the moment it is turned):

  | bad | F/B turns | plan | available in |
  |---|---|---|---|
  | 4 | 1 | 4 | 100% |
  | 6 | 2 | 3 then 4 | 93% (1 then 4 then 4 is as short 49% of the time) |
  | 8 | 2 | 4 then 4 | 100% |
  | 2 | 2 | 1 then 4 | 100% |
  | 10 | 3 | 3, 4, 4 | 91% |
  | 12 | 3 | 4, 4, 4 | the one state |

- **Never turn a face with no bad edges, and you never need to turn one
  with two**: a 2-turn appears in some optimal solution of 20% of states,
  but always beside an equally short solution without one. F2/B2 is
  unavoidable in 3% of states; some half turn is unavoidable in 31%.
- **Alternate faces.** 64% of solutions alternate F and B; after the 3-turn
  of a 6-bad case the last four gather on the *other* face 77% of the time.

## Rules that are nearly free

Tested over every state the rule applies to:

- **A face with 4 bad: turn it now.** Starts an optimal solution 96% of the
  time (248 states).
- **6 bad and a face with 3: turn it now.** Optimal 96% of the time (432
  states). The exceptions look like `UF UB UL DF DL FR` (optimal `B L F
  B`): turning the 3-face leaves the last four spread across the rings.
- **6 bad and a face with only 1: turning it anyway (making 8) is optimal
  70% of the time.** More bad edges is not worse.
- With those F/B rules and *perfect* setup choices the mean is 5.18 (62%
  optimal). With a naive setup rule ("add a bad edge to the fuller face")
  it is 6.6 and gets stuck a third of the time. **Deciding when to flip is
  the easy part; the skill is the setup moves.**

## What a good setup move does

- 64% of setup moves add exactly one bad edge to the face turned next
  (2 to 3, or 3 to 4). Almost none ever remove one. The other fifth are
  neutral (3 to 3, 2 to 2): they place the *rest* of the bad edges for the
  turn after, which is the two-move lookahead a person misses.
- A side quarter turn adds at most one bad edge to a face, so with four bad
  edges and the best face holding *a* of them the solution is at least
  `1 + (4 - a)`: 3 already there means 2-4 moves, 2 means 3-6, 1 means
  4-5, none (all four in the side-middle slots) means 6.
- **Half turns are setups too.** U2 swaps the top-front edge with the
  top-back one; R2 swaps front-right with back-right. When the front slot
  is good and the one behind it is bad, that is one move for what a
  quarter turn does in two.

## Reading the cost at a glance

- **Bad edges in the four side-middle slots** (top-right, top-left,
  bottom-right, bottom-left) each cost a side move: no F/B turn reaches
  them. With 6 bad: 0-1 there gives about 4.2 moves; 2 gives 5.0; 3 gives
  5.4; all four gives 6.
- **Across pairs are the expensive shape**: a front edge and the back edge
  straight behind it on the same side ring, both bad (top-front with
  top-back, front-right with back-right, ...). Moving one onto a face
  kicks the other off. With 2 bad: 3.4 mean, 5 when they are across. With
  4 bad: 3.5 / 4.3 / 4.7 for 0 / 1 / 2 such pairs. The two 6-move 4-bad
  patterns are exactly two across pairs (`UF UB DF DB`) and all four
  side-middle (`UR UL DR DL`).
- **8 bad turns the logic round**: it is the good edges you place, and they
  want to sit in the side-middle slots (all four there: `F B`). Each good
  edge on a front/back face costs about a move.
- **10 bad is always 6 or 7**, 7 when the two good edges share a face.
  Just plan 3, 4, 4.

## The nine 2-bad patterns

| bad edges | moves | e.g. |
|---|---|---|
| top-front, top-right (one on a face, one adjacent in a side-middle slot) | 3 | `F R' F` |
| top-right, bottom-front | 3 | `F' R' F` |
| top-back, front-right | 3 | `F' U2 F` |
| top-front, front-right (both on one face) | 4 | `U F' U' F` |
| top-front, bottom-front (opposite on one face) | 4 | `U F L F` |
| top-right, top-left (both side-middle, one ring) | 4 | `R B U B` |
| top-left, bottom-right (both side-middle, diagonal) | 4 | `U B' R' B` |
| top-back, bottom-front | 4 | `U F' R' F` |
| top-front, top-back (across) | 5 | `U R B U B` |

The 3-movers all have the shape "one bad edge on a face, the other a single
side move from joining the three good ones the first turn will make bad".

## Tools

`cd web && npx vite-node --root .. ../tools/eocross/eo-patterns.ts` prints
every table above (a few seconds). `web/src/eo/patterns.ts` is the
trainer's reading of a case and the two notes; `web/test/eo-patterns.test.ts`
pins the examples quoted here.
