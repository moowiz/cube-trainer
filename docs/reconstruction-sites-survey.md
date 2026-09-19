# Reconstruction databases as training data — survey (2026-09-15)

Question: could public solve-reconstruction databases (reco.nz and kin) train a
model to recognise cube solving on video? Sampled respectfully: 17 page fetches
from reco.nz total (index x2, about, faq, one reconstructor page, 12 solve
pages spread across the ID range), YouTube metadata only (no video downloaded).
Sample files were kept in the session scratchpad, not the repo.

## reco.nz — what a record holds

Site: PHP on LiteSpeed, server-rendered HTML, no API, no robots.txt (404),
no bulk download. URLs: `/solve/index?page=N&sort=id_asc&3x3=on...` (50 rows
per page, filters are checkbox names: puzzle `3x3`, `OH`, method `CFOP`,
`Roux`, `ZZ`..., `solver[]=Name`, `official`/`unofficial`), `/solve/<id>`,
`/solver/<Name_With_Underscores>`, `/reconstructor/<Name>`.

Per solve page (`/solve/14134`, Yiheng Wang 3.84):

- header: solver, time, puzzle, date, competition, reconstructor
- **scramble** (WCA notation) and the **full solution**, one line per step
  with a `// comment` (inspection, xcross, 2nd pair, ..., OLL, PLL), plus an
  alg.cubing.net link carrying both
- a step-split table: Total / F2L / LL / Cross+1 / OLS / PLL with **time,
  STM, ETM, TPS per step** (e.g. cross+1 ends at 1.00 s, F2L at 2.00 s,
  OLS at 2.87 s, PLL at 3.84 s) — these are hand-timed from the video
- the other solves in the same average, linked by id (5 for an official
  average; 37 for a Monkey League final; 240 for Max Park's ao100 video)
- **one YouTube embed for the whole video** — `embed/<id>` with **no
  `start=` offset**. The record does not say where in the video the solve is.

Sample (ids 500, 2000, 4000, 6000, 8000, 10000, 11500, 12800, 14134; 1 and
13600 are 404 = gaps): 9/9 live pages had scramble + solution + splits, 8/9
had a video. Puzzles: 7 3x3, 2 OH. Video groups sizes: 5, 5, 5, 240, 25, 52,
5, 5, 37.

Corpus size: ids run to ~14,150 (oldest are 2013 imports credited to Brest);
speedcube.quest, which aggregates reco.nz, reports 14,021 3x3 + 301 2x2
reconstructions from 597 solvers. Stewy alone has 7,414. Rough guess at
unique videos: 2–4k.

YouTube metadata for 5 sampled videos (yt-dlp, no download): 1080p at 24/30/60
fps, durations 75 s (a 2011 final), 128 s, 1,138 s, 2,446 s (ao100), and
**10,940 s** (3 h Monkey League broadcast). No chapters, no timestamps in
descriptions. Uploaders: the solvers themselves, competition organisers,
Monkey League.

## Is it useful for us?

What we'd get: video + exact move sequence + exact start state (scramble) +
coarse step timing, for ~14k solves. What we would NOT get: where the solve
is in the video, per-move timing, corner/face labels.

Domain gap against the move reader (`web/src/moves/`, `docs/solve-tracking-design.md`):

- Speed: elite 8–15 TPS at 24–30 fps is 2–3 frames per move; our target is a
  learner at 1–3 TPS on a phone. Broadcast footage barely contains the
  intermediate states our per-face detector + Viterbi reader depends on.
- Viewpoint: third-person table-height camera, hands covering two faces,
  cube 100–300 px in a 1080p frame; ours is above-and-close (settled
  2026-09-13).
- Alignment: to use any of it as supervision you first have to find the
  solve inside a 2 min–3 h video. Feasible (the average's list of times is a
  duration fingerprint; a timer display is often in frame) but it is a
  project in itself and each mistake is a wrong label.

Where it could plausibly help:

1. **Weak supervision for a sequence reader (CTC-style):** frames of a solve
   segment + the known move string, no per-move timing needed. This is the
   one training signal the record provides directly. Only worth it once the
   solve segment is localised, and only for a model meant to read fast,
   third-person footage — not our current reader.
2. **Pseudo-labelling detector data:** real cubes in real hands at real
   comps, huge visual variety (lighting, cube brands, stickerless, skin
   tones). Run our detector, keep confident quads, hand-check a sample. This
   is the most transferable use and needs no alignment at all.
3. **Stress-test corpus** for the move reader at speeds we never film.
4. **Scramble + solution pairs** as trainer content (real elite solutions per
   method, EO/ZZ filter exists) — an unrelated but real use.

Verdict: a good corpus for *someone* building a broadcast-speed solve
reader; for us it is a pseudo-label/eval source at best. Not a substitute for
our own webcam recordings with typed truth, which remain the bottleneck for
the reader (`move-reader-state` memory).

## Weak supervision with CTC — what it is and when we'd use it

**CTC (Connectionist Temporal Classification)**, Graves et al. 2006, is a loss
for training a sequence model when the output sequence is known but not
*when* each element happens. Speech recognition's problem (audio + transcript,
no phoneme timestamps) and exactly the shape of a reconstruction record:
video frames in, move string out, no per-move times. It is also exactly the
shape of our own recordings with *typed* truth.

