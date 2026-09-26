# UI redesign: the inventory and the findings (2026-09-26)

Appendix to `docs/ui-redesign.md`: every control on every tab and
sheet, the state machines, and every duplication, inconsistency and
suspected bug found.

**Where this comes from**
- Read from the code at `6b96698`. Line numbers drift; the ids and
  strings are the stable handles.
- "Verified" means seen in a headless replay or a screenshot. Anything
  else is from reading the code: check it before fixing.
- Paths are under `web/src/` unless given in full.

---

## 1. The header and the shell

The tab bar is in `index.html:92-107`; the wiring is in `shell.ts`.
Under 600 px the text labels and key hints are hidden, so the phone
gets icons only.

| Button | id | Visible | Does |
|---|---|---|---|
| Solve / EO / F2L / OCLL / PLL | `data-t` | always | `showTab`; remembered in `zz-tab` |
| 📷 Scan (c) | `scan-open` | always | a fresh scan sheet |
| ↩ Resume (r) | `scan-resume` | after the first scan, then **never hidden again** (`shell.ts:136`) | reopens the scan in progress |
| 🧊 Cube (l) | `cube-open` | always; spins while reconnecting, green once on (`app/smart.ts:124-134`) | the Cube sheet |
| 📖 Algs (a) | `algs-open` | always | the Algs sheet (loaded on first open) |
| ⏺ Record | `rec-open` | only where the dev server's sink answers | records the sitting; docks the scanner |
| ⧉ | `rec-pop` | while recording | pops the camera out |
| ⟳ Syncing / ⚠ | `sync-warn` | while syncing or on a warning | opens Settings |
| ⚙ (s) | `settings-open` | always | Settings |

**Also in the shell**
- The version chip at bottom left (`public/nav.js`) shows
  "{hash} · {models}" and overlaps content on phones (verified).
- The global keys (`shell.ts:174-183`): c, r, l, a, s and Escape.
  They are case-sensitive, and ignored while a sheet is open or an
  input has focus.
  - Escape closes the first open sheet, **including a docked scanner**.
- The Settings subtitle claims "Keys on any stage: c scan, r resume, l
  cube, a algs, s settings, n new, Space timer, Esc close". F2L has
  neither n nor Space; EO's `m` (toggle the bad-edge marks) and F2L's
  ← → are not listed.

**The shared-scramble bus** (`shell.ts:32-54`)
- `shareScramble(scr, from)` loads the scramble into every tab except
  the sender and the kept tab. It only counts when the sender is the
  open tab.
- The Solve tab takes every share, converted to WCA (`timer/trainer.ts:584`).
  - So a PLL case's setup becomes the Solve tab's scramble, and a
    solve on it is filed in the 3x3 session.
  - Receiving a share also resets a manual attempt in progress
    (`timer/trainer.ts:141-142`).
- Other tabs' scrambles land on F2L, which then says "EOCross is not
  solved on this scramble…". Meanwhile the chips and result keep
  describing the previous F2L scramble (`f2l/trainer.ts:497-499, 900-906`).

---

## 2. The Solve tab (`timer/trainer.ts:107-129`)

**Controls, top to bottom**

| # | Element | Text | When |
|---|---|---|---|
| 1 | `h1` + `#tm-sub` | "Solve" / "Scramble, solve, repeat. With a smart cube the timer arms itself when the scramble is on the cube and stops when it is solved; without one, Space." | always |
| 2 | `#tm-next` | "New scramble" (also n) | always |
| 3 | `#tm-scr` | the scramble in WCA, primes red, 2s blue; done turns grey underlined | always |
| 4 | `#tm-track` | "{a} of {n} applied", "Scrambled ✓", amber "Off the scramble after …: undo with …" | with a cube or camera source |
| 5 | `#tm-solBtn` / `#tm-solText` | "Show a solution" / "Hide the solution": Kociemba from the belief, followed along | always, **including while timing**; its open state survives new scrambles |
| 6 | `#tm-follow` | "As I solve: Stay here / Follow into the stages" (`zz-solve-follow`, default follow) | only with the smart cube and the Settings follow on |
| 7 | `#tm-pad` / `#tm-time` / `#tm-state` | 72 px time; "Press here (or Space) and release to start · tap to stop" / "Scrambled · the first turn starts the timer" / "Solving… tap to stop" / "{t} · {n} turns · {tps} TPS" | always |
| 8 | `#tm-last` | "#N: …" + OK / +2 / DNF / Delete (confirm, soft delete, no undo) | idle, once a solve exists |
| 9 | `#tm-session` / `#tm-newsess` | "{name} · {span} · {count}"; New session → `prompt()` | always |
| 10 | `#tm-stats` / `#tm-graph` | "N solves · best · mean · mo3 · ao5 · ao12 · ao50 · ao100", "best ao5 · best ao12"; Graph → the Stats sheet | always |
| 11 | `#tm-list` / `#tm-moreBtn` | the last 30 solves (index · time · scramble · turns · tps · when); click selects; "Show all" | always / over 30 |

