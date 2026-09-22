"""MediaPipe Hands over a solve recording: does a hand landmarker track two
hands wrapped around a 60 mm cube (design doc section 8 assumed it would
not), and do its fingers land on the cells the evidence log cannot read?

    model/.venv/Scripts/python tools/solve/hands_survey.py <clip.webm>
        [--log replay.json] [--video out.mp4] [--model hand_landmarker.task]
        [--max-frames N] [--conf 0.5] [--reuse]

The model is Google's hand_landmarker.task (float16 bundle), expected at
model/runs/mp/ (gitignored): https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task
Findings: docs/solve-tracking-design.md section 8.1.

Writes hands-<stem>.json next to the clip (every landmark of every frame,
so the numbers can be re-cut without re-running the model) and prints:
  - hands per frame, run lengths, identity swaps, landmark jitter, ms/frame
  - with --log: per quad, which of the 9 cells a finger covers, against
    the reading weight the pipeline gave that cell (covered cells should be
    the low-weight ones; a covered cell with a confident weight is the
    "finger reads as a sticker" failure the design doc describes)
  - finger-motion bursts: fingertip speed relative to the cube, a proxy for
    turn count until a recording has typed moves
"""
import argparse
import json
import os
import sys
import time
from collections import Counter

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, '..', '..'))
DEFAULT_MODEL = os.path.join(ROOT, 'model', 'runs', 'mp', 'hand_landmarker.task')

# landmark indices: wrist 0; thumb 1-4, index 5-8, middle 9-12, ring 13-16, pinky 17-20 (tip last)
FINGERS = [[0, 1, 2, 3, 4], [0, 5, 6, 7, 8], [0, 9, 10, 11, 12], [0, 13, 14, 15, 16], [0, 17, 18, 19, 20]]
PALM = [0, 1, 5, 9, 13, 17]
TIPS = [4, 8, 12, 16, 20]
SEGMENTS = [(f[i], f[i + 1]) for f in FINGERS for i in range(1, 4)]  # finger segments, not the palm spokes


def homography(src, dst):
    """3x3 H with H*src_i ~ dst_i for 4 point pairs (DLT, one linear solve)."""
    A = []
    for (x, y), (u, v) in zip(src, dst):
        A.append([x, y, 1, 0, 0, 0, -u * x, -u * y, -u])
        A.append([0, 0, 0, x, y, 1, -v * x, -v * y, -v])
    _, _, vt = np.linalg.svd(np.array(A, float))
    return vt[-1].reshape(3, 3)


def cell_centres(corners):
    """The 9 cell centres of a face quad, corner order as logged (going around)."""
    H = homography([(0, 0), (1, 0), (1, 1), (0, 1)], corners)
    out = []
    for r in range(3):
        for c in range(3):
            p = H @ np.array([(c + 0.5) / 3, (r + 0.5) / 3, 1.0])
            out.append((p[0] / p[2], p[1] / p[2]))
    return out


def seg_dist(p, a, b):
    ab = b - a
    t = float(np.dot(p - a, ab) / (np.dot(ab, ab) + 1e-9))
    t = min(1.0, max(0.0, t))
    return float(np.linalg.norm(p - (a + t * ab)))


def point_in_poly(p, poly):
    x, y = p; inside = False
    for i in range(len(poly)):
        (x1, y1), (x2, y2) = poly[i], poly[(i + 1) % len(poly)]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1 + 1e-12) + x1:
            inside = not inside
    return inside


def covered_by(hand_px, p, radius):
    """Is pixel p under this hand: inside the palm polygon or within `radius` of a finger segment."""
    if point_in_poly(p, [tuple(hand_px[i]) for i in PALM]): return True
    q = np.array(p)
    return any(seg_dist(q, hand_px[a], hand_px[b]) < radius for a, b in SEGMENTS)


def palm_width(hand_px):
    return float(np.linalg.norm(hand_px[5] - hand_px[17]))


