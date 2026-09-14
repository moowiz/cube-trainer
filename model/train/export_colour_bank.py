"""Turn the hand-labelled photo roots into a colour test bank for the web
tests: every frame at the app's resolution as a PNG, plus one index of the
labelled quads and the centre-colour truth the face letters carry.

    python export_colour_bank.py                       # data_real + data_real_val -> ../../web/test/bank/colour
    python export_colour_bank.py --roots ../data_real_val --out /tmp/bank

web/test/colour-bank.test.ts warps each labelled quad with the app's own
rectify + sampler and measures how well each candidate embedding separates
the six centre colours per batch (red/orange and white/yellow margins,
leave-one-out naming accuracy). The bank is gitignored like the photos.

Resolution: the phone gives the app 480x640 (3:4) and a webcam 640x480, so
a 3000x4000 photo is shrunk to height 640 and a 720x1280 clip still to
360x640 - sampling the native photo would be unrealistically clean. Quads
are scaled with the image. The letter -> centre colour map is the standard
scheme the labels follow (U white, R red, F green, D yellow, L orange, B
blue); `check_labels.py`'s centre verdict rides along so the test can drop a
centre that is under a thumb or blown out.
"""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

from PIL import Image

from grid_check import center_color, warp_face

LETTER_COLOUR = {"U": "white", "R": "red", "F": "green", "D": "yellow", "L": "orange", "B": "blue"}
APP_LONG_SIDE = 640


def batch_index(photos: Path) -> dict[str, str]:
    """Bare source name -> batch dir (the pre-batch-8 convention; the lowest
    numbered batch owns a name), as in diagnose.py."""
    idx: dict[str, str] = {}
    if not photos.is_dir():
        return idx
    def key(p: Path):
        m = re.search(r"\d+", p.name)
        return (int(m.group()) if m else 0, p.name)

    for d in sorted(photos.iterdir(), key=key):
        if d.is_file() and d.suffix.lower() in (".jpg", ".jpeg", ".png"):
            idx.setdefault(d.name, "batch1")
        elif d.is_dir() and not d.name.startswith("_"):
            for g in d.iterdir():
                if g.suffix.lower() in (".jpg", ".jpeg", ".png"):
                    idx.setdefault(g.name, d.name)
    return idx


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--roots", default="../data_real,../data_real_val")
    ap.add_argument("--out", default="../../web/test/bank/colour")
    ap.add_argument("--photos", default="../../stephens_photos", help="batch dirs, for attributing bare source names")
    a = ap.parse_args()
    batches = batch_index(Path(a.photos))
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    index = []
    for root in a.roots.split(","):
        root = Path(root)
        for lf in sorted((root / "labels").glob("*.json")):
            lab = json.loads(lf.read_text())
            faces = {k: f for k, f in lab["faces"].items() if f.get("visible") and f.get("corners")}
            if not faces:
                continue
            im = Image.open(root / lab["image"]).convert("RGB")
            w, h = im.size
            s = APP_LONG_SIDE / max(w, h)
            small = im.resize((round(w * s), round(h * s)), Image.LANCZOS)
            png = f"{root.name}-{lf.stem}.png"
            small.save(out / png, optimize=True)
            src = lab["source"]
            batch = src.split("/")[0] if "/" in src else batches.get(src, "?")
            entry = {"png": png, "root": root.name, "source": src, "batch": batch,
                     "width": small.width, "height": small.height, "faces": {}}
            for letter, f in faces.items():
                # the verdict is read on the native photo, where the checker was tuned
                verdict = center_color(warp_face(im, f["corners"]))
                entry["faces"][letter] = {
                    "corners": [[x * s, y * s] for x, y in f["corners"]],
                    "colour": LETTER_COLOUR[letter],
                    "centreVerdict": verdict,
                }
            index.append(entry)
    (out / "index.json").write_text(json.dumps(index, indent=1))
    n_faces = sum(len(e["faces"]) for e in index)
    print(f"{len(index)} frames, {n_faces} faces -> {out}")


if __name__ == "__main__":
    main()