**The timer settings in Settings → Timer**
- Stored in `zz-timer-settings` (`index.html:130-142`).
  - "Next scramble by itself" (Off / On).
  - "Sounds" (Off / On): 880 Hz when armed, 1320 Hz at every finish.
    Only this tab beeps.
  - "Scramble voice": Off / Reads the next move / Says my moves /
    Only wrong turns.
- Also in the same section, though not timer settings: "Keep the
  screen awake", "Sync times" and "History" (Import csTimer / Export /
  Export csTimer).

**A smart-cube solve, state by state** (`timer/trainer.ts`, `moves/drive.ts`, `app/sources.ts`)
1. **Scramble shown.** The track line is empty; the first move is read
   in read mode.
2. **Following.**
   - The applied prefix is underlined and the track line reads
     "{a} of {n} applied".
   - Voice by mode: read / echo / watch.
3. **Wrong turn.**
   - Amber "Off the scramble after …: undo with …".
   - After 300 ms, every mode except Off says "wrong. undo …".
   - "back on" when the cube returns to the path.
4. **Armed.**
   - "Scrambled ✓", the time reads "ready" in green, 880 Hz beep.
   - There is no inspection countdown (a decision of 2026-09-17).
   - With "Follow into the stages", the carry starts here.
5. **Timing.**
   - The first turn starts the timer.
   - **The track line turns amber: "Off the scramble: undo back to
     turn N (underlined)" for the whole solve (verified,
     `now-phone-solve-timing.png`).** `watch()` and the render don't
     look at the phase.
6. **Solved.**
   - The time, a 1320 Hz beep; the solve is saved with its move stream
     and inspection gap and auto-selected.
   - The session rolls over after a 2 h gap, with a toast.
7. **Next.** With autonext the next (prefetched) scramble appears at
   once.

**Oddities (from reading the code)**
- **The idle hint sticks.** `lastLine` is never cleared, so after the
  first solve the "Press here…" hint never shows again.
- **"Last:" never shows.** Each finish auto-selects its solve, so the
  row reads "#N:".
- **A tap-stopped cube solve with autonext off** leaves the driver
  armed. The next turn starts a timing that includes every turn since
  arming.
- **Leaving the Solve tab by hand mid-solve** (Stay here, or the
  follow off): the timer keeps counting but never hears "solved".
- **Unused CSS:** `.tm-time.insp.warn`.

---

## 3. The Cube sheet, the auto-connect and the follow

**The Cube sheet** (`ui/cubeview.ts:112-135`, `app/smart.ts`)

Header: "Your cube" plus a six-line subtitle on a phone. The controls:

- **Chip:** No smart cube / {name} disconnected / {name}: out of sync
  (amber) / {name} connected (green).
- **Buttons:**
  - Connect a smart cube.
  - Disconnect. After it, no auto-reconnect until Connect or a reload.
  - Save capture (JSONL).
- **The "Reconnect the cube on load" checkbox:**
  `cube.smart.autoconnect`, default on.
- **The busy line:**
  - "No auto-connect: {why}";
  - the Chrome permissions flag;
  - "gave up on {name} after 12 tries".
  - "No Web Bluetooth" is said twice: here and in the status line.
- **The status line:** protocol · battery · gyro · the cube clock
  fit · "the cube confirms the state".
- **The out-of-sync box:** "Trust the cube / It is solved / Use the
  last scan".
- **The live view:** 3D (drag) and a net, in the trainer hold.
- **The badge:** "From {source} · last turn R′ 1.2 s ago · N turns
  this session".