### Mechanics

- The network emits, at every frame t, a distribution over K symbols plus
  one extra, **blank** (`_`). For a reader: the 18 face turns (R2 is its own
  symbol) + blank = 19 classes per frame. Slices/rotations either dropped or
  added as symbols.
- A frame-level path *collapses* to a string by (1) merging consecutive
  repeats, (2) deleting blanks. For the target `R U R'` over 8 frames these
  all count:

  ```
  _ _ R R _ U _ R'
  R _ _ U U U _ R'
  _ R _ U _ _ R' R'
  ```

- Loss = `-log P(target)` where `P(target)` is the sum over **every** path
  that collapses to it. Exponentially many paths, summed exactly by a
  forward-backward dynamic program in O(T x L). Gradient reaches every
  frame; the network decides on its own which frames "are" the R and which
  are transition blur, because putting the mass in the right place is what
  makes the sum large.
- **Repeats need a blank between them:** `U U` collapses to one `U` unless
  the path is `U _ U`. Two identical consecutive moves need at least one
  frame the model can call blank — fine at 30 fps for 3 TPS, tight at 14 TPS.
- **T >= L** (plus one per repeat). The clip must have at least as many
  frames as the target has symbols.
- Decoding: greedy (argmax per frame, collapse) is usually close to beam
  search. The non-blank spikes give a rough *alignment* as a by-product, so
  CTC models produce timestamps despite never being trained on any.

### What it would look like here

```
frames (T x H x W x 3) -> per-frame encoder (detector backbone or a small CNN)
                       -> temporal model (1D conv or small transformer over T)
                       -> per-frame logits over {18 turns, blank}
                       -> CTC loss vs the recorded solution string
```

Input: a localised solve segment (scramble applied -> solved). Label: the
solution string. reco.nz would give ~14k solves x ~55 moves = ~770k move
instances of weak supervision once the segments are found. The known
scramble adds a second signal — the full state at every point in the
solution — checkable per frame by a state head or our colour pipeline, but
only *after* CTC has produced an alignment; CTC is what breaks that
chicken-and-egg.

### Why it is not our next step

- It is an **end-to-end learned reader, a different architecture** from
  `web/src/moves/` (Viterbi over per-face detections + colour evidence,
  hand-built and interpretable, with the state-determined-gap reasoning in
  `docs/solve-tracking-design.md`). A CTC model replaces all of that with a
  black box that needs a lot of data to learn what geometry gives us.
- **The corpus is broadcast footage.** It would learn fast third-person
  solves at 2–3 frames per move. Transfer to a learner at 2 TPS filmed from
  above on a phone is fast->slow, far->close — not the easy direction.
- **Boundaries first.** CTC tolerates unknown *internal* timing, not unknown
  *ends*: a 3 h broadcast and a 55-move string just fails. The solve segment
  must be found to within a few seconds first (timer-in-frame detection, or
  matching the average's solve durations against hand-activity segments).
- **Runtime:** a temporal model over a frame buffer is heavier on a
  mid-range phone than the current ~3 ms/frame Viterbi.

### Where it fits

If the reader stalls on our own recordings and we end up recording hundreds
of solves with typed truth anyway, CTC is the right loss for *those*: typed
truth is a move string without timestamps, which is CTC's contract exactly.
The reco.nz corpus then becomes pre-training for that model. Framing: CTC is
the tool for the day we go learned; reco.nz is a pre-training set for that
day, not a shortcut to it.

## Who runs it / how to ask for a dump

- reco.nz's About page lists the team as "Angus (Senior Cloud Developer),
  Chunky Girl (Mass Data Analysis), Boots (Junior Cloud Developer), Monke
  (QA)" — in-joke names; it states the site is 100% community driven, no ads.
  No email, Discord, GitHub or socials anywhere on the site.
- The speedsolving wiki credits the site to **Stewy (Stuart Clark)**,
  **yomie** "and others"; Stewy has a personal reconstructions subreddit
  r/Stewy_ (Reddit is the one visible contact channel). There is a WCA
  profile "Stuart Clark" (2015CLAR14, Australia) that may or may not be the
  same person — unverified.
- .nz WHOIS: `whois reco.nz` or https://www.dnc.org.nz/whois — registrant
  may be privacy-withheld.
- **speedcube.quest** (`/reconstructions`, `/credits`) already holds an
  aggregated copy: 14,322 reconstructions credited to reco.nz plus 3,006
  recovered cubesolv.es entries from the Internet Archive. They have done the
  export once; a dump request could go to either party. No operator contact
  on their site either.
- Historic: cubesolv.es (offline; Brest-era data, archived), speedcubedb.com/r
  (shut down), r/econstructions, alg.garron.us/solves.

Sources: https://reco.nz/about, https://reco.nz/faq,
https://www.speedsolving.com/wiki/index.php/Reconstruction,
https://speedcube.quest/reconstructions, https://speedcube.quest/credits,
https://www.worldcubeassociation.org/persons/2015CLAR14
