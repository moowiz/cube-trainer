# Test fixtures

Real-world captures from the scanner's debug buttons, used to reproduce color
misreads in unit tests without a camera (milestone M2).

Two kinds of JSON files, both produced on the deployed app / dev server:

- `cube-frame-<face>-<ts>.json` — **"Save debug frame"** while scanning: the
  clean camera frame (`imagePng` data URL), the grid rect + patch size, the 9
  sampled cells (Lab + rgb), and everything captured so far. Save one while
  the misread is on screen.
- `cube-scan-<ts>.json` — **"Save scan report"** on the review screen: all six
  captured faces (Lab + rgb), the k-means letters before any tap-to-fix
  (`autoLetters`), the corrected letters (`lettersAfterFixes` — i.e. ground
  truth once you've fixed them), centroids, confidences, and validation.

Workflow when the scanner misreads (e.g. red/orange under warm light):

1. Scan, fix the wrong stickers by tapping (that records the ground truth),
   press **Save scan report**. Optionally also **Save debug frame** on the
   offending face during a rescan.
2. Get the files off the phone (share/email/Drive) and drop them here.
3. Write a test that loads the fixture and asserts classification matches
   `lettersAfterFixes` — it should fail, then fix the classifier against it.
- `scan-debug-<ts>.json` — **Capture debug** on scan.html: the naming
  evidence for one detection tick (exemplars, each quad's centre/cells in the
  naming space, the ranked distances). `-1789290592829` / `-1789290604959` are
  the blue-named-green lock-in that exemplar-guard.test.ts pins down;
  `-1789291642684` (all six measured) / `-1789291701546` (fresh session, three
  measured) are the red-as-orange readout and the runaway prior fit.
  `-1789308171326` (evening, phone) is the adjacency cascade: a stale
  rotation on a swapped track bound the yellow cluster "orange" and the
  orange cluster "blue" from one frame each, leaving the real blue with no
  name; `-1789308736891` (daylight) is the split green (lit vs shadowed side,
  22 apart) that ate the sixth cluster slot and forced the white centre into
  it - both pinned by colorid.test.ts (bindings need a vote quorum and a
  chromatically possible colour, ranks beat bindings, leftover clusters
  alias, red/orange split by hue gap).
  `-1789309733443` (daylight, all six faces filled, clusters right) is the
  lock that failed with "U appears 8 times": the old cell-keyed voter blended
  stickers of frames whose rotation disagreed; the voter now aligns whole
  frames to the face consensus and drops outliers (assembly.test.ts).
  `-1789310783346` carries the first `lockAttempt`: R fed 120 frames (three
  clusters, one of them skin at chroma 28 grouped into red by a hairline hue
  gap) with 30 inliers, U 40 frames with 16 - the consensus is now seeded by
  support and frames with cells of no known colour are dropped at the source.
  `-1789311565144` has no yellow cluster after a minute on the yellow face:
  the alien-face gate keyed on "six clusters exist" and junk/split clusters
  got there first (gate now keys on six NAMED colours); also a chroma-23
  skin cluster grouped into red and a dark blue aliased to white (warm needs
  chroma 30, white 20 and never cool).
