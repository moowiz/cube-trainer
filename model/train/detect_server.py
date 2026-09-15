"""Local detector server: webcam -> two-stage on CUDA -> frames + quads over a
WebSocket, for the web app's dev-only `?detector=local` mode.

    python detect_server.py --ckpt runs/kpft8/best.pt --box-ckpt runs/box17/best.pt
    python detect_server.py ... --exposure -6 --show      # manual 1/64 s, local preview window

Why: the browser can only run exported ONNX through ort-web (6 ms webgpu /
15 ms wasm for a 150 MMAC net that is <1 ms on the GPU natively), gets the
webcam through a video->canvas->getImageData copy chain, and has no reliable
exposure control on Windows. This process owns the camera and runs ANY
checkpoint (no export step) so an unexported model can be tried live with the
real colour pipeline behind it. It is a dev tool: the deployed app never
talks to a server (CLAUDE.md, first non-negotiable).

Wire protocol (ws://localhost:PORT, server -> client only):
  - on connect, one TEXT message: {"hello": true, "w", "h", "head", "ckpt", "box_ckpt"}
  - then one BINARY message per camera frame:
        u32 little-endian header length | header JSON (utf-8) | JPEG bytes
    header = {
      "seq":   frame counter,
      "t":     capture time, ms (time.perf_counter, monotonic; the client keeps its own clock),
      "w", "h": frame size,
      "obj":   stage-1 objectness (also on a miss),
      "box":   [x0, y0, x1, y1] source px, or null when stage 1 saw no cube,
      "roi":   the padded window stage 2 looked at, or null,
      "quads": [{"conf", "corners": [[x, y] x4]}]   # DetectedQuad: cyclic, consistent
                                                   # winding, arbitrary start, source px
      "ms":    {"detect", "encode"}
    }
The frame and its quads travel together, so the pair is synced by
construction: the client draws the quads on the JPEG in the same message
and fuses them at `t`. Corners are the app's `DetectedQuad` verbatim.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import struct
import sys
import threading
import time
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

from twostage import TwoStage


def open_camera(args) -> cv2.VideoCapture:
    backend = {"dshow": cv2.CAP_DSHOW, "msmf": cv2.CAP_MSMF, "any": cv2.CAP_ANY}[args.backend]
    cap = cv2.VideoCapture(args.camera, backend)
    if not cap.isOpened():
        raise SystemExit(f"camera {args.camera} did not open (backend {args.backend})")
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, args.width)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, args.height)
    cap.set(cv2.CAP_PROP_FPS, args.fps)
    if args.exposure is not None:
        # DirectShow: 0.25 = manual, 0.75 = auto; CAP_PROP_EXPOSURE is log2(seconds),
        # so -6 = 1/64 s. The LifeCam HD-3000 sits on that power-of-two grid exactly.
        cap.set(cv2.CAP_PROP_AUTO_EXPOSURE, 0.25)
        cap.set(cv2.CAP_PROP_EXPOSURE, args.exposure)
    else:
        cap.set(cv2.CAP_PROP_AUTO_EXPOSURE, 0.75)
    w, h = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    print(f"camera {args.camera}: {w}x{h} @ {cap.get(cv2.CAP_PROP_FPS):g} fps, "
          f"exposure {cap.get(cv2.CAP_PROP_EXPOSURE):g} "
          f"({'manual' if args.exposure is not None else 'auto'})")
    return cap


def encode_message(header: dict, jpeg: bytes) -> bytes:
    hdr = json.dumps(header, separators=(",", ":")).encode("utf-8")
    return struct.pack("<I", len(hdr)) + hdr + jpeg


def draw_overlay(bgr: np.ndarray, header: dict) -> np.ndarray:
    """The --show preview: box thin green, quads cyan with the score at corner 0."""
    if header["box"]:
        x0, y0, x1, y1 = (int(round(v)) for v in header["box"])
        cv2.rectangle(bgr, (x0, y0), (x1, y1), (110, 230, 90), 1)
    for q in header["quads"]:
        pts = np.array(q["corners"], dtype=np.int32)
        cv2.polylines(bgr, [pts], True, (255, 230, 0), 2 if q["conf"] >= 0.5 else 1)
        cv2.circle(bgr, tuple(pts[0]), 4, (200, 0, 255), -1)
        cv2.putText(bgr, f"{q['conf']:.2f}", (pts[0][0] + 6, pts[0][1] - 4),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.45, (255, 230, 0), 1, cv2.LINE_AA)
    cv2.putText(bgr, f"{header['ms']['detect']:.1f} ms  obj {header['obj']:.2f}", (8, 18),
                cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1, cv2.LINE_AA)
    return bgr


class Publisher:
    """The capture thread writes `latest`; the asyncio side broadcasts it."""

    def __init__(self, loop: asyncio.AbstractEventLoop):
        self.loop = loop
        self.event = asyncio.Event()
        self.latest: bytes | None = None
        self.clients: set = set()
        self.hello: dict = {}
        self.stop = False

    def publish(self, msg: bytes):
        self.latest = msg
        self.loop.call_soon_threadsafe(self.event.set)


def capture_loop(args, ts: TwoStage, pub: Publisher):
    cap = open_camera(args)
    seq, last_report, n_report, detect_ms_sum = 0, time.perf_counter(), 0, 0.0
    enc = [int(cv2.IMWRITE_JPEG_QUALITY), args.jpeg_quality]
    try:
        while not pub.stop:
            ok, bgr = cap.read()
            t = time.perf_counter() * 1000.0
            if not ok:
                print("camera read failed", file=sys.stderr)
                time.sleep(0.05)
                continue
            h, w = bgr.shape[:2]
            t0 = time.perf_counter()
            det = ts.detect(Image.fromarray(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)))
            t1 = time.perf_counter()
            ok, buf = cv2.imencode(".jpg", bgr, enc)
            t2 = time.perf_counter()
            header = {
                "seq": seq, "t": t, "w": w, "h": h,
                "obj": det.obj if det else 0.0,
                "box": [round(v, 2) for v in det.box] if det and det.box else None,
                "roi": [round(v, 2) for v in det.window] if det else None,
                "quads": [{"conf": round(q["score"], 4),
                           "corners": [[round(float(x), 2), round(float(y), 2)] for x, y in q["quad"]]}
                          for q in det.quads] if det else [],
                "ms": {"detect": round((t1 - t0) * 1000, 2), "encode": round((t2 - t1) * 1000, 2)},
            }
            pub.publish(encode_message(header, buf.tobytes()))
            seq += 1
            n_report += 1
            detect_ms_sum += (t1 - t0) * 1000
            now = time.perf_counter()
            if now - last_report >= 2.0:
                print(f"{n_report / (now - last_report):5.1f} fps  detect {detect_ms_sum / n_report:5.1f} ms  "
                      f"quads {len(header['quads'])}  clients {len(pub.clients)}")
                last_report, n_report, detect_ms_sum = now, 0, 0.0
            if args.show:
                cv2.imshow("detect_server", draw_overlay(bgr, header))
                if cv2.waitKey(1) & 0xFF in (27, ord("q")):
                    pub.stop = True
    finally:
        cap.release()
        if args.show:
            cv2.destroyAllWindows()
        pub.loop.call_soon_threadsafe(pub.event.set)


async def serve_forever(args, pub: Publisher):
    from websockets.asyncio.server import broadcast, serve

    async def handler(ws):
        pub.clients.add(ws)
        print(f"client connected: {ws.remote_address}")
        try:
            await ws.send(json.dumps(pub.hello))
            await ws.wait_closed()
        finally:
            pub.clients.discard(ws)
            print("client disconnected")

    async with serve(handler, args.host, args.port, max_size=None, compression=None):
        print(f"serving ws://{args.host}:{args.port}")
        while not pub.stop:
            await pub.event.wait()
            pub.event.clear()
            if pub.latest is not None and pub.clients:
                broadcast(pub.clients, pub.latest)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--ckpt", default="runs/kpft8/best.pt", help="stage-2 facekp checkpoint")
    ap.add_argument("--box-ckpt", default="runs/box17/best.pt", help="stage-1 cubebox checkpoint")
    ap.add_argument("--thresh", type=float, default=0.3, help="center head detection score floor "
                    "(0.3 = decode_maps default, what the app uses)")
    ap.add_argument("--camera", type=int, default=0)
    ap.add_argument("--backend", choices=["dshow", "msmf", "any"], default="dshow",
                    help="DirectShow honours manual exposure on the LifeCam; MSMF is Windows' default")
    ap.add_argument("--width", type=int, default=640)
    ap.add_argument("--height", type=int, default=480)
    ap.add_argument("--fps", type=int, default=30)
    ap.add_argument("--exposure", type=float, default=None,
                    help="manual exposure, log2 seconds (-6 = 1/64 s); omit for auto")
    ap.add_argument("--jpeg-quality", type=int, default=85)
    ap.add_argument("--host", default="localhost")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--show", action="store_true", help="local OpenCV preview window (q / Esc quits)")
    args = ap.parse_args()

    ts = TwoStage.load(args.ckpt, args.box_ckpt, thresh=args.thresh)
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    pub = Publisher(loop)
    pub.hello = {"hello": True, "w": args.width, "h": args.height, "head": ts.head,
                 "ckpt": Path(args.ckpt).as_posix(), "box_ckpt": Path(args.box_ckpt).as_posix()}
    thread = threading.Thread(target=capture_loop, args=(args, ts, pub), daemon=True)
    thread.start()
    try:
        loop.run_until_complete(serve_forever(args, pub))
    except KeyboardInterrupt:
        pass
    finally:
        pub.stop = True
        thread.join(timeout=2)


if __name__ == "__main__":
    main()