def run_landmarker(clip, model, max_frames=None, conf=0.5):
    import mediapipe as mp
    from mediapipe.tasks.python import BaseOptions, vision
    opts = vision.HandLandmarkerOptions(
        base_options=BaseOptions(model_asset_path=model),
        running_mode=vision.RunningMode.VIDEO, num_hands=2,
        # DECISION: defaults (0.5); --conf lowers all three to see whether the misses are borderline
        min_hand_detection_confidence=conf, min_hand_presence_confidence=conf, min_tracking_confidence=conf)
    lm = vision.HandLandmarker.create_from_options(opts)
    cap = cv2.VideoCapture(clip)
    if not cap.isOpened(): sys.exit(f'cannot open {clip}')
    frames = []; last_t = -1
    while True:
        ok, bgr = cap.read()
        if not ok: break
        t = cap.get(cv2.CAP_PROP_POS_MSEC)
        if t <= last_t: t = last_t + 1  # MediaRecorder webms sometimes repeat a stamp; the landmarker wants them strictly increasing
        last_t = t
        h, w = bgr.shape[:2]
        img = mp.Image(image_format=mp.ImageFormat.SRGB, data=cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB))
        t0 = time.perf_counter()
        res = lm.detect_for_video(img, int(t))
        ms = (time.perf_counter() - t0) * 1000
        hands = []
        for hl, hd in zip(res.hand_landmarks, res.handedness):
            hands.append({'hand': hd[0].category_name, 'score': round(hd[0].score, 3),
                          'lm': [[round(p.x * w, 1), round(p.y * h, 1), round(p.z * w, 1)] for p in hl]})
        frames.append({'i': len(frames), 't': round(t, 1), 'ms': round(ms, 2), 'hands': hands})
        if max_frames and len(frames) >= max_frames: break
    cap.release(); lm.close()
    return {'clip': os.path.basename(clip), 'model': os.path.basename(model), 'conf': conf, 'w': w, 'h': h, 'frames': frames}


def summarize(hd):
    F = hd['frames']; n = len(F)
    if n < 2: print('  too few frames'); return
    dur = (F[-1]['t'] - F[0]['t']) / 1000
    fps = (n - 1) / dur if dur > 0 else 0
    ms = sorted(f['ms'] for f in F)
    counts = Counter(len(f['hands']) for f in F)
    print(f"  {n} frames, {dur:.1f} s ({fps:.1f} fps), {hd['w']}x{hd['h']}; landmarker ms/frame median {ms[n//2]:.1f} p90 {ms[int(n*.9)]:.1f} (CPU)")
    print(f"  hands/frame: 0: {counts[0]/n:5.1%}  1: {counts[1]/n:5.1%}  2: {counts[2]/n:5.1%}")
    # runs of frames with 2 hands, and with >= 1
    for k, name in ((2, 'both hands'), (1, 'any hand')):
        runs = []; cur = 0
        for f in F:
            if len(f['hands']) >= k: cur += 1
            elif cur: runs.append(cur); cur = 0
        if cur: runs.append(cur)
        runs.sort()
        if runs:
            print(f"  {name}: {len(runs)} runs, median {runs[len(runs)//2]} frames, longest {runs[-1]} ({runs[-1]/fps:.1f} s), "
                  f"gaps/s {(len(runs) - 1)/dur:.2f}")
        else:
            print(f"  {name}: never")
    # identity: match each hand to the nearest wrist in the previous frame; label swaps and jitter
    swaps = 0; pairs = 0; jit = []; palms = []; scores = []
    prev = None
    for f in F:
        cur = [(h['hand'], np.array(h['lm'], float)) for h in f['hands']]
        for _lab, px in cur:
            palms.append(palm_width(px))
        scores += [h['score'] for h in f['hands']]
        if prev:
            for lab, px in cur:
                best = min(prev, key=lambda p: np.linalg.norm(p[1][0] - px[0]))
                if np.linalg.norm(best[1][0] - px[0]) < 60:
                    pairs += 1
                    if best[0] != lab: swaps += 1
                    jit.append(float(np.median(np.linalg.norm(best[1][TIPS, :2] - px[TIPS, :2], axis=1))))
        prev = cur
    palms.sort(); jit.sort()
    if palms:
        print(f"  palm width px median {palms[len(palms)//2]:.0f} (p10 {palms[len(palms)//10]:.0f}); handedness score median {sorted(scores)[len(scores)//2]:.2f}")
    if pairs:
        print(f"  frame-to-frame: {pairs} matched hands, label flips {swaps/pairs:.1%}; fingertip motion px/frame median {jit[len(jit)//2]:.1f} p90 {jit[int(len(jit)*.9)]:.1f}")
    return fps


