"""Measure a smart cube's report latency against the webcam video of a
recording session (docs/smart-cube-design.md 4 "Latency calibration").
usage: model/.venv/bin/python tools/solve/cube_latency.py recordings/<session> [--out DIR] [--min-gap MS] [--max-turns N]

For every isolated slow turn (outside the timed solves, at least --min-gap
ms from its neighbours) the video's motion energy in a box around the cube
is a burst; the burst's end is the frame in which the layer visibly comes
to rest at 90 degrees. Latency = cube event time - that frame's host time,
against the event's BLE arrival and against the fitted cube clock. Writes
latency.json, summary.md, overview.png and strips/turn-NNN.png (the frames
around each turn, the settle frame outlined) to --out, default
<session>/latency/. Decoded frames are cached under $TMPDIR."""
import argparse
import hashlib
import json
import math
import os
import subprocess
import sys

import numpy as np

FFMPEG = '/usr/bin/ffmpeg'; FFPROBE = '/usr/bin/ffprobe'
DW, DH = 320, 240      # decode size for the motion signal (cube is ~80 px at 640x480)
CHUNK_MS = 1000        # MediaRecorder.start(1000)

# ------------------------------------------------------------------ loading

def load_session(sess):
    meta = json.load(open(os.path.join(sess, 'meta.json'), encoding='utf-8'))
    lines = [json.loads(l) for l in open(os.path.join(sess, 'cube.jsonl'), encoding='utf-8') if l.strip()]
    header = lines[0].get('header'); events = lines[1:] if header else lines
    moves = [e for e in events if e['kind'] == 'move']
    solves = [json.loads(l) for l in open(os.path.join(sess, 'solves.jsonl'), encoding='utf-8') if l.strip()] \
        if os.path.exists(os.path.join(sess, 'solves.jsonl')) else []
    return meta, header, moves, solves

def fit_clock(moves):
    """Host arrival t against the cube's own counter tRaw. The least-squares
    line is biased late by BLE delivery jitter (arrivals are only ever late),
    so also report a lower-envelope offset: the same slope, intercept at the
    10th percentile of the residuals."""
    t = np.array([m['t'] for m in moves], float); raw = np.array([m['tRaw'] for m in moves], float)
    A = np.vstack([raw, np.ones_like(raw)]).T
    slope, off = np.linalg.lstsq(A, t, rcond=None)[0]
    r = t - (slope * raw + off)
    # DECISION: envelope = 10th-percentile residual (not the minimum: one early
    # outlier would otherwise set the whole session's offset).
    env = off + float(np.percentile(r, 10))
    return dict(slope=float(slope), offsetLsq=float(off), offsetEnvelope=float(env),
                residualP10=float(np.percentile(r, 10)), residualP50=float(np.percentile(r, 50)),
                residualP90=float(np.percentile(r, 90)), n=len(moves),
                skewPct=(float(slope) - 1) * 100)

def select_turns(moves, solves, min_gap, max_turns):
    t = [m['t'] for m in moves]; out = []
    for i, m in enumerate(moves):
        gp = t[i] - t[i - 1] if i else math.inf; gn = t[i + 1] - t[i] if i + 1 < len(t) else math.inf
        if gp < min_gap or gn < min_gap: continue
        if any(s['t0'] <= t[i] <= s['t1'] for s in solves): continue
        out.append(dict(index=i, move=m['move'], t=m['t'], tRaw=m['tRaw'], gapPrev=gp, gapNext=gn))
    return out[:max_turns]

# ------------------------------------------------------------------ video

def cache_path(video):
    st = os.stat(video)
    key = hashlib.md5(f'{os.path.abspath(video)}|{st.st_size}|{st.st_mtime}|{DW}x{DH}'.encode()).hexdigest()[:12]
    d = os.environ.get('TMPDIR') or '/tmp'
    return os.path.join(d, f'cube_latency-{key}.npz')

