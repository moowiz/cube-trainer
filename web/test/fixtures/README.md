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