def against_log(hd, log_path, fps):
    d = json.load(open(log_path, encoding='utf-8'))
    log = d['evidenceLog']; rec = d.get('recording')
    t0 = rec['startedAt'] if rec else min(q['t'] for q in log['quads']) - 100
    quads = sorted(log['quads'], key=lambda q: q['t'])
    F = hd['frames']
    ft = np.array([f['t'] for f in F])
    half = 500 / max(fps, 1)
    cov_w = []; unc_w = []; per_quad = []; confident_covered = 0; quads_seen = 0; quads_no_hand = 0
    # the same visual radius the finger has in the picture: a finger is about a quarter of a palm wide
    # DECISION: radius 0.14 * palm width, measured across the knuckles (landmarks 5..17)
    for q in quads:
        vt = q['t'] - t0
        i = int(np.searchsorted(ft, vt))
        cands = [j for j in (i - 1, i) if 0 <= j < len(F) and abs(F[j]['t'] - vt) <= half]
        if not cands: continue
        f = F[min(cands, key=lambda j: abs(F[j]['t'] - vt))]
        quads_seen += 1
        hands = [np.array(h['lm'], float)[:, :2] for h in f['hands']]
        if not hands: quads_no_hand += 1
        centres = cell_centres(q['corners'])
        w = {r['cell']: r['w'] for r in q['readings']}
        covered = []
        for c, p in enumerate(centres):
            hit = any(covered_by(hp, p, 0.14 * palm_width(hp)) for hp in hands)
            covered.append(hit)
            (cov_w if hit else unc_w).append(w.get(c, 0))
            if hit and w.get(c, 0) > 0.3: confident_covered += 1
        per_quad.append(sum(covered))
        q['_covered'] = covered  # for the overlay
    if not quads_seen: print('  --log: no quads aligned with the video (wrong clip for this log?)'); return {}
    hist = Counter(per_quad)
    print(f"\n  against {os.path.basename(log_path)}: {quads_seen} quads aligned ({quads_no_hand} with no hand in frame)")
    print(f"  cells under a finger per quad: mean {np.mean(per_quad):.1f}, " + ' '.join(f"{k}:{hist[k]}" for k in sorted(hist)))
    cov = np.array(cov_w); unc = np.array(unc_w)
    if len(cov) and len(unc):
        print(f"  reading weight: covered cells mean {cov.mean():.2f} (>{0.05}: {(cov > .05).mean():.0%}, >0.3: {(cov > .3).mean():.0%})"
              f"  vs uncovered mean {unc.mean():.2f} (>0.05: {(unc > .05).mean():.0%}, >0.3: {(unc > .3).mean():.0%})")
        print(f"  covered cells the pipeline still trusted (w > 0.3): {confident_covered} of {len(cov)} covered ({confident_covered/len(cov):.0%})")
    return {(q['frame'], q['track']): q for q in quads if '_covered' in q}, quads, t0


def motion_bursts(hd, fps, quads=None, t0=None):
    """Fingertip speed relative to the cube centre (the mean quad centre when the log is given,
    else the mean of both wrists): bursts above a threshold as a turn-count proxy."""
    F = hd['frames']
    qt = qc = None
    if quads:
        qt = np.array([q['t'] - t0 for q in quads]); qc = np.array([np.mean(q['corners'], axis=0) for q in quads])
    speeds = []; prev = None
    for f in F:
        hands = [np.array(h['lm'], float)[:, :2] for h in f['hands']]
        if qt is not None and len(qt):
            i = min(int(np.searchsorted(qt, f['t'])), len(qt) - 1)
            centre = qc[i] if abs(qt[i] - f['t']) < 300 else None
        else:
            centre = np.mean([h[0] for h in hands], axis=0) if hands else None
        cur = {}
        if centre is not None:
            for h in hands:
                key = 'L' if h[0][0] < centre[0] else 'R'  # side of the cube, not the model's label
                cur[key] = h[TIPS] - centre
        s = 0.0
        if prev:
            for k in cur:
                if k in prev: s = max(s, float(np.median(np.linalg.norm(cur[k] - prev[k], axis=1))))
        speeds.append(s); prev = cur
    sp = np.array(speeds)
    if not sp.any(): print('  motion: no hand pairs to measure'); return
    thr = max(6.0, float(np.percentile(sp[sp > 0], 75)))  # DECISION: bursts = above the 75th percentile of moving frames, at least 6 px/frame
    bursts = 0; on = False; lens = []; cur = 0
    for s in sp:
        if s > thr:
            if not on: bursts += 1; on = True
            cur += 1
        elif on:
            on = False; lens.append(cur); cur = 0
    print(f"  fingertip speed vs cube (px/frame): median {np.median(sp):.1f} p90 {np.percentile(sp, 90):.1f}; "
          f"bursts > {thr:.0f}: {bursts} ({bursts / ((F[-1]['t'] - F[0]['t']) / 1000):.2f}/s), median burst {np.median(lens) if lens else 0:.0f} frames")
    hd['speed'] = [round(float(s), 1) for s in sp]


