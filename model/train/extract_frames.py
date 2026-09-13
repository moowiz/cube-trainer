"""Pull labelable still frames out of phone videos.

    python extract_frames.py VIDEO [VIDEO ...] --out ../../stephens_photos/batch7
    python extract_frames.py clip.mp4 --out batch7 --every 1.5 --long-side 1280

Shoot the video the way you'd use the app (portrait, phone in hand), then
this picks one frame per --every seconds: it decodes at --rate fps, keeps
the sharpest frame in each window (variance of the Laplacian, so motion
blur loses), and drops a window whose winner is a near-duplicate of the
previous keeper. Output is flat numbered JPEGs, ready for
web/public/label.html and then import_labels.py, same as a photo batch.

ffmpeg comes from the imageio-ffmpeg wheel (bundled static binary, no
system install); it auto-applies the phone's rotation tag, so a portrait
video comes out portrait.
"""
from __future__ import annotations

import argparse
import shutil
import subprocess
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

# DECISION: defaults tuned for a hand-held phone clip. 1 keeper/second is
# plenty (adjacent seconds of a slowly moving cube are near-duplicates
# anyway); 4 fps decode gives the sharpness picker 4 candidates per window.
DEF_EVERY = 1.0
DEF_RATE = 4
DEF_LONG_SIDE = 1280
DEF_DUP = 0.06     # mean |diff| on a 32x32 grey thumb, 0..1; below = duplicate
DEF_BLUR = 0.35    # reject a window whose sharpest frame is < this * clip median


def ffmpeg_exe() -> str:
    import imageio_ffmpeg
    return imageio_ffmpeg.get_ffmpeg_exe()


def decode(video: Path, tmp: Path, rate: int, long_side: int) -> list[Path]:
    # scale keeps aspect; -2 rounds the other side to even. autorotate is on
    # by default so the rotate tag is honoured before scaling.
    vf = (f"fps={rate},scale='if(gt(iw,ih),{long_side},-2)':'if(gt(iw,ih),-2,{long_side})'")
    cmd = [ffmpeg_exe(), "-hide_banner", "-loglevel", "error", "-i", str(video),
           "-vf", vf, "-q:v", "2", str(tmp / "f%06d.jpg")]
    subprocess.run(cmd, check=True)
    return sorted(tmp.glob("f*.jpg"))


def sharpness(im: Image.Image) -> float:
    g = im.convert("L")
    g.thumbnail((640, 640))
    lap = np.asarray(g.filter(ImageFilter.FIND_EDGES), np.float32)
    return float(lap.var())


def thumb(im: Image.Image) -> np.ndarray:
    return np.asarray(im.convert("L").resize((32, 32), Image.BILINEAR), np.float32) / 255


def extract(video: Path, out: Path, start_idx: int, a: argparse.Namespace) -> int:
    with tempfile.TemporaryDirectory(prefix="frames_") as td:
        frames = decode(video, Path(td), a.rate, a.long_side)
        if not frames:
            print(f"{video.name}: no frames decoded"); return 0
        ims = [Image.open(f).convert("RGB") for f in frames]
        sharp = np.array([sharpness(im) for im in ims])
        floor = a.blur * float(np.median(sharp))
        win = max(1, round(a.every * a.rate))
        kept, last_thumb, n_dup, n_blur = 0, None, 0, 0
        for w0 in range(0, len(ims), win):
            idx = w0 + int(np.argmax(sharp[w0:w0 + win]))
            if sharp[idx] < floor:
                n_blur += 1; continue
            t = thumb(ims[idx])
            if last_thumb is not None and float(np.abs(t - last_thumb).mean()) < a.dup:
                n_dup += 1; continue
            last_thumb = t
            name = f"{a.prefix}{start_idx + kept:05d}.jpg"
            ims[idx].save(out / name, quality=92)
            kept += 1
            if a.max and kept >= a.max: break
        w, h = ims[0].size
        print(f"{video.name}: {len(ims)} decoded at {w}x{h}, {len(ims)//win} windows -> kept {kept} "
              f"(dropped {n_blur} blurry, {n_dup} duplicate)")
        return kept


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("videos", nargs="+", type=Path)
    p.add_argument("--out", required=True, type=Path, help="flat output dir (a stephens_photos batch)")
    p.add_argument("--every", type=float, default=DEF_EVERY, help="seconds between keepers")
    p.add_argument("--rate", type=int, default=DEF_RATE, help="decode fps (candidates per window)")
    p.add_argument("--long-side", type=int, default=DEF_LONG_SIDE, help="resize so the long side is this")
    p.add_argument("--dup", type=float, default=DEF_DUP)
    p.add_argument("--blur", type=float, default=DEF_BLUR)
    p.add_argument("--max", type=int, default=0, help="stop after this many keepers per video")
    p.add_argument("--prefix", default="v", help="filename prefix; numbering continues past existing files")
    a = p.parse_args()
    a.out.mkdir(parents=True, exist_ok=True)
    existing = [int(f.stem[len(a.prefix):]) for f in a.out.glob(f"{a.prefix}*.jpg") if f.stem[len(a.prefix):].isdigit()]
    idx = (max(existing) + 1) if existing else 0
    for v in a.videos:
        idx += extract(v, a.out, idx, a)
    print(f"total {len(list(a.out.glob(f'{a.prefix}*.jpg')))} frames in {a.out}")


if __name__ == "__main__":
    main()
