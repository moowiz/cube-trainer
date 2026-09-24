# LL drill: next steps (2026-09-23)

Loose ends from the PLL-drilling sessions of 2026-09-21..23 (commits
`44c7f19`..`d9c98a9`), written to be picked up cold. Each item names the
files, what guards it, and S / M / L (an hour / half a day / a day).

Read `CLAUDE.md` first. The drill's own conventions are in
`web/src/ll/trainer.ts`'s header comment: the moves come from the smart
cube, so the screen carries the case and little else; the voice has a mode
per move set (the scramble and the alg each `nothing | reads me the next
move | says the moves I make | only when I go wrong`) plus "ask me the
case"; anything the voice says has to be short enough to beat the hand,
which is why chunks have names (`ui/fingertricks.ts` CHUNKS) instead of
notation. Stage commits by path - other sessions share the checkout.

## 1. Commit the headless checks (S, do this first)

Every bug fixed in those sessions was found by a puppeteer script that
serves `web/dist`, replays a synthetic capture through
`window.ZZ.smart.replay(...)`, stubs `speechSynthesis` /
`SpeechRecognition` and asserts on what was said. They were written in
`$TMPDIR` and are **gone**; only `scripts/check-smart.mjs` (EO) is in the
repo. Recreate them as `scripts/check-ll.mjs` (or a few files) on
`scripts/headless.mjs`'s helpers, with an `npm run check:ll` script, and
mention them in `docs/maintenance-plan.md` 4.6 beside the other checks.

What they covered, all of it worth keeping:

- **repeat mode**: three algs back to back on ONE connection (a check that
  reconnects per alg passes even when chaining is broken - that is how the
  bug fixed in `4a1c9f0` got through);
- **a line-up**: `Ja, U, Jb, U', Ja` - the U turns are absorbed, nothing is
  called wrong, the name is not said twice;
- **a slice**: an alg with `U D'` replayed as `D' U` must stay silent
  (`2767346`);
- **the watching voice**: the case asked, the answer judged, then silence
  through the right moves, "wrong. undo ..." on a wrong one, the case and
  the time at the end;
- **the hands-free quiz**: no cube, "ready" asks, the whole alg is read,
  "next" brings the next case, a cube connecting stops the standby mic;
- **the held alg**: 60 new cases with "show the alg once I start" on, the
  panel hidden every time (the leak in `0494cff` hit about 1 case in 7,
  the ones whose scramble had a trailing AUF trimmed);
- **favourites and notes**: star an alt, drill from the button, reload,
  un-star; write a note, reload, see it under the alg in the drill.

Method note: each `replay()` is a fresh connection, so replay **cumulative**
sequences (scramble + everything since); `replay(text, 1)` for real time
when timing matters. Prove a repro by `git stash`ing the fix, rebuilding
and watching the check fail.

## 2. Draw cases from the stored practice, not just this sitting (M)

`drawCase()` (`ll/model.ts`, tested in `test/ll.test.ts`) weights by how
often a case has come up **since the page loaded**, and `newCase()` keeps
those counts in memory. The practice view already computes what to work on
across days (`ll/practice.ts` `caseStats` / `workOn`, off the store's
attempts). Feed that in: a case that is slow or misnamed should come up
more, and the sitting's counts should still even out within a session.
Keep `drawCase` pure and let the trainer pass the stats in.

## 3. The watcher should accept any AUF (M)

The wrong-turn watcher follows the standard route including its pre-AUF
(`followAlg` in `ll/trainer.ts`), so lining a case up differently from the
tabled alg is called wrong on the first move. Judge instead against the
route from wherever the top layer is: try the four AUFs of the remaining
alg and take the one the turns match. Guard with a check that does the
case after `U` and after `U2` and hears nothing.

## 4. Let repeat mode drill an alternative (S)

`repDone()` accepts any of a case's algs (main or alt) as finished, but
`followAlg` marks and watches only the main route, so doing an alt is
called wrong move by move. Either follow whichever line the turns match,
or let the rep name the alg it wants (the favourite star already exists -
maybe repeat mode should simply drill the favourite and nothing else).

## 5. Sync the per-drill settings (M)

Favourites and notes sync (`store/` `favs`, `notes`; see
`ll/favs.ts`, `ll/notes.ts`), but the settings beside them - which cases
are in the drill, the voice modes, the chunk names, start-from - are
`localStorage` per device (`zz-pll-settings`). A `settings` collection
would carry a picked pool between phone and desktop. Watch the id rule:
**no slash in a record id** (a `pll/Ja` id made Firestore read a 5-segment
path, the write threw inside the batch and stopped solves and attempts
syncing until `0f63ad6` migrated the ids to `pll:Ja`).

## 6. Smaller things

- **Name the U-headlights OCLL's commutator.** `R2 D R' U2 R D' R' U2 R'`
  is `R2 [D, R' U2 R] R2'` - the same shape as Aa's "A commutator"
  (`x R' [U, R' D2 R] R x'`), insert against a quarter turn. A label in
  CHUNKS ("U commutator"?) would let the voice say it in one word. (S)
- **The standby mic listens continuously** whenever "ask me the case" is on
  with no cube connected, which means audio to Google's recogniser and a
  battery cost. A tap-to-arm or a wake word would be kinder. (M)
- **OCLL still shows the 3D cube**; PLL dropped it (`a7f175d`) because the
  top-down diagram is the case. Decide whether OCLL wants the same. (S)
- **`web/scripts/check-*.mjs` are the only net under `src/app/` and
  `src/ui/`** - see `docs/maintenance-plan.md` 4.6. Item 1 above widens it.

## What is already done (do not redo)

2026-09-23, later: the practice table sorts by any heading (tap again to
flip; remembered per drill), has a trend column (the last eight timed tries
against the eight before), and a graph under it with a line per case - its
running ao5 (ao3 until there are five) over every timed try of the stage,
a legend chip per case, a tap on a name in the table showing that case
alone (`ll/practicegraph.ts`). A tick under the cube picture hides it.
`scripts/check-practice.mjs` (`npm run check:practice`) seeds attempts into
the page's IndexedDB and checks all of it headlessly. `scripts/check-ll.mjs`
(`npm run check:ll`) is item 1's file, with one check so far (the alg on
show survives an undo back to the scramble); the rest are still to write.
PLL scrambles (2026-09-24) come from U, D, R2, L2 only, one or two moves
past the shortest, an R2 L2 pair shown as M2 with the turns after it
relabelled (`model.ts` sliceForm), never the <M2, U> algs themselves.

The case sheet's layout and name filter, per-alg favourites and notes, the
weighted draw, the watching voices, the 300 ms hold before a wrong turn is
called, the G-perm and Y-perm chunk names, the wide-move algs (Nb leads
with J Perm's `r`-version), repeat mode, the hands-free quiz. Chunk and
case claims in those commits were verified by running the algs, never from
memory - keep doing that (`test/fingertricks.test.ts`, `test/ll.test.ts`).