def decode_video(video):
    """All frames as grey DWxDH uint8 plus their pts in ms (variable frame rate:
    ffprobe's per-frame pts, ffmpeg with -vsync passthrough so nothing is
    dropped or duplicated). Cached in $TMPDIR."""
    cp = cache_path(video)
    if os.path.exists(cp):
        z = np.load(cp); return z['frames'], z['pts']
    print('decoding', video, '->', cp, file=sys.stderr)
    p = subprocess.run([FFPROBE, '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'frame=pts_time',
                        '-of', 'csv=p=0', video], capture_output=True, text=True, check=True)
    pts = np.array([float(l.split(',')[0]) * 1000 for l in p.stdout.split() if l.strip()])
    raw = subprocess.run([FFMPEG, '-v', 'error', '-vsync', 'passthrough', '-i', video,
                          '-vf', f'scale={DW}:{DH},format=gray', '-f', 'rawvideo', '-'],
                         capture_output=True, check=True).stdout
    frames = np.frombuffer(raw, np.uint8).reshape(-1, DH, DW)
    n = min(len(frames), len(pts))
    if len(frames) != len(pts):
        print(f'warning: ffmpeg gave {len(frames)} frames, ffprobe {len(pts)} pts; using {n}', file=sys.stderr)
    frames, pts = frames[:n], pts[:n]
    np.savez(cp, frames=frames, pts=pts)
    return frames, pts

def motion_map(frames, step=5):
    """Mean |frame diff| per pixel over the session (every step-th pair)."""
    acc = np.zeros((DH, DW), np.float64); n = 0
    for i in range(step, len(frames), step):
        acc += np.abs(frames[i].astype(np.int16) - frames[i - step].astype(np.int16)); n += 1
    return acc / max(n, 1)

def cube_box(mmap):
    """Box around the thing that moves: the energy-weighted centroid of the
    motion map (pixels above its 80th percentile) and a box of +-25% of the
    frame around it. The hands and cube sit in one place all session."""
    thr = np.percentile(mmap, 80); w = np.where(mmap > thr, mmap, 0)
    ys, xs = np.mgrid[0:DH, 0:DW]; s = w.sum()
    cy, cx = (w * ys).sum() / s, (w * xs).sum() / s
    hw, hh = DW // 4, DH // 4
    x0, y0 = int(max(0, cx - hw)), int(max(0, cy - hh))
    x1, y1 = int(min(DW, cx + hw)), int(min(DH, cy + hh))
    return x0, y0, x1, y1

def motion_energy(frames, box):
    x0, y0, x1, y1 = box
    a = frames[:, y0:y1, x0:x1].astype(np.int16)
    e = np.zeros(len(frames)); e[1:] = np.abs(a[1:] - a[:-1]).mean(axis=(1, 2))
    return e

# ------------------------------------------------------------------ bursts

WIN_BEFORE, WIN_AFTER = 1200, 400   # analysis window around the event, ms
# DECISION: where the layer's end may sit relative to the event. The cube
# reports a turn as the layer nears 90 degrees, so the settle is not much
# earlier than the FITTED send time (SETTLE_LO before it); BLE only adds
# delay, so it is not much later than the later of arrival and fit
# (SETTLE_HI after it). Wider ranges admit the end of the whole-cube
# rotation that precedes a turn, or of the regrip after it, as rivals (seen
# on 2026-09-19: every turn checked by eye settles within +-60 ms of its
# event, and every pick outside +-100 was a rotation or a regrip). A device
# whose true latency is outside this range makes every turn 'unclear' (and
# overview.png shows the offset) rather than reporting a wrong number;
# widen these then.
SETTLE_LO, SETTLE_HI = -120, 120
BOX_HW, BOX_HH = 50, 40             # per-turn box half size at DWxDH (cube is ~40 px here)