- **The resync row:** "Tell the smart cube what it is: Solved / The
  last scan / What the cube reports". This is the same three actions
  as the out-of-sync box, in other words.

**The follow** (`app/cubefollow.ts`, `follow.ts`)

*Settings*
- **The master switch:** Settings → Cube → "Follow my solve on the
  smart cube".
  - Stored in the **scan sheet's** settings record
    `cube.scan.settings.v1` (keep-awake is also stored there).
  - Effective only with the smart cube as the source.
- **The Solve tab's own choice:** "Stay here / Follow into the
  stages" (`zz-solve-follow`).
- **The camera follow:** the scanner's "follow my solve" checkbox.
  - It ignores the Solve tab's choice, and at solved it only toasts
    (`app/scanner-bridge.ts:94-119`).

*Tab switches, on every turn* (`cubefollow.ts:161-205`)
- **When the cube passes the furthest stage reached:** it loads every
  tab, shows the new stage's tab, arms that drill, toasts ("EOCross
  done → F2L", "F2L done → OCLL", "Corners oriented → PLL") and
  scrolls to the top.
- **No switch** while the open tab's scramble is being applied.
- **At solved:**
  - a carried Solve returns to the Solve tab;
  - a solve picked up by hand, or started on Solve, also returns
    there, even with "Stay here";
  - a drill's own case stays on its tab.

*The 15 s rest rule* (`cubefollow.ts:208-233`)
- A hand-scrambled cube, still for 15 s and off the open tab's path,
  opens its stage.
- Except: on the Solve tab between solves (it is a mis-scramble to
  undo there), and while the open drill is armed on its own scramble.

*A carried solve*
- The Solve tab is pinned and kept (`keepScramble`): the timer runs
  underneath and **its running total is visible nowhere**.
- The drill tabs arm and run their own stage timers.
- The voice is muted and the quiz skipped (`voice.ts:40`,
  `ll/trainer.ts:1109`).
- But **the drills' judging and attempt filing are not gated**, so
  attempts may be filed during a carried solve.

---

## 4. The OCLL and PLL tabs (`ll/trainer.ts`, on `ui/drill.ts` in quiet mode)

**Layout**
- **Phone:** header, then the picture column, then the work column.
  The alg panel sits under every option.
- **Desktop:** a 340 px sticky left column, and the options and result
  on the right.

**Left column**
- The 3D cube:
  - OCLL: always.
  - PLL: only when the cube is not at the last layer (started early,
    or a handed-over cube).
- The top-down diagram (arrows on PLL).
- A "picture" tick that hides both (`settings.pic`).
- The case line: blank while a case is live.
- The cycle counter ("4 / 21").
- **The timer: 14 px grey** (`drill.ts:161`).
- The scramble line, "Scramble WCA style: …", and the track line.

**Right column, all always visible** (stored in `zz-{kind}-settings`)
- A chip, "All 7 cases" / "All 21 cases", that opens the case sheet.
- **Start from** (select):
  - PLL: "the PLL" / "OCLL" / "the last F2L pair".
  - OCLL: "OCLL" / "the last F2L pair".
  - Changing it makes a new case.
- **"Show the alg once I start (or answer)"**
- **"Next case when solved"**: a new case 1.5 s after a solve.
- **"Repeat the algs (no scramble)"**
- **Cases come:** "at random" (weighted) / "each once, in a cycle".
- **Voice · scramble** and **alg**, each: nothing / reads me the next
  move / says the moves I make / only when I go wrong. Changing one
  speaks a confirmation.
- **"ask me the case"**: speech recognition. In Chrome that means
  Google's servers; it is the one thing that leaves the phone.
- **Fold "Chunks the voice names: all 34":** a tick per chunk, plus
  name all / read all. It changes the voice only; the labels on alg
  lines are always drawn.
- **Fold "What to say when asked the case":** only when the quiz is on
  **and** the tab is PLL.
- **Fold "Cases in the drill":**
  - the chain pairs as "A ↔ B" pills, the other cases as chips;
  - all / none;
  - family links (A G J N R U);
  - an amber tint on a picked case's missing chain partner.
- **Fold "Practice so far: what to work on":**
  - a sortable table: case, tries, best, recent, trend, recog., exec.,
    named, last;
  - a per-case ao5 graph;
  - "Drill the five to work on / the eight / the unpractised".
