> Archived 2026-09-22: measured and shelved (docs/solve-tracking-design.md points here for the moves-from-clips question).

# Hand pose for move reading: measured and shelved (2026-09-15)

The question: could a hand landmarker (MediaPipe Hands) read the turns of a
solve from video, or at least help the camera move reader? Section 8 of
`docs/solve-tracking-design.md` had ranked hand pose "last, if ever" on an
assumption. This is the measurement, and the answer to "could we extract
moves from the clips with this?" - no. Details of the numbers live in the
design doc's section 8.1; this page is the summary and the reasoning.

## What was run

`tools/solve/hands_survey.py`: MediaPipe HandLandmarker 1.0.1 (the float16
`hand_landmarker.task`, gitignored under `model/runs/mp/`; `mediapipe` in
the model venv), two hands, VIDEO mode, CPU, over all eight webcam solve
recordings in `web/clips/solves/`. The landmarks are aligned with each
replay log by `recording.startedAt`, so every tracked face quad has, per
cell, whether a finger of a detected hand lies over it. `--video` writes
an overlay (`hands-<clip>.mp4`), `--conf` lowers the confidences, `--reuse`
re-cuts the numbers from the saved landmarks.

## What it found

**It tracks the wrong hand.** The hand whose palm faces the camera (the
left hand, image right, in every clip) is found continuously, in single
runs of 30-65 s, with a plausible skeleton wrapped round the cube. The
hand whose palm is behind the cube - thumb on the front face, fingertips
over the top - is the one the palm detector misses, and that is the hand
doing the turning:

| setup | frames with both hands | frames with none |
|---|---|---|
| chest height, face-on (3 clips) | 70-89 % | 0-10 % |
| hands low, cube ~100 px (2 clips) | 9-17 % | 0-9 % |
| above and close, cube ~150 px (the settled setup) | 50 % | 25 % |

Lowering every confidence to 0.2 lifts the second hand to 55-67 % on the
close clips, but part of that is phantoms (a 0.53 "hand" at the frame
edge) and where the hand is real its thumb - the one finger on the layer
being turned - is rarely on the sticker it is actually on. Close in, with
fingers filling a third of the frame and the palm hidden, the detector
returns nothing.

**Landmarks are not a turn signal.** Fingertip speed relative to the cube
centre gives 1-4 bursts per second, mostly one frame long, against about
one move per second: the landmark jitter at rest (4-8 px/frame median) is
the size of a turn. And even a perfect skeleton is not a move: "index tip
moved 30 px across the top face" -> `U'` is a per-solver mapping (finger
tricks differ) that has to be learned from labelled moves.

**The occlusion evidence is real but partial.** Cells under a tracked
finger get lower reading weights than uncovered cells in every clip (mean
0.13-0.23 vs 0.20-0.42), yet 13-53 % of covered cells still carry a
confident weight (w > 0.3): the "finger reads as a sticker" failure the
design doc describes, made visible. But the mask only exists for the hand
the landmarker finds, and the colour-statistics veto (design doc section 8
item 1) gets the same thing for both hands at no cost.

**Cost:** 13-14 ms/frame on the desktop CPU in Python. On the phone, on top
of the cube detector, that is the whole frame budget.

## So: moves from the clips?

Not with this, and not as the primary reader ever. What a landmarker could
contribute, later and cheaply, is *timing*: the palm-facing hand's grip
changes mark "something happened here", an event prior for the reader's
epoch boundaries. Never which layer, never which direction.

What reads moves from video is the colour-evidence reader
(`web/src/moves/`): which stickers changed, and which single turn explains
it. At the time of this experiment it had no ground truth to be scored
against - no recording had typed moves (`movesApplied` null in every
capture) - and that, not hand pose, was the blocker.

## Where this sits now (2026-09-17)

The truth problem is solved a different way: the smart cube
(`docs/smart-cube-design.md`) is a labelling instrument, and the recording
rig (`web/src/rig/`, `recordings/<date>/<session>/`) stores full-rate
video beside the cube's move events with millisecond times. That gives the
camera reader its first honest score and M13 its labels. The M13 plan is a
*twist head* on the cube detector (which layer is mid-turn, which way, how
far - per frame, from the crop stage 2 already sees) feeding the beam
reader as one more evidence channel. That reads the turn itself, the
signal the hands hide and a hand landmarker never saw.

Re-measure hand pose only if the camera setup changes to one that shows
both palms, or the cube-labelled recordings show the twist head plus
colour evidence still cannot separate a turn from its inverse.