def render(hd, clip, out, aligned, quads, t0, fps):
    cap = cv2.VideoCapture(clip)
    vw = cv2.VideoWriter(out, cv2.VideoWriter_fourcc(*'mp4v'), max(fps, 1), (hd['w'], hd['h']))
    F = hd['frames']; qt = np.array([q['t'] - t0 for q in quads]) if quads else np.array([])
    half = 500 / max(fps, 1)
    for f in F:
        ok, bgr = cap.read()
        if not ok: break
        for h in f['hands']:
            px = np.array(h['lm'], float)[:, :2]
            col = (80, 220, 80) if h['hand'] == 'Right' else (80, 160, 255)
            for fi in FINGERS:
                for a, b in zip(fi, fi[1:]):
                    cv2.line(bgr, tuple(px[a].astype(int)), tuple(px[b].astype(int)), col, 2)
            for i in TIPS: cv2.circle(bgr, tuple(px[i].astype(int)), 4, col, -1)
            cv2.putText(bgr, f"{h['hand'][0]} {h['score']:.2f}", tuple(px[0].astype(int) + (4, 14)), cv2.FONT_HERSHEY_SIMPLEX, 0.45, col, 1)
        if len(qt):
            lo, hi = np.searchsorted(qt, f['t'] - half), np.searchsorted(qt, f['t'] + half)
            for q in quads[lo:hi]:
                pts = np.array(q['corners'], np.int32)
                cv2.polylines(bgr, [pts], True, (0, 255, 255), 1)
                cov = q.get('_covered')
                w = {r['cell']: r['w'] for r in q['readings']}
                for c, p in enumerate(cell_centres(q['corners'])):
                    p = (int(p[0]), int(p[1]))
                    if cov and cov[c]:
                        cv2.circle(bgr, p, 5, (0, 0, 255) if w.get(c, 0) > 0.3 else (0, 140, 255), 2)
                    else:
                        cv2.circle(bgr, p, 2, (255, 255, 255), -1)
        cv2.putText(bgr, f"{f['t']/1000:6.2f}s  hands {len(f['hands'])}  {f['ms']:.0f} ms", (4, 16), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 255), 1)
        vw.write(bgr)
    vw.release(); cap.release()
    print(f"  overlay -> {out}  (red ring: covered cell the pipeline trusted w>0.3; orange: covered, low weight)")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('clip')
    ap.add_argument('--log')
    ap.add_argument('--video')
    ap.add_argument('--model', default=DEFAULT_MODEL)
    ap.add_argument('--max-frames', type=int)
    ap.add_argument('--conf', type=float, default=0.5, help='detection/presence/tracking confidence (default 0.5)')
    ap.add_argument('--reuse', action='store_true', help='read hands-<stem>.json instead of running the model')
    a = ap.parse_args()
    stem = os.path.splitext(os.path.basename(a.clip))[0]
    out_json = os.path.join(os.path.dirname(os.path.abspath(a.clip)), f'hands-{stem}.json')
    print(f"# {a.clip}")
    if a.reuse and os.path.exists(out_json):
        hd = json.load(open(out_json, encoding='utf-8'))
    else:
        hd = run_landmarker(a.clip, a.model, a.max_frames, a.conf)
    fps = summarize(hd)
    aligned, quads, t0 = {}, None, None
    if a.log:
        r = against_log(hd, a.log, fps)
        if r: aligned, quads, t0 = r
    motion_bursts(hd, fps, quads, t0)
    if a.conf != 0.5: out_json = out_json.replace('.json', f'-conf{a.conf}.json')
    json.dump(hd, open(out_json, 'w', encoding='utf-8'))
    print(f"  landmarks -> {out_json}")
    if a.video:
        render(hd, a.clip, a.video, aligned, quads or [], t0 or 0, fps)


if __name__ == '__main__':
    main()