- **Hidden by quiet mode:** Start timer / Reset, the moves box, Check,
  Clear and **✋ Fingertricks**. So the Fingertricks sheet can't be
  reached here.
- **The flash line** is red (`drill.ts:175`) but shows plain info
  ("Copied.").
- **The result / alg panel:**
  - the title, the hint "For the alg: …", the alg lines with AUF
    brackets and chunk labels, ▶, a note field per line, and "Other
    algs (N)";
  - after a solve: "PLL done in 14 moves, 2.31s", the case, "You
    peeked", "You said: T: right";
  - OCLL adds "Continue to PLL with this cube".
- **"Show my note"**: only when the main alg has a note. It marks the
  attempt assisted.
- **"Show the alg"**: always. It marks the attempt assisted.
- **The session line:** "This session: 3 solved, mean 2.41s, …".

**The loop with a smart cube**
1. New case: the scramble line appears, then the scramble.
2. Apply it: tracked, voiced.
3. Armed: recognition time starts, and the quiz asks "what case?".
4. The first turn: the timer starts and a held alg is revealed.
5. The alg in progress:
   - done moves underlined;
   - read mode says chunk names;
   - echo merges L and R into M;
   - **the track line turns amber "Off the scramble: undo back to turn
     N"** (verified, `now-phone-pll.png`).
6. A wrong turn: "Off the alg after … — undo with …" in the result
   panel, which is hidden when the alg is hidden, plus the voice.
7. Solved: the result, the voice ("T perm, 2.3"), and with the follow
   on a toast as well. Three ways of saying the same thing.
8. The next case after 1.5 s, if that option is ticked.

**Without a cube**
- Space starts and stops the small timer.
- Nothing is recorded; the only record-producing path is the
  hands-free quiz ("ready", "next").

**Oddities**
- The quiz is silently skipped with an earlier start, but the pictures
  stay hidden until the solve.
- "Drill this case" in the case sheet does not drill that case in
  repeat mode, and does not change the pool otherwise.
- **The OCLL quiz is half there:** no "What to say" help, and the
  parser has no words for S, P or L, so Sune, Anti-Sune, Pi and the
  bowtie can't be named aloud.
- "Start from" labels mix "the PLL" / "OCLL" / "the last F2L pair".
- "Show the alg" after a solve replaces the result (time, case,
  Continue) with the alg view.

**The case sheet** (`ll/reference.ts`, `ui/refsheet.ts`)
- **Title and chains:** "PLL: the 21 cases", then the chains line.
- **Filters:** a name box (autofocused with a mouse); PLL adds a
  "By corners, edges and sides" chip fold and a count line.
- **Cards:** diagram, name, moves, chain pill, the main alg with
  chunk labels and ★ (tap for the standard alg), the hint, a note
  textarea, "N other algs" (each with ☆ and a note), "Drill this
  case", "▶ play it in 3D", and tags.
- **No Practise toggle:** the pool is picked in the drill.

---

## 5. The EO tab (`eo/trainer.ts`, on `ui/drill.ts`, not quiet)

**Header:** "EO trainer", then "Orient every edge to the green/blue
axis[ and build the white cross]. White down, green facing you.", then
"New scramble".

