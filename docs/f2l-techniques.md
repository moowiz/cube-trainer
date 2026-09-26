# ZZ F2L: the sheet's algs by technique, and what search adds

2026-09-26. The F2L finder's cases and algs come from the ZZF2L Cases sheet (`web/src/f2l/data.ts`, one tab per
slot, 83 cases a slot, 332 in all, 458 algs plus 69 slot shortcuts). This note re-derives them: every alg is
classified by the tools it uses, and every case is solved optimally in five move sets (one technique each) with
`web/src/f2l/search.ts`, so the sheet can be measured against what is possible. Re-run with

    cd web && npx vite-node scripts/f2l-derive.ts all --json out.json

**How it was measured.** Moves are counted in half-turn metric (R2 is one move), the case's AUF included. The
case's picture is the pair where the case puts it, with the cross and every slot the pair is not in solved. An
alg "keeps" a slot when that pair is home at the end; it may lift the pair on the way. The move sets are:

| set | turns | technique it stands for |
|---|---|---|
| own | U and the slot's own side (R for a right slot) | classic one-handed-side F2L |
| R/L/U | U, R, L | ZZ's native move set, both sides |
| +D | U, R, L, D | D conjugates, keyhole under the slot |
| +F2 | U, R, L, F2, B2 | F2/B2 conjugates (EO-safe) |
| free | U, R, L, other slots free | the first pair of a solve; the sheet's "shortcuts" |

## What the sheet's algs are made of

| tools (all 458 sheet algs) | algs |
|---|---|
| own side + U only | 173 |
| the other side's turns in one block before the own side's (pop, then insert) | 159 |
| D turns | 65 |
| both sides interleaved | 36 |
| wide / slice / F or B quarter turns | 16 |
| F2 / B2 | 9 |

By the position `explain()` reads (the first head of each alg): two pops then insert 122, D-layer conjugate
48, pop the corner 45, pop the edge 38, twisted corner with the edge elsewhere 34, split and re-pair 27, tilt
(white up) 20, slide the corner under 18, borrow a neighbouring slot 15, and a long tail. 248 of the 458 (54%)
end with one of the two basic 3-move inserts.

Every sheet alg checks out: each keeps the cross and every slot its pair is not in, and each of the 69 shortcuts
breaks only the slots it names (`web/test/f2l-search.test.ts`).

## The sheet against the optimum

Mean moves per case:

| section | cases | sheet's best | own | R/L/U | +D | +F2 | free |
|---|---|---|---|---|---|---|---|
| both pieces on top ("Last slot") | 80 | 7.89 | 7.45 | 7.45 | 7.30 | 7.15 | 6.40 |
| edge in a slot | 36 | 6.39 | 6.17* | 6.53 | 6.47 | 5.94 | 6.50 |
| corner in a slot | 36 | 7.25 | 6.83* | 6.75 | 6.75 | 6.58 | 6.75 |
| both in slots | 180 | 8.43 | 7.89* | 7.80 | 7.67 | 7.11 | 7.53 |
| all | 332 | 7.95 | | 7.46 | 7.35 | 6.94 | 7.06 |

\* only over the cases the own side can solve at all (192 cannot: a piece is in a slot on the other side).

The sheet's best against the R/L/U optimum, cases by difference: sheet shorter (it uses D, F2 or wide turns)
28, equal 180, 1 longer 57, 2 longer 56, 3-5 longer 11. **124 cases have an R/L/U alg shorter than anything on
the sheet.** Of those shorter algs, 92 work both sides at once, 30 use the own side only (mostly half turns),
2 pop then insert.

## Techniques

1. **Direct insert.** R U R' (corner above the slot, white on the right, edge at the back) and R U' R'
   (joined over the front-left, white on the left), mirrored for the other slots. Every picture a U turn and one
   of these finishes is "ready".
