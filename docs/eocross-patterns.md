# EOCross: what optimal solutions look like

Measured 2026-09-14 with `tools/eocross/analyse.js` (4000 random scrambles,
every optimal solution of each, 69 518 solutions in all) over the exact
EOCross distance table in `web/public/eocross-worker.js`. EOCross = every
edge oriented to the front/back axis and the four white edges home, white
down. Optimal EO lengths come from the trainer's own 2^12 table.

## The numbers

| | mean | distribution |
|---|---|---|
| optimal EOCross | **7.5** | 5: 2%, 6: 8%, 7: 32%, **8: 54%**, 9: 5%, 10: 140 states in the whole table |
| optimal EO alone | 4.5 | 3: 9%, 4: 32%, 5: 40%, 6: 13% |

So the cross costs about three moves on top of EO. A 6 is a good EOCross, a
7 is normal, an 8 is still optimal more often than not.

Optimal solutions are much rarer than for EO: 12% of scrambles have exactly
one, half have five or fewer. (EO has dozens.)

## Strategies a person could actually run

Total EOCross length when you finish optimally from wherever the strategy
leaves you:

| strategy | mean | equals optimal |
|---|---|---|
| true optimal | 7.52 | 100% |
| any optimal EO, then the best cross from there | 9.43 | - |
| the *best* of the optimal EO solutions, then cross | 8.29 | 40% (one move over 44%, two over 14%) |
| the best EO solution of optimal length **or one longer**, then cross | 7.83 | 71% (one over 26%) |

Three things fall out of that table:

1. **Solving EO first and then the cross costs two moves** (9.4 vs 7.5).
   That is the whole gap between "EO then cross" and "EOCross".
2. **Which EO solution you pick matters more than anything else.** Picking
   the right optimal EO gets 1.1 of those two moves back; 60% of scrambles
   have *no* optimal EO that leads to an optimal EOCross, and when one
   exists it is usually a minority of them (under a quarter of the optimal
   EO solutions, on 23% of scrambles).
3. **One extra EO move is almost always worth it.** Allowing an EO one
   longer than optimal, chosen for the cross, is within 0.3 of optimal and
   hits optimal 71% of the time. Optimal EOCross solutions confirm it from
   the other side: their EO part (up to the last F/B turn) is on average
   **2.3 moves longer than optimal EO** - only 13% of them use an
   optimal-length EO.

So EOCross is not "a good EO plus a good cross"; it is a longer EO whose
setup moves are chosen to place cross edges. The trainer's EO-goal list of
optimal EO solutions is the wrong menu for it, which is why the EOCross
goal lists EOCross solutions instead.

## Shape of an optimal solution

Measured over all 69 518 optimal solutions.

- **EO is finished exactly once, by the last F/B quarter turn.** In no
  optimal solution is EO solved earlier and broken again. So the solution
  is "EO part, then a cross tail", and the tail is short:
  0 moves 38%, 1 move 26%, 2 moves 17%, 3+ moves 19%.
- **The last F/B turn usually drops in a cross edge** (65% of solutions).
  In the tail-0 case (38%) the state right before that turn is always the
  same: three white edges home, the fourth sitting on the side of the face
  about to be turned (FR/FL for an F turn, BR/BL for B), and all four of
  that face's edges bad. The turn fixes EO and completes the cross in one.
  This is the pattern to aim for.
- **A one-move tail is R/L (59%) or D (35%)**, almost never F/B. R/L inserts
  the last edge from the middle layer; D aligns a cross that was built
  offset. Two-move tails are `R/L D`, `D R/L`, `R/L R/L`.
- **When EO finishes with no cross edge home (34%)**, the cross is usually
  already built in the D layer, just rotated: the fix is a D move or an
  `R/L D` pair.
- **D moves are setup, not adjustment.** 82% of solutions have one or two
  D moves and 77% of them sit in the middle of the solution, not at the
  end. Only 17% of solutions end with a D.
- Last move: F or B 47%, R or L 36%, D 17%, never U.

## What to practise

- Plan the EO with the white edges in view: before each F/B turn, look at
  which white edges it will move into or out of the D layer.
- Go for the finishing pattern: three cross edges home, the fourth waiting
  on the side of the last F/B face, that face fully bad.
- When the "obvious" EO leaves a 3-4 move cross, spend one more EO move to
  set the cross up instead. It pays 60% of the time and is rarely worse.
- Use the D layer mid-solution to bring white edges under the F/B turns.

The trainer shows all of this per scramble: set Goal to EOCross, then Show
optimal EOCross solutions groups them by tail length, and Hint: move count
shows EO and EOCross optimal lengths side by side.

## Tools

- `tools/eocross/model.js` - independent 12-edge model (EO + cross slots).
- `tools/eocross/analyse.js [n] [seed]` - the tables above.
- `tools/eocross/check.mjs [n]` - headless check that the trainer's worker
  agrees with the node model and every listed line passes the trainer's Check.
