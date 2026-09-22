"""Audit a twist head against the smart cube's move log on a recording
(docs/smart-cube-design.md 5.3: "if fewer than half the real turns show a
readable twist on at least one frame, go to B").

usage: model/.venv/bin/python tools/solve/twist_audit.py recordings/<session> --ckpt model/train/runs/<run>/best.pt
         [--box model/train/runs/box17/best.pt] [--solve N] [--lead 3] [--tail 1] [--stride 1] [--max-frames N]
         [--window 350] [--tail-ms 30] [--guard 600] [--thresh 0.5] [--anchor t0|chunk] [--out DIR] [--strips N]

Every video frame in the chosen windows (each timed solve plus --lead/--tail
seconds; the whole move span when the session has no solves) goes through
the two-stage detector, and each quad's twist read (twostage.py: p(twisted),
class, angle mod 90) is scored against the cube. A turn the cube reported at
fitted send time T ended at T - 5 ms (the measured report latency, vs the
least-squares cube clock), so the frames in [T - 5 - window, T - 5 + tail-ms]
are that turn's; frames further than --guard ms from every turn's end are
rest; the frames between are margin and not scored. No hand labels involved.

Reports, per threshold: turns seen (max p(twisted) over the turn's frames),
by layer; false alarms on rest frames; the class mix; and for the seen turns
whether the angle sweeps monotonically across the frames - the sweep is
where the reader gets a turn's direction and timing. Detector coverage
(turns with any quad at all) is reported on its own, so "no quad" is never
confused with "a quad but no twist". A checkpoint without the twist head
gives the coverage numbers only.

Writes <out>/audit.json (config, clock, per-frame and per-turn records,
metrics) and <out>/summary.md; default out = <session>/twist-audit/<run>/.
With --strips N, also <out>/strips/turn-NNN-<move>.png for the first N turns:
the turn's frames (stage 1's window, quads drawn green -> magenta by
p(twisted), class and angle where it clears --thresh, dt to the layer's stop
under each) - the picture to check any verdict against.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
import time
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(ROOT / "model" / "train"))
from cube_latency import CHUNK_MS, FFMPEG, FFPROBE, fit_clock, load_session

# design doc 8: the cube's report comes a median 5 ms after the layer visibly
# comes to rest, measured against the least-squares cube clock
LATENCY_MS = 5.0
CLASSES = ["none", "self", "edge0", "edge1", "edge2", "edge3"]
THRESHOLDS = (0.3, 0.5, 0.7, 0.9)
SWEEP_TOL_DEG = 3.0     # a step against the sweep's direction smaller than this still counts as monotone
SWEEP_MIN_DEG = 10.0    # a "sweep" has to cover at least this much; less is a flat reading
SHORT = {"none": "-", "self": "S", "edge0": "e0", "edge1": "e1", "edge2": "e2", "edge3": "e3"}
STRIP_COLS = 12


# ------------------------------------------------------------------ video

def probe(video: str):
    """(pts in ms per frame, width, height) via ffprobe; cached under $TMPDIR
    (a webm is variable frame rate: the per-frame pts are the only timing)."""
    st = os.stat(video)
    key = hashlib.md5(f"{os.path.abspath(video)}:{st.st_size}:{st.st_mtime_ns}".encode()).hexdigest()
    cache = Path(os.environ.get("TMPDIR", "/tmp")) / f"twist-audit-pts-{key}.npz"
    if cache.exists():
        z = np.load(cache)
        return z["pts"], int(z["w"]), int(z["h"])
    p = subprocess.run([FFPROBE, "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height",
                        "-of", "csv=p=0", video], capture_output=True, text=True, check=True)
    w, h = (int(x) for x in p.stdout.strip().split(",")[:2])
    p = subprocess.run([FFPROBE, "-v", "error", "-select_streams", "v:0", "-show_entries", "frame=pts_time",
                        "-of", "csv=p=0", video], capture_output=True, text=True, check=True)
    pts = []
    for line in p.stdout.splitlines():
        f = line.split(",")[0].strip()
        if f and f != "N/A":
            pts.append(float(f) * 1000)
    pts = np.array(pts, float)
    np.savez(cache, pts=pts, w=w, h=h)
    return pts, w, h


def iter_frames(video: str, first: int, last: int, w: int, h: int):
    """Yield (frame index, HxWx3 uint8) for frames first..last inclusive: one
    ffmpeg pass, streamed, so a whole solve never sits in memory at once."""
    cmd = [FFMPEG, "-v", "error", "-vsync", "passthrough", "-i", video,
           "-vf", f"select='between(n\\,{first}\\,{last})'", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=10 ** 7)
    n = w * h * 3
    i = first
    try:
        while True:
            buf = p.stdout.read(n)
            if len(buf) < n:
                break
            yield i, np.frombuffer(buf, np.uint8).reshape(h, w, 3)
            i += 1
    finally:
        p.stdout.close()
        p.wait()


# ------------------------------------------------------------------ truth

def turn_ends(moves, clock):
    """Host ms at which each turn's layer came to rest: the fitted send time
    minus the report latency. Falls back to the arrival stamp without tRaw."""
    ends = []
    for m in moves:
        t_fit = clock["slope"] * m["tRaw"] + clock["offsetLsq"] if m.get("tRaw") is not None else m["t"]
        ends.append(t_fit - LATENCY_MS)
    return np.array(ends, float)


def label_frame(t: float, ends: np.ndarray, window: float, tail: float, guard: float):
    """-> ('turn', move index, dt) | ('rest', None, dt) | ('margin', None, dt);
    dt = t - the nearest turn end (negative = before the layer stopped)."""
    if not len(ends):
        return "rest", None, None
    d = t - ends
    covering = np.where((d >= -window) & (d <= tail))[0]
    if len(covering):
        j = int(covering[np.argmin(np.abs(d[covering]))])
        return "turn", j, float(d[j])
    j = int(np.argmin(np.abs(d)))
    return ("rest" if abs(d[j]) > guard else "margin"), None, float(d[j])


def wrap90(x: float) -> float:
    return ((x + 45.0) % 90.0) - 45.0


def sweep_stats(readings):
    """readings: [(dt, deg)] in time order for one turn -> dict or None (fewer
    than three). Steps are wrapped into (-45, 45]; monotone means every step
    is in the sweep's direction up to SWEEP_TOL_DEG, and the sweep has to
    cover SWEEP_MIN_DEG."""
    if len(readings) < 3:
        return None
    degs = [r[1] for r in readings]
    steps = [wrap90(b - a) for a, b in zip(degs, degs[1:])]
    total = sum(steps)
    sign = 1 if total >= 0 else -1
    monotone = all(sign * s >= -SWEEP_TOL_DEG for s in steps) and abs(total) >= SWEEP_MIN_DEG
    return {"n": len(readings), "totalDeg": round(total, 1), "monotone": bool(monotone),
            "medianStep": round(float(np.median([abs(s) for s in steps])), 1)}


# ------------------------------------------------------------------ strips

def make_thumb(arr, det, thresh: float, size: int):
    """Stage 1's window (the whole frame on a miss) at `size` px with the quads
    drawn: grey without a twist read, green -> magenta by p(twisted), the
    class and angle printed where p clears `thresh`."""
    from PIL import Image, ImageDraw
    img = Image.fromarray(arr)
    if det is None:
        t = img.copy()
        t.thumbnail((size, size))
        return t
    x0, y0, x1, y1 = det.window
    crop = img.crop((int(x0), int(y0), int(x1), int(y1)))
    sc = size / max(1, max(crop.width, crop.height))
    crop = crop.resize((max(1, int(crop.width * sc)), max(1, int(crop.height * sc))))
    d = ImageDraw.Draw(crop)
    for q in det.quads:
        pts = [((x - x0) * sc, (y - y0) * sc) for x, y in q["quad"]]
        tw = q.get("twist")
        pt = tw["pTwisted"] if tw else None
        col = (170, 170, 170) if pt is None else (int(60 + 195 * pt), int(200 * (1 - pt)), int(60 + 195 * pt))
        d.line(pts + [pts[0]], fill=col, width=2)
        if pt is not None and pt >= thresh:
            cx = sum(x for x, _ in pts) / 4
            cy = sum(y for _, y in pts) / 4
            d.text((cx - 12, cy - 6), f"{SHORT[CLASSES[tw['twistCls']]]} {tw['deg']:.0f}", fill=col)
    return crop


def write_strip(path: Path, title: str, thumbs, captions, size: int):
    """A grid of thumbnails (STRIP_COLS wide) with a caption under each."""
    from PIL import Image, ImageDraw
    n = len(thumbs)
    cols = min(STRIP_COLS, max(1, n))
    rows = (n + cols - 1) // cols
    cell_w, cell_h = size + 4, size + 16
    out = Image.new("RGB", (cols * cell_w, 18 + rows * cell_h), (24, 24, 24))
    d = ImageDraw.Draw(out)
    d.text((4, 3), title, fill=(230, 230, 230))
    for k, (t, cap) in enumerate(zip(thumbs, captions)):
        r, c = divmod(k, cols)
        x, y = c * cell_w + 2, 18 + r * cell_h + 2
        out.paste(t, (x + (size - t.width) // 2, y + (size - t.height) // 2))
        d.text((x, y + size + 2), cap, fill=(200, 200, 200))
    out.save(path)


# ------------------------------------------------------------------ main

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("session")
    ap.add_argument("--ckpt", required=True, help="stage-2 checkpoint (a --twist run's best.pt)")
    ap.add_argument("--box", default=str(ROOT / "model/train/runs/box17/best.pt"), help="stage-1 checkpoint")
    ap.add_argument("--solve", type=int, default=0, help="only this timed solve (1-based); default all")
    ap.add_argument("--lead", type=float, default=3.0, help="seconds before each solve's start")
    ap.add_argument("--tail", type=float, default=1.0, help="seconds after each solve's end")
    ap.add_argument("--stride", type=int, default=1, help="score every Nth frame")
    ap.add_argument("--max-frames", type=int, default=0, help="stop after this many scored frames per window (0 = all)")
    ap.add_argument("--window", type=float, default=350, help="ms before a turn's end that count as the turn")
    ap.add_argument("--tail-ms", type=float, default=30, help="ms after a turn's end that still count as the turn")
    ap.add_argument("--guard", type=float, default=600, help="ms from every turn's end before a frame counts as rest")
    ap.add_argument("--thresh", type=float, default=0.5, help="p(twisted) for the per-layer table and the sweeps")
    ap.add_argument("--det-thresh", type=float, default=0.3, help="heatmap score to keep a quad (the app's 0.3)")
    ap.add_argument("--anchor", choices=["t0", "chunk"], default="t0",
                    help="video time 0 = meta.t0 (default, what the latency was measured with) or chunkT[0] - 1 s")
    ap.add_argument("--out", default=None, help="output dir (default <session>/twist-audit/<run>)")
    ap.add_argument("--strips", type=int, default=0, help="write contact strips for the first N turns")
    ap.add_argument("--thumb", type=int, default=160, help="strip thumbnail size, px")
    args = ap.parse_args()

    from PIL import Image

    from twostage import TwoStage

    sess = args.session.rstrip("/\\")
    meta, header, moves, solves = load_session(sess)
    if not moves:
        raise SystemExit(f"{sess}: the cube logged no moves - nothing to audit against")
    if not Path(args.box).exists():
        raise SystemExit(f"stage-1 checkpoint not found: {args.box} (pass --box)")
    run = Path(args.ckpt).resolve().parent.name
    out = Path(args.out) if args.out else Path(sess) / "twist-audit" / run
    out.mkdir(parents=True, exist_ok=True)

    clock = fit_clock(moves) if all(m.get("tRaw") is not None for m in moves) and len(moves) >= 2 \
        else {"slope": 1.0, "offsetLsq": 0.0, "offsetEnvelope": 0.0, "n": len(moves)}
    ends = turn_ends(moves, clock)
    video = os.path.join(sess, "video.webm")
    pts, w, h = probe(video)
    anchors = {"t0": float(meta["t0"]), "chunk": float(meta["chunkT"][0]) - CHUNK_MS}
    host = anchors[args.anchor] + pts

    # the windows to score, in host ms
    windows = []
    if solves:
        for n, s in enumerate(solves, 1):
            if args.solve and n != args.solve:
                continue
            windows.append((f"solve {n}", s["t0"] - args.lead * 1000, s["t1"] + args.tail * 1000))
    else:
        windows.append(("moves", moves[0]["t"] - args.lead * 1000, moves[-1]["t"] + args.tail * 1000))
    if not windows:
        raise SystemExit(f"no solve {args.solve} in {sess} ({len(solves)} solves)")

    ts = TwoStage.load(args.ckpt, args.box, thresh=args.det_thresh)
    has_twist = bool(getattr(ts.model, "twist", False))
    if not has_twist:
        print("NOTE: this checkpoint has no twist head - reporting detector coverage only", file=sys.stderr)

    frames_out = []
    thumbs: dict[int, object] = {}  # frame index -> thumbnail, turn frames only, with --strips
    turns: dict[int, dict] = {}     # move index -> record
    t_start = time.time()
    scored = 0
    for name, t_from, t_to in windows:
        first = int(np.searchsorted(host, t_from))
        last = int(np.searchsorted(host, t_to, side="right")) - 1
        if last < first:
            print(f"{name}: no video frames in [{t_from:.0f}, {t_to:.0f}]", file=sys.stderr)
            continue
        in_window = [j for j in range(len(moves)) if t_from <= ends[j] <= t_to]
        for j in in_window:
            turns.setdefault(j, {"index": j, "move": moves[j]["move"], "layer": moves[j]["move"][0],
                                 "end": round(float(ends[j]), 1), "window": name, "frames": []})
        print(f"{name}: frames {first}..{last} ({last - first + 1}), {len(in_window)} turns", file=sys.stderr)
        n_done = 0
        for i, arr in iter_frames(video, first, last, w, h):
            if (i - first) % args.stride:
                continue
            if args.max_frames and n_done >= args.max_frames:
                break
            t = float(host[i])
            truth, mi, dt = label_frame(t, ends, args.window, args.tail_ms, args.guard)
            det = ts.detect(Image.fromarray(arr))
            if args.strips and truth == "turn":
                thumbs[i] = make_thumb(arr, det, args.thresh, args.thumb)
            rec = {"i": i, "t": round(t, 1), "truth": truth, "move": mi, "dt": None if dt is None else round(dt),
                   "obj": round(float(det.obj), 3) if det else 0.0, "quads": []}
            pmax = None
            for q in (det.quads if det else []):
                quad = q["quad"]
                c = quad.mean(axis=0)
                edge = float(np.linalg.norm(quad - np.roll(quad, -1, axis=0), axis=1).mean())
                qq = {"score": round(float(q["score"]), 3), "cx": round(float(c[0]), 1), "cy": round(float(c[1]), 1),
                      "edge": round(edge, 1)}
                if "twist" in q:
                    tw = q["twist"]
                    # cls: which layer, given that one is turning (argmax over the twisted classes)
                    qq.update(p=round(tw["pTwisted"], 3), cls=int(tw["twistCls"]), deg=round(tw["deg"], 1))
                    pmax = tw["pTwisted"] if pmax is None else max(pmax, tw["pTwisted"])
                rec["quads"].append(qq)
            rec["pmax"] = None if pmax is None else round(pmax, 3)
            frames_out.append(rec)
            if truth == "turn":
                turns[mi]["frames"].append(rec)
            scored += 1
            n_done += 1
            if scored % 200 == 0:
                print(f"  {scored} frames, {(time.time() - t_start) * 1000 / scored:.0f} ms/frame", file=sys.stderr)
    ms_per_frame = (time.time() - t_start) * 1000 / max(1, scored)

    # ---- per-turn summaries
    for tr in turns.values():
        fr = tr["frames"]
        tr["nFrames"] = len(fr)
        tr["nWithQuads"] = sum(1 for f in fr if f["quads"])
        ps = [f["pmax"] for f in fr if f["pmax"] is not None]
        tr["pmax"] = round(max(ps), 3) if ps else None
        # the strongest quad per frame above --thresh, in time order: the sweep
        readings = []
        for f in fr:
            best = max((q for q in f["quads"] if "p" in q), key=lambda q: q["p"], default=None)
            if best and best["p"] >= args.thresh:
                readings.append({"dt": f["dt"], "deg": best["deg"], "cls": CLASSES[best["cls"]], "p": best["p"]})
        tr["readings"] = readings
        tr["sweep"] = sweep_stats([(r["dt"], r["deg"]) for r in readings])
        tr["frameIdx"] = [f["i"] for f in fr]
        tr["captions"] = [f"{f['dt']:+.0f}ms" + (f" p{f['pmax']:.2f}" if f["pmax"] is not None else "") for f in fr]
        del tr["frames"]   # the frames are in the frame list already

    turn_list = sorted(turns.values(), key=lambda t: t["end"])
    if args.strips:
        sdir = out / "strips"
        sdir.mkdir(exist_ok=True)
        for tr in [t for t in turn_list if t["nFrames"]][:args.strips]:
            title = (f"{tr['move']}  end {tr['end']:.0f}  pmax {tr['pmax']}  "
                     f"{tr['nWithQuads']}/{tr['nFrames']} frames with a quad")
            write_strip(sdir / f"turn-{tr['index']:03d}-{tr['move'].replace(chr(39), 'p')}.png", title,
                        [thumbs[i] for i in tr["frameIdx"]], tr["captions"], args.thumb)
        print(f"strips: {min(args.strips, len(turn_list))} in {sdir}", file=sys.stderr)
    for tr in turn_list:
        del tr["captions"]
    with_frames = [t for t in turn_list if t["nFrames"]]
    with_quads = [t for t in with_frames if t["nWithQuads"]]
    rest = [f for f in frames_out if f["truth"] == "rest"]
    rest_q = [f for f in rest if f["quads"]]
    turn_frames = [f for f in frames_out if f["truth"] == "turn"]

    def seen(t, thr):
        return t["pmax"] is not None and t["pmax"] >= thr

    metrics = {
        "framesScored": scored, "msPerFrame": round(ms_per_frame, 1), "hasTwist": has_twist,
        "turns": len(turn_list), "turnsWithFrames": len(with_frames), "turnsWithQuads": len(with_quads),
        "turnFrames": len(turn_frames), "turnFramesWithQuads": sum(1 for f in turn_frames if f["quads"]),
        "restFrames": len(rest), "restFramesWithQuads": len(rest_q),
        "byThreshold": {}, "byLayer": {}, "classMix": {}, "sweep": {},
    }
    if has_twist:
        for thr in THRESHOLDS:
            n_seen = sum(1 for t in with_frames if seen(t, thr))
            fa = sum(1 for f in rest if f["pmax"] is not None and f["pmax"] >= thr)
            metrics["byThreshold"][str(thr)] = {
                "turnsSeen": n_seen,
                "recall": round(n_seen / len(with_frames), 3) if with_frames else None,
                "recallGivenQuads": (round(sum(1 for t in with_quads if seen(t, thr)) / len(with_quads), 3)
                                     if with_quads else None),
                "restFalseAlarms": fa,
                "farAllRest": round(fa / len(rest), 3) if rest else None,
                "farRestWithQuads": round(fa / len(rest_q), 3) if rest_q else None,
            }
        for layer in "URFDLB":
            ts_l = [t for t in with_frames if t["layer"] == layer]
            metrics["byLayer"][layer] = {"turns": len(ts_l), "withQuads": sum(1 for t in ts_l if t["nWithQuads"]),
                                         "seen": sum(1 for t in ts_l if seen(t, args.thresh))}
        mix = {c: 0 for c in CLASSES[1:]}
        for f in turn_frames:
            for q in f["quads"]:
                if "p" in q and q["p"] >= args.thresh:
                    mix[CLASSES[q["cls"]]] += 1
        metrics["classMix"] = mix
        sw = [t["sweep"] for t in turn_list if t["sweep"]]
        metrics["sweep"] = {"turnsWith3Readings": len(sw), "monotone": sum(1 for s in sw if s["monotone"]),
                            "medianStepDeg": round(float(np.median([s["medianStep"] for s in sw])), 1) if sw else None}

    # ---- write
    config = vars(args) | {"run": run, "latencyMs": LATENCY_MS, "anchorValue": anchors[args.anchor],
                           "windows": windows}
    (out / "audit.json").write_text(json.dumps(
        {"session": os.path.basename(sess), "config": config, "clock": clock, "metrics": metrics,
         "turns": turn_list, "frames": frames_out},
        indent=1, default=lambda o: o.item() if hasattr(o, "item") else str(o)))
    coverage = 100 * len(with_quads) / max(1, len(with_frames))
    lines = [f"# Twist audit: {os.path.basename(sess)} with {run}", "",
             f"- windows: {', '.join(f'{n} [{a:.0f}, {b:.0f}]' for n, a, b in windows)}; stride {args.stride}",
             f"- {scored} frames scored at {ms_per_frame:.0f} ms/frame; anchor {args.anchor}; cube clock slope "
             f"{clock['slope']:.6f}, offset {clock['offsetLsq']:.1f} (least squares, as the latency was measured)",
             f"- a turn = [end - {args.window:.0f}, end + {args.tail_ms:.0f}] ms with end = fitted send time "
             f"- {LATENCY_MS:.0f} ms; rest = further than {args.guard:.0f} ms from every end",
             f"- turns in the windows: {len(turn_list)}; with video frames {len(with_frames)}; with at least one "
             f"quad {len(with_quads)} (detector coverage {coverage:.0f}%)",
             f"- turn frames {len(turn_frames)}, of which {metrics['turnFramesWithQuads']} carry a quad; rest "
             f"frames {len(rest)}, of which {len(rest_q)} carry a quad", ""]
    if not has_twist:
        lines += ["**This checkpoint has no twist head**: the numbers above are the detector's coverage "
                  "baseline only.", ""]
    else:
        lines += ["| p(twisted) >= | turns seen | recall | recall given a quad | rest false alarms "
                  "| FAR (rest w/ quad) |", "|---|---|---|---|---|---|"]
        for thr, m in metrics["byThreshold"].items():
            lines.append(f"| {thr} | {m['turnsSeen']} / {len(with_frames)} | {m['recall']} | "
                         f"{m['recallGivenQuads']} | {m['restFalseAlarms']} / {len(rest)} | {m['farRestWithQuads']} |")
        lines += ["", f"Per layer at p >= {args.thresh} (white U, red R, green F, yellow D, orange L, blue B):",
                  "", "| layer | turns | with a quad | seen |", "|---|---|---|---|"]
        for layer, m in metrics["byLayer"].items():
            lines.append(f"| {layer} | {m['turns']} | {m['withQuads']} | {m['seen']} |")
        mix = metrics["classMix"]
        lines += ["", f"Class mix of twisted reads on turn frames at p >= {args.thresh}: "
                  + ", ".join(f"{k} {v}" for k, v in mix.items()),
                  f"Sweeps: {metrics['sweep']['turnsWith3Readings']} turns with 3+ twisted frames, "
                  f"{metrics['sweep']['monotone']} monotone (>= {SWEEP_MIN_DEG:.0f} deg covered), "
                  f"median step {metrics['sweep']['medianStepDeg']} deg/frame", ""]
        shown = [t for t in turn_list if t["readings"]][:10]
        if shown:
            lines += ["First seen turns (dt ms from the layer's stop: angle mod 90, class, p):", ""]
            for t in shown:
                lines.append(f"- {t['move']:3s} end {t['end']:.0f}: " + "  ".join(
                    f"{r['dt']:+.0f}:{r['deg']:.0f}°{r['cls']}({r['p']:.2f})" for r in t["readings"]))
            lines.append("")
        m5 = metrics["byThreshold"]["0.5"]
        verdict = ("under half" if (m5["recall"] or 0) < 0.5 else "at least half")
        lines += [f"**Verdict at p >= 0.5: {m5['turnsSeen']} of {len(with_frames)} turns show a twist on at least "
                  f"one frame ({verdict}; design doc 5.3 sends under half to the video-window model).**", ""]
    (out / "summary.md").write_text("\n".join(lines))
    print("\n".join(lines))
    print(f"wrote {out / 'summary.md'} and audit.json", file=sys.stderr)


if __name__ == "__main__":
    main()