def turn_box(frames, lo, hi):
    """Box around what moved in frames[lo:hi] (the turning layer and the
    fingers on it): centroid of the top-10% pixels of the mean |diff| map,
    +-BOX_HW x BOX_HH. The hands' box over the whole session dilutes the
    signal with static pixels; this one is tight on the cube."""
    a = frames[lo:hi].astype(np.int16)
    m = np.abs(a[1:] - a[:-1]).mean(axis=0) if len(a) > 1 else np.zeros((DH, DW))
    thr = np.percentile(m, 90); w = np.where(m >= thr, m, 0); s = w.sum()
    if s <= 0: return 0, 0, DW, DH
    ys, xs = np.mgrid[0:DH, 0:DW]; cy, cx = (w * ys).sum() / s, (w * xs).sum() / s
    return (int(max(0, cx - BOX_HW)), int(max(0, cy - BOX_HH)),
            int(min(DW, cx + BOX_HW)), int(min(DH, cy + BOX_HH)))

DROP = 1.7          # a settle: energy falls to <= peak/DROP within PEAK_LOOK frames of the peak
PEAK_LOOK = 4       # frames (~130 ms at 30 fps): a slow turn's last quarter turn

def settle_candidates(e, rel, floor, lo_ms, hi_ms):
    """Frames where the motion has just come to rest: the first frame k at or
    below 1/DROP of the peak over the preceding PEAK_LOOK frames, that peak
    standing clearly above the floor. e[k] = |frame k - frame k-1|, so frame
    k-1 is the first frame that SHOWS the layer at rest (frame k is identical
    to it) and the layer stopped in the interval before k-1: the settle
    frame is k-1 and the true stop is at most one frame earlier. The layer
    coming to rest is such a drop (the blur of the last quarter turn, then
    a still frame); so, unfortunately, is a hand settling after a regrip or
    a whole-cube rotation, which is why the candidates are ranked by
    distance to the event and any second one in the physical range makes
    the turn ambiguous. Returns (index, peak_index, drop_ratio) tuples."""
    out = []; n = len(e)
    for k in range(1, n):
        if not (lo_ms <= rel[k] <= hi_ms): continue
        lo = max(0, k - PEAK_LOOK); pk = lo + int(np.argmax(e[lo:k]))
        if e[pk] < floor + 1.0: continue                 # a peak must stand out from the floor
        # DECISION: at rest means near the quiet floor (<= 1.5 x floor + 0.5):
        # a drop from a big cube rotation to a still-moving hand is not a settle.
        if e[k] > 1.5 * floor + 0.5: continue
        line = e[pk] / DROP
        if e[k] <= line and e[k - 1] > line: out.append((k, pk, float(e[pk] / max(e[k], 1e-6))))
    return out

def find_burst(e, rel, floor, lo_ms, hi_ms):
    """Returns (onset, settle, still, status, candidates): settle is the first
    frame that shows the layer at rest (the candidate nearest the event, less
    one), still the first frame identical to it; onset walks back from the
    burst's peak while the energy stays above (floor + peak) / 2 or keeps
    falling (the burst's rising edge)."""
    cands = settle_candidates(e, rel, floor, lo_ms, hi_ms)
    if not cands: return None, None, None, 'unclear: no settle near the event', []
    cands.sort(key=lambda c: abs(rel[c[0]]))
    k, pk, ratio = cands[0]
    others = cands[1:]   # any second settle in the physical range is a rival
    half = (e[pk] + floor) / 2
    on = pk
    while on > 0 and (e[on - 1] > half or (e[on - 1] < e[on] and e[on - 1] > floor)): on -= 1
    status = 'ok' if not others else f'ambiguous: {len(others)} other settle(s) as near the event'
    return on, k - 1, k, status, cands  # settle = k-1, still = k