2. **Pair in the top layer, then insert.** Split and re-pair, or tilt a white-up corner (R U2 R', R U' R' style).
   The own-side R/U set solves every top-layer case at the optimum or within a move of it; the sheet is at
   or near the optimum here.
3. **Pop, then insert.** A piece in a wrong slot comes out with that slot's own three moves, then the pair goes
   in. The sheet does this sequentially (159 algs). It is correct but rarely shortest.
4. **Overlap: both sides at once (missing from the sheet's thinking).** R and L turn different layers, so one
   slot can stay open while the other side turns. Two shapes:
   - *transfer*: open both, one U turn, close both. `R L' U R' L` moves a front-right corner straight into the
     front-left slot (5 moves; pop-then-insert `R U R' U' L' U L` is 7). `(U) R L' U2 R' L` likewise (6 vs 8).
   - *nested pop*: the insert's first turn opens the slot, the other side's pop runs, the insert closes:
     `R (L' U L) U' R'` (6), where the sheet had the D conjugate `D R U R' D' R U' R'` (8).
   This is the single biggest gap: 92 of the 124 shorter algs are overlaps, and the sheet's 36 interleaved algs
   show it knew the idea but did not apply it throughout. The finder now finds these by search.
5. **Same-side half turns and cancellations.** R2 swaps the front and back slot of one side without turning
   pieces over, and a back-slot pop cancels into the insert (R' U R + R U' R' = R' U R2 U' R'). The sheet uses the
   cancellation (the R2 U' R' endings); search adds pure-R/U shortcuts such as `R U' R U R2 U' R2` (7 vs the
   sheet's 9) and, for the twisted pair in its slot, `R2 U2 R' U' R U' R' U2 R'` (9 vs 11).
6. **D conjugates (keyhole under the slot).** 65 sheet algs use D. D seldom pays: it beats R/L/U in 34 cases, by
   one move in 30 of them, and 32 of the sheet's D algs are longer than the R/L/U optimum (17 equal, 20 shorter).
   The shorter D algs mostly carry a corner across the bottom (`L D' L' U L D L'`, `L' D2 L U2 L' D2 L`).
7. **F2/B2 conjugates.** F2 keeps EO and swaps UF with DF, so the front cross edge becomes a temporary slot.
   The sheet has 9 such algs; search finds F2 strictly shorter than R/L/U and D in 104 cases, by 2-4 moves in
   33: `F2 U F2 U' F2` (5; the sheet's best is 8, R/L/U's 9), `F2 U' L' U L F2` (6 vs the sheet's 8). They cost a regrip in a
   rotationless solve, which is presumably why the sheet avoids them. The finder does not offer them. They are
   the natural next thing to add, as an "advanced" row.
8. **F quarter / wide / slice.** 16 sheet algs. F quarters must come in F ... F' pairs to put EO back; wide
   turns move a middle layer so a half-turn shuffle crosses slots. Not searched (the move set breaks the cross
   or EO mid-alg by design); the sheet's are kept as they are.
9. **Open slots are free (block-building).** Until a slot is solved, an alg may leave anything in it. With
   every other slot open, search shortens 89 cases (by 1: 57, 2: 24, 3-4: 8): `R2 U' R' U R2` for a case the
   sheet does in 8, `R' U R2 U R'` (5 vs 8). The sheet lists 69 such shortcuts; search finds them for every
   case and every set of open slots. The finder now offers the shortest through the slots still open when it
   beats every row. This is ZZ's own view of F2L: a side's two slots are one 1x2x3 block, and the other side
   is scratch space until it is built.
   Open slots also change which tools pay. D barely helps with every slot kept (front-left: shorter than
   R/L/U in 8 of 83 cases, by 1.1 on average), but with a neighbour open D swings the target slot under it
   (the keyhole): 7-9 cases per open-slot set, saving 1.3-1.7. On front-left with front-right open, `D R U' R' D'`
   (5) where R/L/U needs 7, and `U D' L' U' L D` (6) where it needs 9. The finder's open-slot search tries D too.

## Not covered at all (by the sheet or the app)

- **Multislotting**: solving two pairs with one alg, or setting up the next pair while inserting this one.
- **Pseudo-slotting**: solving a pair into the slot the D layer is turned to, fixing D later. The D-conjugate
  cases are its one-pair version.
- **Last-slot influence on the last layer**: with EO done, the last pair can be chosen or inserted to control
  corner orientation (the Winter-Variation / ZBLS idea; for this app, an OCLL skip or an easier OCLL).
- **Ergonomics**: the search counts moves, and the sheet was clearly chosen for flow (R/U triggers, no
  regrips). A move count is the wrong cost for "which alg leads": R2 U' R2-heavy or F2 algs are shorter but can
  be slower. A weighted metric (R, U cheap; L a little dearer; D, F2 and regrips dear) would rank better. Today
  the finder leads with the fewest moves (the user's call, 2026-09-26), sheet first on ties, and a star pins any
  alg.

## The philosophy in one place

F2L in ZZ is pairing under two constraints that EOCross bought: no F/B quarter turns, and every edge already
facing the way it must. So a case is only where the corner is, which way its white faces, and where the edge
is. Everything reduces to one of two inserts per slot. The work is getting the pair to one of those pictures
without disturbing what is solved: tilt a white-up corner, re-pair a split pair, pop a piece out of a wrong slot.

The sheet's algs are that idea done carefully and sequentially. Search shows three things it leaves on the
table. The two sides of the cube are independent, so pops and inserts can overlap: the biggest win, and pure
R/L/U. F2 is a legal, EO-safe helper slot. Open slots are free space. None of this changes the principles. It
changes the moves: an alg is a route for two pieces through the cube's layers, and the shortest route often goes
through a second slot at the same time rather than through the top layer twice.