**Left column**
- The 3D cube or net, with "Peek back" and "Reset view".
- `#eo-bad`: "4 bad edges" / "EO solved · cross 2/4".
- **The timer: 30 px.**
- The scramble: "Scramble:", plain text, **no tracking and no voice**.
- The hold paragraph ("Apply it to a solved cube held white on top …
  then turn it white down …").

**Right column**
- **Hint chips:**
  - bad edges;
  - move count;
  - F/B plan (marks the attempt assisted);
  - EO strategy;
  - "Strategy for this scramble" (assisted).
- **Buttons and moves box:**
  - Start timer / Reset;
  - "Solve EO on your cube… Space starts and stops the timer.";
  - the moves box with Enter to check;
  - Check / Clear / ✋ Fingertricks.
- **The result:**
  - "EO not solved yet…" / "EO solved, 3.21s" / "EOCross done in N
    moves";
  - "Continue to F2L with this cube".
- **"Show optimal EO solutions":** grouped by F/B plan, yours marked,
  tap to fill, ▶ to show.
- **The session line.**

**Settings → EO trainer** (`zz-eo-settings`)
- Goal: EO / EOCross.
- Show bad edge count.
- Mark bad edges.
- View: 3D / Net.
- Bad edges in scramble: Any / 2 / 4 / 6 / 8.

**With a smart cube**
- The moves box fills itself and Check fires at the goal, so Start
  timer, Check and Clear still show but are redundant.
- With goal EO, feeding stops at EO, so "Continue to F2L" only appears
  if the cross happened to be done too.

---

## 6. The F2L tab (`f2l/trainer.ts`, its own markup, not the scaffold)

**Layout:** a 900 px header down to the pair chips; below it, a 340 px
cube column and the result. It becomes one column under 760 px, so
on a phone the algs come after the cube, the views, the net, the
legend and three buttons.

**The four modes, and which controls serve which**

| Element | TAP (find a case) | TRACK (practice scramble, no cube) | CUBE (smart cube / camera) | PICK (picked cases) |
|---|---|---|---|---|
| Intro 1: "Tap the facelet where the **white** sticker…" | yes | irrelevant | irrelevant | irrelevant |
| Intro 2: "…press **Solved, next pair**…" | – | yes | contradicts (the pairs advance by themselves) | – |
| "The principles behind the cases" (8 points) | reading | reading | reading | reading |
| "F2L practice scramble" | – | yes | yes | – |
| "Practise picked cases" | – | – | – | yes |
| "✋ Fingertricks" (the scramble only) | errors | yes | yes | yes |
| Picked line + "their mirrors on the other slots too" + "other pairs solved" | shown | shown | shown | yes |
| Scramble line `#scrfollow` | other tabs' scrambles | tokens | progress, then folded "Scrambled ✓ (N turns) · the pairs follow your cube" | the setup only |
| Message line `#scrmsg` (instructions, status and errors in one line) | – | yes | yes | yes |
| "New practice scramble when the cube is solved" (`zzf2l-rescramble`) | does nothing | does nothing | yes | yes |
| "Practice so far" (table + graph) | – | – | – | yes |
| Pair chips → cards (case, head, alg, shortcut); ← → | slot picker | cards | cards | cards |
| "All 83 cases", "Hide the cube" (`zzf2l-hidecube`) | yes | yes | yes | yes |
| Hint box (Settings → F2L) | yes | yes | yes | yes |
| 3D cube (tap to place), View Front/Back-right/Back-left/Bottom, "Show as a net", legend | yes | still live | still live | – |
| Random case, Clear pieces | yes | still live (Random case + Did this corrupts the history) | still live | – |
| "Start over (new EOCross)": makes no EOCross, leaves the scramble line | – | yes | yes | yes |
| Result: title, where the pieces are, alg rows (Explain, Animate → alg.cubing.net), shortcuts | yes | yes | ringed and followed; off-alg warning | yes |
| "Did this" | – | yes | hidden | yes, without a cube |
| "Solved, next pair" | marks solved | applies the first alg | redundant (and overridden by the cube) | – |
| Footer: "…adjusted for the exact position you tapped" | yes | wrong wording | wrong wording | – |

**Settings → F2L**
- "Show the hint above the cube".
- "Show advanced algs (D, F2, slice and wide moves)".
- Both are stored only inside F2L's state string. **The page URL
  carries F2L's state on every tab** (`saveUrl`).

**The case sheet** (`f2l/reference.ts`)
- **Titles and subtitle:** the title is "ZZF2L: the 83 cases of a
  slot" (the static head says "Cases"; the button says "All 83
  cases"), followed by a long subtitle.
- **Filters:**
  - slot chips;
  - a name box;
  - a feature-chip fold: corner, edge, which sticker is up, both on
    top, algs, practice.
- **Cards:** a 3D picture, the alg with triggers, ☆/★, the own-side
  line, a note, other algs, "Set in finder" (ends tracking without
  saying so), "▶ play it in 3D", "Practise" / "✓ Practising".

**Bugs from reading the code**
- **The instruction is erased at once.** The "Apply this to a solved
  cube…" instruction is overwritten by `applyScramble()`'s "Tracking
  your cube…" in the same call (`:689-690`).
- **"F2L practice scramble" with an unsolved cube** shows "Off the
  scramble: undo back to turn 0", while "Practise picked cases" builds
  a setup from the cube.
- **The scanner's check line on F2L** shows the full from-solved
  scramble, while the tab shows the setup.

---

## 7. The scan sheet (`ui/scanner.ts`, `app/scanner-bridge.ts`)

**Widths**
- **Under 820 px:** full screen.
- **820 px and up:** a centred box, up to 1900 px wide.
- **1100 px:** two columns.
- **1500 px:** three columns.

| Element | Who |
|---|---|
| "▸ model ready: …" status (amber monospace) | developer |
| **Check** line: the stage's scramble, "N of 54 stickers read, all match ✓", New scramble | user |
| **Scramble** fixture row with "I applied it" (hidden by the check line) | developer |
| **Moves** input + **Record** (a move-tracking fixture), **live on the deployed site** | developer |
| Start/Stop camera, Reset scan | user |
| Pause, Save frame, "pause on lock" | developer-ish |
| "follow my solve" | user |
| Camera + overlay; the hint banner ("Move closer…", "More light…", "Glare…") | user |
| Lock badge; the follow strip (net, "N turns read", Stop) | user |
| **Face evidence**: six bars named **by letter** ("U white 0%"), against the project's say-colours rule | both |
| Unread-faces line, the technical note | developer |
| Lock result: "Locked ✓", "This is the scramble ✓", **the raw 54-letter string**, the certificate line, the hold line, the solution, **"Practice in the EO trainer"** (always "EO", whatever the stage) | mixed |
| Decoded faces, Pipeline, Debug controls (EP, detect rate, view sync, overlays, exposure, Capture debug) | developer |

**After a lock**
- **Follow off:** the sheet closes and routes to the cube's stage.
- **Follow on:** it docks into a 300 px corner card.
- **Either way the lock result is barely seen.**
- One error uses `alert()` where everything else uses toasts.

---

## 8. The other sheets

- **Algs** (`algs/sheet.ts`):
  - A picker: 3x3 LL, 2x2, 4x4, 5x5, Pyraminx, Skewb, FTO (`zz-algs`).
  - The "3x3 LL" entry duplicates OCLL/PLL in another card design.
  - The subtitle says "for the other puzzles".
  - Cards have "▶ play it here" (inline) and "▶ play it in 3D" (the
    external site). The same words mean the inline player in the
    case sheet.
- **Fingertricks** (`ui/fingertricks.ts`):
  - Opened only from EO, the drill scaffold (hidden on OCLL/PLL) and
    F2L's scramble button.
  - The F2L algs have Explain and Animate but no fingertricks.
- **Stats** (`timer/graph.ts`):
  - Opened only from the Solve tab's "Graph".
  - This session / All sessions (not remembered); the ao toggles are
    remembered.
  - A table fold.
- **Recording:**
  - The header's Record is dev-server only.
  - The scan sheet's Record row is on the deployed site too.
  - Both drive one recorder.

---

## 9. Every duplication and inconsistency, in one list

1. **The voice is set in two places with two wordings:**
   - Settings → Timer "Scramble voice" (Off / Reads the next move /
     Says my moves / Only wrong turns);
   - the LL tabs' inline selects (nothing / reads me the next move /
     says the moves I make / only when I go wrong).
   - EO and F2L have none.
