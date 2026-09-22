# Test fixtures

Real-world captures from the scanner's debug buttons, used to reproduce color
misreads in unit tests without a camera (milestone M2).

Fixtures the tests still read (2026-09-22: everything no test read was
deleted; the file list is the contract - `grep` a name in `test/` before
adding to or pruning it):

- `cube-frame-<face>-<ts>.json` - **"Save debug frame"** from the M1 grid
  scanner: the clean camera frame (`imagePng` data URL), the grid rect +
  patch size, the 9 sampled cells (Lab + rgb). Named by the colour of the
  face's centre in cubejs's letter (B blue, D yellow, F green, L orange, R
  red). `lowlight.test.ts` (ten frames: underexposed and backlit faces) and
  `rectify-real.test.ts` (two) read them.
- `cube-scan-<ts>.json` - **"Save scan report"** from the M1 review screen:
  all six captured faces (Lab + rgb). `colour-replay.test.ts` feeds four of
  them to the colour solver as six single-frame tracks (the blue monitor
  cast that must refuse, the kitchen evening, the second cube, the matte
  cube).
- `scan-debug-<ts>.json` - **Capture debug** of the M6 namer: the naming
  evidence for one detection tick (exemplars, each quad's centre/cells in
  the naming space, the ranked distances). `-1789290592829` /
  `-1789290604959` are the blue-named-green lock-in that
  `exemplar-guard.test.ts` pins down; `-1789291642684` (all six measured) /
  `-1789291701546` (fresh session, three measured) are the red-as-orange
  readout and the runaway prior fit (`naming-space.test.ts`).
- `session-0913/scan-debug-*.json` - three captures of one afternoon on one
  cube (state pinned by the 08:06 lock, confirmed by photos), each stalled
  with a colour-count error at 49-53/54 correct: a shadowed blue read as
  white, bright reds as orange, one junk cell. `colour-replay.test.ts` feeds
  their per-face cells to the solver as six single-frame tracks (the k-means
  assembly they were captured for went with the grid scanner, 2026-09-14).
- `facekp-maps-*.json`, `roi-label-480x640.json`, `fto-oracle.json`,
  `smart/`, `solves/`: the detector decode, the crop geometry, the FTO
  oracle (`scripts/fto-oracle.mjs`), the smart cube's captures and the
  recorded solves the move reader replays (`moves-replay.test.ts`).

Tap-to-fix and the M1 workflow it fed are gone (CLAUDE.md); a wrong lock is
rescanned, and the fixture for a colour problem is an evidence log (below).

## Evidence logs (the colour solver's fixtures, 2026-09-13 onwards)

`Capture debug` on the scan tab now writes the whole **evidence log** of the
session (`evidenceLog`: every quad's nine readings with their quality
weights, every letter-free shared-edge pairing, track births/deaths) plus
the solver's last `solution` and `params`. The solver
(`web/src/colour/solve.ts`) is a pure function of that log, so the capture
reproduces the phone exactly. To turn a capture into a regression test:

1. Put the JSON in `fixtures/evidence/` (any name).
2. Add a top-level `"truth": "<54 facelets>"` when the state is known (a
   scramble applied from solved + cubejs, or a confirmed lock), and
   optionally `"note"`. A capture made with the "I applied it" box ticked
   already carries `scrambleTruth` and needs neither.
3. `colour-replay.test.ts` runs every file there, asserts the ensemble
   never answers wrong and matches `truth` when present; `npm run bench`
   also prints the bake-off table over every embedding.

The older `scan-debug-*.json` / `session-0913/` captures predate the log
and hold only per-face consensus cells; the replay test feeds those to the
solver as six single-frame tracks (the dead-on-only path).

### Clip replays

`index.html?tab=scan&clip=/clips/<name>.mp4&autostart=1&autocapture=1&post=<file>.json`
plays a recording through the live pipeline and, at the end, POSTs the
capture to the dev server, which writes it here (vite `captureSink`,
dev only). Clips live in the gitignored `web/clips/` (transcode phone
HDR video to 480x854 SDR H.264 first; the imageio-ffmpeg binary in
`model/.venv` works). Headless Chrome runs it without a display:
`chrome --headless=new --user-data-dir=<scratch> --ignore-certificate-errors
--autoplay-policy=no-user-gesture-required --enable-logging=stderr <url>`;
the console prints `CLIP ENDED ...` and `CAPTURED ...`. `clip-*.json` here
are the 2026-09-12 evening clips (dead-on faces in front of a monitor -
the hardest lighting we have; both refuse honestly today).