def measure_turn(frames, host, turn, t_prev, t_next, t_fit):
    """Energy window, box, threshold and burst for one turn. Returns a dict."""
    T = turn['t']
    lo_t = max(T - WIN_BEFORE, t_prev + 50); hi_t = min(T + WIN_AFTER, t_next - 50)
    idx = np.where((host >= lo_t) & (host <= hi_t))[0]
    if len(idx) < 8: return dict(status='unclear: no video in window')
    lo, hi = max(1, int(idx[0])), int(idx[-1]) + 1
    # the box comes from the frames nearest the event, where the turn itself is
    b_idx = np.where((host >= T - 350) & (host <= T + 100))[0]
    box = turn_box(frames, int(b_idx[0]), int(b_idx[-1]) + 1) if len(b_idx) > 2 else (0, 0, DW, DH)
    e = motion_energy(frames[lo - 1:hi], box)[1:]   # diff against the frame before the window too
    rel = host[lo:hi] - T
    # DECISION: the quiet floor is the window's 20th percentile (the hands are
    # never wholly still, so the median is not a floor). A turning layer with
    # fingers on it is 3-6x the floor; a regrip 1.5-3x.
    floor = float(np.percentile(e, 20))
    lo_ms = (t_fit - T) + SETTLE_LO; hi_ms = max(0.0, t_fit - T) + SETTLE_HI
    on, settle, still, status, cands = find_burst(e, rel, floor, lo_ms, hi_ms)
    r = dict(status=status, box=[int(v) for v in box], floor=floor, settleRange=[round(lo_ms), round(hi_ms)],
             candidates=[dict(frame=lo + c[0], rel=round(float(rel[c[0]])), drop=round(c[2], 2)) for c in cands],
             frame0=lo, energy=[round(float(v), 2) for v in e], rel=[round(float(v)) for v in rel])
    if on is not None:
        r.update(onsetFrame=lo + on, settleFrame=lo + settle, stillFrame=lo + still)
    return r

# ------------------------------------------------------------------ outputs

def fmt_ts(ms):
    s = ms / 1000; return f'{int(s // 60)}:{s % 60:06.3f}'

