# Housekeeping plan before M11 (2026-09-17)

**Status 2026-09-17, evening: items 1-5 done** (three by sonnet agents in
worktrees, merged; the wiring and the split in the main thread), plus the
recording sink, its client and session layer, and Record streaming to it;
the `puzzle` field is on every record. The `Puzzle` abstraction was
deferred by decision (`docs/other-puzzles-survey.md` 5: do it with the
2x2). Not done from section 6: the M11 phase splitting. Decisions taken
as proposed: unsure camera turns feed the drills (marked `?`), attempts
sync like solves.

The smart cube arrives Monday 2026-09-21. This is what to do with the
three days before it: the cleanup that pays for M11 and M13, in the order
that keeps every step shippable, plus what else can be built without the
cube. Items are numbered so feedback can be "do 1-3, skip 5, change 4".
Estimates are rough working-day fractions.

---

## 1. The camera reader as a `MoveSource`  (half a day; the structural one)

**Today.** The scanner hands `main.ts` a lock plus the reader's moves
(`onFollow(scan, moves, record)`); `follow.ts` turns that into a trainer
scramble and the stage change; the live view gets the camera's belief
through a side path in `onFollow`. The drills and the timer can only be
fed by the smart cube. When M13 makes the camera a real move reader it
would land into this second path.

**Plan.**
- `web/src/moves/readersource.ts`: `ReaderSource implements MoveSource`
  (`kind: 'camera'`), created at a lock from the lock's facelets and
  `colourOf`; `update(record)` on every follow poll. The reader's leading
  path can *rewrite* earlier turns as more frames arrive, so the source
  compares the record with what it has already emitted: new turns become
  move items; a changed prefix becomes a `resync` item to the new belief
  (the driver disarms and re-arms when the state matches again). A re-lock
  is a `resync` with `how: 'scan'`.
- `main.ts`: one `onSourceItem(source)` for whichever source is active
  (the cube when connected, else the camera); the live view and the
  driver read the active source. `followScramble` takes the source's
  state and letters; `StageFollower` is unchanged.
- Bonus: follow mode now checks the drill itself, like the cube does.
- Tests: `test/readersource.test.ts` with a scripted sequence of records
  including a rewritten prefix and a re-lock; the headless check unchanged.

**Decision to confirm.** Feed *unsure* turns to the drills or only sure
ones? Proposal: feed everything (the driver does not judge; the drill's
Check is the verdict and a re-lock corrects it), and show the `?` on
unsure turns in the moves box as the follow strip does today.

## 2. Names and duplicates  (an hour)

- `smart/sync.ts` (the belief reducer) becomes `smart/belief.ts`; it
  collides with `store/sync.ts` in every import list.
- One `ui/download.ts` (`downloadBlob`, `downloadText`) replaces the three
  copies in `scanner.ts`, `main.ts` and `timer/trainer.ts`.
- `relabelTurns` / `toSourceLetters` move from `follow.ts` to
  `handoff.ts`, which already owns the frame conversions
  (`trainerScramble`, `expectedFacelets`, the `frameMap` re-export);
  `follow.ts` keeps `followScramble` and `StageFollower`.
- CLAUDE.md's layout block updated.

## 3. Split the wiring out of `main.ts`  (an hour)

`main.ts` holds the scanner bridge, follow mode, the smart cube with its
driver and live view, and the sync controls (~350 lines). Split into
`app/context.ts` (hold, frontColour, the last scan, the active source),
`app/scanner-bridge.ts` (useInTrainer, onFollow, scanHooks), `app/smart.ts`
(connect, driver, live view, `ZZ.smart`), `app/sync-ui.ts` (the settings
sheet buttons). `main.ts` mounts the stages, calls `initShell`, and wires
the three. No behaviour change; the tests and the headless check are the
net.

## 4. Drill attempts into the store  (an hour, plus one record decision)

**Today.** The EO and last-layer tabs keep `results` arrays in memory for
the session-stats line and lose them on reload. M11's per-case memory and
M12's planning drills need attempts persisted.

**Plan.** A third store collection, `attempts`, synced like solves:

```
AttemptRecord { id, when, stage: 'eo' | 'ocll' | 'pll' | 'f2l' | 'plan',
  scramble (trainer letters), moves (typed or fed), time, recognition?, execution?,
  caseId?, optimal?, assisted, source: 'typed' | 'cube' | 'camera', editedAt, deleted? }
```

`drill.attempt()` returns the record and the trainers put it; the stats
line reads from the store (this session, today, all time). Sync on.

**Decisions to confirm.** (a) Synced to Firestore like solves (proposal:
yes, they are small). (b) `caseId`: the last-layer tabs have a case name;
EO has none yet (M11 will tag the pattern family), so it is optional.

## 5. Prune the old dev pages  (half an hour, after a look)

`public/{scan,autoscan,bbox,detect,scanner}.html` predate the single-page
trainer. **Done 2026-09-17:** an audit found all five to be identical
redirect stubs to `index.html?tab=scan` with no code, tooling or CI
reference (the `Record` / `?solve=1` flow runs on the trainer via
`tools/solve/replay_clips.py`). Four were deleted; `scan.html` stays as
the one redirect for old phone bookmarks. Doc mentions are historical and
were left.

---

## 6. Also possible before Monday (not cleanup)

- **M11 groundwork:** `web/src/analysis/phases.ts` and `metrics.ts`,
  pure functions over a solve record, tested on the synthetic captures
  and the recorded solves' typed truth. No cube needed. (a day)
- **The recording sink and continuous streaming** (design doc 4.2): the
  Vite route that appends one-second video chunks and events into a
  gitignored `recordings/<date>/<session>/`, and the scan sheet streaming
  instead of holding a blob. Testable with the webcam alone; the cube's
  events are one more stream on Monday. (half a day)
- **Timer extras:** graphs, subset scrambles (MILESTONES "Later").
- **Other puzzles:** the `Puzzle` abstraction is the first step of that
  track and is itself a refactor of `cube/` and the colour solver
  (`docs/other-puzzles-survey.md` 3). Decide before M11 whether it goes
  first, because M11's analysis would be written against it.

## Proposed three days

| day | work |
|---|---|
| Thu 18 | items 1, 2, 3, 5 (the cleanup; ship each) |
| Fri 19 | item 4; the recording sink and streaming, so Monday's first solves are saved |
| Sat 20 | M11 phases + metrics on recorded solves; or the puzzle abstraction, per feedback |
