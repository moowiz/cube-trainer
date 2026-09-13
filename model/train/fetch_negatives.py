"""Download a pool of real photos with no cube in them -> ../negatives/

    python fetch_negatives.py            # COCO val2017, 5000 photos, ~780 MB download
    python fetch_negatives.py --max 2000 --long-side 640

COCO val2017 is used because it is the most varied free set of ordinary
scenes (rooms, people, hands, desks, tiled floors) and is licensed for this
(images are Flickr CC; the annotations are CC-BY 4.0 but are not fetched).
Photos are resized so the long side is --long-side and saved as JPEG; the
zip is deleted afterwards. train_bbox.py --neg ../negatives reads the dir.

The chance that a COCO photo contains a Rubik's cube is negligible and a
handful of wrong negatives would not matter against 5000.
"""
from __future__ import annotations

import argparse
import io
import sys
import urllib.request
import zipfile
from pathlib import Path

from PIL import Image

URL = "http://images.cocodataset.org/zips/val2017.zip"


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default="../negatives", type=Path)
    ap.add_argument("--max", type=int, default=0, help="stop after this many (0 = all 5000)")
    ap.add_argument("--long-side", type=int, default=640)
    ap.add_argument("--keep-zip", action="store_true")
    a = ap.parse_args()
    out = a.out.resolve()
    out.mkdir(parents=True, exist_ok=True)
    zpath = out.parent / "val2017.zip"
    if not zpath.exists():
        print(f"downloading {URL} -> {zpath}")
        def hook(n, bs, total):
            if n % 200 == 0:
                sys.stdout.write(f"\r  {n * bs / 1e6:7.0f} / {total / 1e6:.0f} MB"); sys.stdout.flush()
        urllib.request.urlretrieve(URL, zpath, hook)
        print()
    n = 0
    with zipfile.ZipFile(zpath) as z:
        names = sorted(m for m in z.namelist() if m.lower().endswith(".jpg"))
        for m in names:
            dst = out / Path(m).name
            if not dst.exists():
                im = Image.open(io.BytesIO(z.read(m))).convert("RGB")
                im.thumbnail((a.long_side, a.long_side), Image.LANCZOS)
                im.save(dst, quality=90)
            n += 1
            if n % 500 == 0:
                print(f"  {n}/{len(names)}")
            if a.max and n >= a.max:
                break
    if not a.keep_zip:
        zpath.unlink()
    print(f"{n} negatives in {out}")


if __name__ == "__main__":
    main()