2. **"Next when solved" has three names:** "Next scramble by itself"
   (Settings), "Next case when solved" (LL), "New practice scramble
   when the cube is solved" (F2L). EO has none.
3. **Three follow controls:** Settings, the Solve tab and the scanner.
   The camera follow ignores the Solve tab's choice.
4. **Three Continue buttons, styled differently:** EO and OCLL are
   primary, F2L is plain, PLL has none. The follow usually moves you
   first.
5. **The timer is a different size and place on each tab:** 72 px pad,
   30 px, 14 px, none.
6. **Space works three ways:** Solve arms on press and starts on
   release; the drills toggle on press; F2L does nothing.
7. **The scramble is shown four ways;** EO's is not tracked. The hold
   is explained on EO and F2L only, and each says it differently.
8. **Settings live in four patterns:**
   - LL: all inline.
   - EO: all in Settings.
   - F2L: split between Settings and inline.
   - Solve: split between Settings and inline.
9. **Picture toggles are inverted and differ per tab:**
   - "picture" (tick to show) vs "Hide the cube" (tick to hide).
   - Views: Peek back/Reset view vs Front/Back-right/Back-left/Bottom
     vs drag only.
10. **Case sheets are opened and used differently:**
    - opened by a chip vs a button;
    - "Drill this case" vs "Set in finder" + "Practise";
    - the pool picked in the drill vs in the sheet.