def decode_full_frames(video, ranges):
    """Full-resolution RGB frames for a list of (first, last) frame-index
    ranges, in one ffmpeg pass. Returns {frame_index: HxWx3 uint8}."""
    if not ranges: return {}
    want = sorted({i for a, b in ranges for i in range(a, b + 1)})
    expr = '+'.join(f'between(n\\,{a}\\,{b})' for a, b in ranges)
    raw = subprocess.run([FFMPEG, '-v', 'error', '-vsync', 'passthrough', '-i', video,
                          '-vf', f"select='{expr}'", '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
                         capture_output=True, check=True).stdout
    frames = np.frombuffer(raw, np.uint8)
    W, H = 640, 480
    n = len(frames) // (W * H * 3)
    if n != len(want): print(f'warning: strip decode gave {n} frames, wanted {len(want)}', file=sys.stderr)
    frames = frames[:n * W * H * 3].reshape(n, H, W, 3)
    return {i: frames[k] for k, i in enumerate(want[:n])}

def write_strip(path, full, r, turn, host, pts, T_fit):
    """Contact strip: the frames from onset-3 to settle+3 (at most 16), each
    the per-turn box cropped from the full frame at 2x, the settle frame
    outlined red and the onset frame blue; plus the settle frame at half
    size with the box, for context."""
    from PIL import Image, ImageDraw, ImageFont
    on, settle = r['onsetFrame'], r['settleFrame']
    idx = list(range(max(0, on - 3), settle + 4))
    if len(idx) > 16:
        keep = set(np.linspace(0, len(idx) - 1, 16).round().astype(int)) | {idx.index(on), idx.index(settle)}
        idx = [f for k, f in enumerate(idx) if k in keep]
    x0, y0, x1, y1 = [v * 2 for v in r['box']]          # box at 640x480
    cw, ch = (x1 - x0) * 2, (y1 - y0) * 2               # tile at 2x
    try: font = ImageFont.truetype('DejaVuSans.ttf', 14)
    except OSError: font = ImageFont.load_default()
    cols = 4; rows = math.ceil(len(idx) / cols)
    ctx_h = 240 + 20
    sheet = Image.new('RGB', (cols * cw, ctx_h + rows * (ch + 20)), 'black')
    d = ImageDraw.Draw(sheet)
    # context: the settle frame, half size, box drawn
    if settle in full:
        ctx = Image.fromarray(full[settle]).resize((320, 240))
        ImageDraw.Draw(ctx).rectangle((x0 / 2, y0 / 2, x1 / 2, y1 / 2), outline='red', width=2)
        sheet.paste(ctx, (0, 0))
    d.text((330, 4), f"turn {turn['index']} {turn['move']}  event {fmt_ts(turn['t'])} host  "
           f"(video {fmt_ts(host_to_pts(turn['t'], host, pts))})", fill='white', font=font)
    d.text((330, 24), f"settle {fmt_ts(pts[settle])}  latency vs arrival {turn['t'] - host[settle]:+.0f} ms, "
           f"vs fit {T_fit - host[settle]:+.0f} ms", fill='white', font=font)
    d.text((330, 44), f"onset {fmt_ts(pts[on])}  duration {host[settle] - host[on]:.0f} ms  status {r['status']}",
           fill='white', font=font)
    d.text((330, 64), "red = settle frame (first frame showing the layer at rest; the next tile is identical to it), "
           "blue = onset; label: video m:ss.mmm, ms from the event (arrival), motion energy vs the previous frame",
           fill='#aaaaaa', font=font)
    for k, f in enumerate(idx):
        if f not in full: continue
        tile = Image.fromarray(full[f][y0:y1, x0:x1]).resize((cw, ch), Image.BILINEAR)
        td = ImageDraw.Draw(tile)
        if f == settle: td.rectangle((0, 0, cw - 1, ch - 1), outline='red', width=5)
        elif f == on: td.rectangle((0, 0, cw - 1, ch - 1), outline='#4080ff', width=4)
        X, Y = (k % cols) * cw, ctx_h + (k // cols) * (ch + 20)
        sheet.paste(tile, (X, Y + 20))
        k2 = f - r['frame0']
        e = f"e={r['energy'][k2]:.1f}" if 0 <= k2 < len(r['energy']) else ''
        d.text((X + 4, Y + 2), f"{fmt_ts(pts[f])}  {host[f] - turn['t']:+.0f} ms  {e}", fill='yellow', font=font)
    sheet.save(path)

def host_to_pts(t, host, pts):
    return t - (host[0] - pts[0])

def write_overview(path, host, energy, moves, solves, results, turns):
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    t0 = host[0]; x = (host - t0) / 1000
    fig, ax = plt.subplots(figsize=(max(16, x[-1] / 6), 4.5))
    for s in solves: ax.axvspan((s['t0'] - t0) / 1000, (s['t1'] - t0) / 1000, color='#ffd54f', alpha=0.3, lw=0)
    ax.plot(x, energy, lw=0.6, color='#333333', label='motion energy (session cube box)')
    ymax = float(np.percentile(energy, 99.5)) * 1.3
    for m in moves: ax.vlines((m['t'] - t0) / 1000, 0, ymax * 0.12, color='#1976d2', lw=0.8)
    for tr, r in zip(turns, results):
        c = '#2e7d32' if r['status'] == 'ok' else ('#ef6c00' if r['status'].startswith('ambiguous') else '#c62828')
        ax.vlines((tr['t'] - t0) / 1000, ymax * 0.12, ymax * 0.3, color=c, lw=1.2)
        if 'settleFrame' in r: ax.plot((host[r['settleFrame']] - t0) / 1000, ymax * 0.3, 'v', color=c, ms=5)
    ax.set_ylim(0, ymax); ax.set_xlim(x[0], x[-1])
    ax.set_xlabel('session time (s, host clock; video pts + anchor)'); ax.set_ylabel('mean |frame diff| (grey)')
    ax.set_title('cube events (blue ticks) against video motion; solves shaded; measured turns: green ok, orange ambiguous, red unclear, triangle = settle frame')
    fig.tight_layout(); fig.savefig(path, dpi=90); plt.close(fig)

def write_summary(path, out, sess):
    L = [f"# Cube report latency: {os.path.basename(os.path.normpath(sess))}", '',
         '| # | move | event (host) | video onset | video settle | lat vs arrival | lat vs fit | duration | status |',
         '|---|------|--------------|-------------|--------------|----------------|------------|----------|--------|']
    for r in out['turns']:
        if 'settlePts' in r:
            L.append(f"| {r['index']} | {r['move']} | {r['t']:.0f} | {fmt_ts(r['onsetPts'])} | {fmt_ts(r['settlePts'])} | "
                     f"{r['latencyArrival']:+.0f} | {r['latencyFit']:+.0f} | {r['durationMs']:.0f} | {r['status']} |")
        else:
            L.append(f"| {r['index']} | {r['move']} | {r['t']:.0f} | - | - | - | - | - | {r['status']} |")
    s = out['summary']; a = out['anchor']; c = out['clock']
    L += ['', '## Summary', '',
          f"- turns selected {s['nSelected']} (min gap {out['args']['minGap']} ms, outside solves), used {s['nUsed']}, "
          f"ambiguous {s['nAmbiguous']}, unclear {s['nUnclear']}",
          f"- latency vs arrival: median {s['arrival']['median']:+.0f} ms, MAD {s['arrival']['mad']:.0f}, "
          f"p10/p90 {s['arrival']['p10']:+.0f}/{s['arrival']['p90']:+.0f}",
          f"- latency vs fitted send time: median {s['fit']['median']:+.0f} ms, MAD {s['fit']['mad']:.0f}, "
          f"p10/p90 {s['fit']['p10']:+.0f}/{s['fit']['p90']:+.0f}",
          f"- turn duration (onset to settle): median {s['durationMedian']:.0f} ms",
          f"- skew (latency vs fit against session time): {s['skewMsPerMin']:+.2f} ms/min over {s['skewSpanMin']:.1f} min",
          f"- video anchor: {a['used']} = {a['value']:.1f} ms host; meta.t0 = {a['t0']:.1f}, chunkT[0]-{CHUNK_MS} = {a['chunk']:.1f} "
          f"(difference {a['chunk'] - a['t0']:+.1f} ms)",
          f"- cube clock: host = {c['slope']:.6f} * tRaw + {c['offsetLsq']:.1f} (least squares, {c['n']} moves; "
          f"host runs {c['skewPct']:+.3f}% against the cube); lower-envelope offset {c['offsetEnvelope']:.1f} "
          f"({c['residualP10']:+.0f} ms from the fit); arrival residuals p50 {c['residualP50']:+.0f}, p90 {c['residualP90']:+.0f} ms",
          '', '## Reading it', '',
          "Latency is the cube's event time minus the host time of the first video frame that shows the layer at rest, so a "
          "positive number means the report came after the layer visibly finished and a negative one that it came before. "
          "The layer actually stopped somewhere in the ~33 ms before that frame, so each number is a lower bound within one frame. "
          "'vs arrival' uses the BLE arrival stamp; 'vs fit' uses the least-squares cube clock evaluated at the move's own "
          "counter, which removes BLE delivery jitter (a late packet shows as a positive residual above, and the same turn's "
          "'vs arrival' number is larger by that residual). The fitted number is the one to store as `latencyMs`; its MAD is "
          "the spread to expect when cube events label video frames. Frames are ~33 ms apart, so +-1 frame is the floor of "
          "what a single turn can say. A skew slope far from zero means the video's timestamps drift against the host clock "
          "and the anchor is only right at t=0 (with the measured turns in two short blocks, as when a scramble is applied "
          "before each solve, the slope is poorly determined; read it against the span).",
          '',
          "To check by eye: open strips/turn-NNN.png. The red-outlined tile must show the layer at rest in its new position, "
          "the tile before it blurred or mid-turn, and the tile after it identical; the blue tile is the onset. If the red tile is the end of a "
          "whole-cube rotation or of a regrip rather than of the layer turn, that row is wrong. Ambiguous rows had a second "
          "settle in the physical range (their pick is still shown); unclear rows had none. overview.png shows the event "
          "ticks against the motion trace for the whole session: if the ticks sit systematically off the bursts, the anchor "
          "is wrong."]
    open(path, 'w', encoding='utf-8').write('\n'.join(L) + '\n')

# ------------------------------------------------------------------ main

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('session')
    ap.add_argument('--out', default=None, help='output dir (default <session>/latency)')
    # DECISION: 400 ms, not the 700 of the design note: on 2026-09-19 the
    # scramble was applied at 400-600 ms per turn (700 leaves 3 turns) and the
    # settle search is bounded to the event's own neighbourhood anyway.
    ap.add_argument('--min-gap', type=int, default=400, help='ms to the previous and next move (default 400)')
    ap.add_argument('--max-turns', type=int, default=40)
    ap.add_argument('--anchor', choices=['t0', 'chunk'], default='t0',
                    help='video time 0 = meta.t0 (default) or chunkT[0] - chunk length')
    ap.add_argument('--no-strips', action='store_true')
    args = ap.parse_args()
    sess = args.session; out_dir = args.out or os.path.join(sess, 'latency')
    os.makedirs(os.path.join(out_dir, 'strips'), exist_ok=True)
    os.environ.setdefault('MPLCONFIGDIR', os.path.join(os.environ.get('TMPDIR', '/tmp'), 'mpl'))

    meta, header, moves, solves = load_session(sess)
    clock = fit_clock(moves)
    turns = select_turns(moves, solves, args.min_gap, args.max_turns)
    video = os.path.join(sess, 'video.webm')
    frames, pts = decode_video(video)
    # DECISION: anchor = meta.t0. MediaRecorder.start() ran right after the
    # meta was written, so the first frame's pts 0 is t0 plus a few tens of ms;
    # chunkT[0] - 1000 is the other estimate (the first timeslice's arrival).
    anchors = dict(t0=float(meta['t0']), chunk=float(meta['chunkT'][0]) - CHUNK_MS)
    anchor = anchors[args.anchor]
    host = anchor + pts
    print(f'{len(frames)} frames, {pts[-1] / 1000:.1f} s of video; anchor {args.anchor} = {anchor:.1f} '
          f'(t0 {anchors["t0"]:.1f}, chunk {anchors["chunk"]:.1f}, diff {anchors["chunk"] - anchors["t0"]:+.1f} ms)', file=sys.stderr)
    print(f'clock: slope {clock["slope"]:.6f} offset lsq {clock["offsetLsq"]:.1f} envelope {clock["offsetEnvelope"]:.1f}; '
          f'{len(turns)} turns selected', file=sys.stderr)

    t_all = [m['t'] for m in moves]
    results = []
    for tr in turns:
        i = tr['index']
        tr['tFit'] = clock['slope'] * tr['tRaw'] + clock['offsetLsq']
        r = measure_turn(frames, host, tr, t_all[i - 1] if i else -math.inf,
                         t_all[i + 1] if i + 1 < len(t_all) else math.inf, tr['tFit'])
        results.append(r)

    # strips (one ffmpeg pass for every measured turn)
    if not args.no_strips:
        ranges = [(max(0, r['onsetFrame'] - 3), r['settleFrame'] + 3) for r in results if 'settleFrame' in r]
        full = decode_full_frames(video, ranges)
        for tr, r in zip(turns, results):
            if 'settleFrame' not in r: continue
            write_strip(os.path.join(out_dir, 'strips', f"turn-{tr['index']:03d}.png"), full, r, tr, host, pts, tr['tFit'])

    rows = []; used = []
    for tr, r in zip(turns, results):
        row = dict(index=tr['index'], move=tr['move'], t=tr['t'], tRaw=tr['tRaw'], tFit=tr['tFit'],
                   gapPrev=tr['gapPrev'], gapNext=tr['gapNext'], status=r['status'], box=r.get('box'),
                   floor=r.get('floor'), settleRange=r.get('settleRange'), candidates=r.get('candidates', []))
        if 'settleFrame' in r:
            on, st, still = r['onsetFrame'], r['settleFrame'], r['stillFrame']
            row.update(onsetFrame=on, settleFrame=st, stillFrame=still,
                       onsetPts=float(pts[on]), settlePts=float(pts[st]), stillPts=float(pts[still]),
                       onsetHost=float(host[on]), settleHost=float(host[st]),
                       latencyArrival=float(tr['t'] - host[st]), latencyFit=float(tr['tFit'] - host[st]),
                       durationMs=float(host[st] - host[on]))
            if r['status'] == 'ok': used.append(row)
        rows.append(row)

    def stats(xs):
        if not xs: return dict(median=float('nan'), mad=float('nan'), p10=float('nan'), p90=float('nan'))
        a = np.array(xs); med = float(np.median(a))
        return dict(median=med, mad=float(np.median(np.abs(a - med))), p10=float(np.percentile(a, 10)),
                    p90=float(np.percentile(a, 90)), n=len(a))
    la = [r['latencyArrival'] for r in used]; lf = [r['latencyFit'] for r in used]
    if len(used) >= 3:
        x = np.array([r['t'] for r in used]) / 60000; y = np.array(lf)
        skew = float(np.polyfit(x, y, 1)[0]); span = float(x.max() - x.min())
    else: skew, span = float('nan'), 0.0
    summary = dict(nSelected=len(turns), nUsed=len(used),
                   nAmbiguous=sum(1 for r in rows if r['status'].startswith('ambiguous')),
                   nUnclear=sum(1 for r in rows if r['status'].startswith('unclear')),
                   arrival=stats(la), fit=stats(lf),
                   durationMedian=float(np.median([r['durationMs'] for r in used])) if used else float('nan'),
                   skewMsPerMin=skew, skewSpanMin=span)
    out = dict(session=os.path.basename(os.path.normpath(sess)), args=dict(minGap=args.min_gap, maxTurns=args.max_turns),
               anchor=dict(used=args.anchor, value=anchor, t0=anchors['t0'], chunk=anchors['chunk']),
               video=dict(frames=len(frames), durationMs=float(pts[-1]), medianFrameMs=float(np.median(np.diff(pts)))),
               clock=clock, params=dict(DROP=DROP, PEAK_LOOK=PEAK_LOOK, SETTLE_LO=SETTLE_LO, SETTLE_HI=SETTLE_HI,
                                        WIN_BEFORE=WIN_BEFORE, WIN_AFTER=WIN_AFTER, decode=[DW, DH]),
               summary=summary, turns=rows)
    json.dump(out, open(os.path.join(out_dir, 'latency.json'), 'w', encoding='utf-8'), indent=1)
    write_summary(os.path.join(out_dir, 'summary.md'), out, sess)
    box = cube_box(motion_map(frames))
    write_overview(os.path.join(out_dir, 'overview.png'), host, motion_energy(frames, box), moves, solves, results, turns)
    s = summary
    print(f"used {s['nUsed']}/{s['nSelected']} (ambiguous {s['nAmbiguous']}, unclear {s['nUnclear']}): "
          f"latency vs arrival median {s['arrival']['median']:+.0f} ms (MAD {s['arrival']['mad']:.0f}), "
          f"vs fit median {s['fit']['median']:+.0f} ms (MAD {s['fit']['mad']:.0f}, p10/p90 {s['fit']['p10']:+.0f}/{s['fit']['p90']:+.0f}); "
          f"skew {s['skewMsPerMin']:+.2f} ms/min; outputs in {out_dir}")

if __name__ == '__main__':
    main()