11. **The practice views are worded differently** ("Drill the five" vs
    "Practise the five"). F2L's practice fold is styled like the
    principles fold.
12. **The reveal labels differ:** Show the alg / Show optimal EO
    solutions / Show a solution.
13. **"New" differs:** New case / Next alg / New scramble / F2L practice
    scramble / Practise picked cases / Random case / Start over (new
    EOCross). There are three "New scramble"s: the Solve tab, n, and the
    scan sheet.
14. **"Play the alg" has four names:** Animate (external), ▶ play it in
    3D (inline, cases), ▶ play it here (inline, algs), ▶ play it in 3D
    (external, algs).
15. **Resync is worded twice** in the Cube sheet: Solved / The last
    scan / What the cube reports vs It is solved / Use the last scan /
    Trust the cube.
16. **Cube settings are split** between the Cube sheet (reconnect on
    load) and Settings (follow, colour facing you).
17. **Storage is mixed:**
    - Keep-awake and the follow master are inside the scanner's record.
    - The keys are `zz-*`, `zzf2l-*`, `cube.*`.
    - The session is in IndexedDB.
18. **Two "Resume"s:** the header's (the scan in progress) and the lock
    badge's (un-pause).
19. **"Practise" vs "Practice"** as the verb, in different places.
20. **The page title and tab names differ:** tabs say Solve / EO / F2L /
    OCLL / PLL; headings say "EO trainer", "ZZF2L case finder".
21. **The drill scaffold assumes the moves box** that quiet mode hides
    (the ▶ title "(and put them in the box)"; the red flash line).
22. **Solve feedback repeats on PLL:** the result panel, the voice and
    a follow toast.
23. **"Colour facing you" claims "every stage, scramble and scan uses
    this",** but the Solve scramble is always WCA (correctly), and the
    Cube sheet's view is in the trainer hold.
24. **Solved stickers look different** in the F2L 3D view (opacity .85)
    and the net (.38).

## 10. Suspected bugs, in one list

| # | What | Status | Where |
|---|---|---|---|
| 1 | Amber "Off the scramble: undo back to turn N" through every timed smart-cube solve (Solve) and every alg (OCLL/PLL) | **verified** | `timer/trainer.ts:166-174, 509-517`; `timer/track-ui.ts:40`; `ll/trainer.ts:505-511` |
| 2 | The version chip covers content on phones | **verified** | `public/nav.js` |
| 3 | The F2L instruction is overwritten at once | code | `f2l/trainer.ts:689-690` |
| 4 | The Solve tab takes drill-case shares (a PLL setup timed as a 3x3 solve) and resets a manual attempt | code | `timer/trainer.ts:141-142, 584` |
| 5 | Escape with a docked scanner closes it **and** discards a running solve | code | `shell.ts:176`, `timer/trainer.ts:335` |
| 6 | Drill attempts may be filed during a carried solve | code | `ui/drill.ts:363-384` |
| 7 | Fingertricks unreachable on OCLL/PLL | code | `ui/drill.ts:208, 226-230` |
| 8 | The OCLL quiz can't hear Sune / Anti-Sune / Pi / L | code | `ll/hear.ts:7-12` |
| 9 | "Start over (new EOCross)" makes no EOCross | code | `f2l/trainer.ts:990` |
| 10 | "Practice in the EO trainer" whatever the stage | code | `ui/scanner.ts:684` |
| 11 | "↩ Resume" never hides | code | `shell.ts:136` |
| 12 | A tap-stopped cube solve with autonext off: the next turn times from the old arming | code | `timer/trainer.ts:264`, `moves/drive.ts:48-52` |
| 13 | F2L keeps describing the old scramble after another tab's share | code | `f2l/trainer.ts:497-499` |
| 14 | "F2L practice scramble" on an unsolved cube: "undo back to turn 0" (the picked-case button builds a setup instead) | code | `f2l/trainer.ts:694-698` vs `:709-715` |
| 15 | The Settings key list is wrong for F2L; `m` is undocumented | code | `index.html:123` |
