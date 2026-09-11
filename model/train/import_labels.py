"""Import hand labels from the web labeling tool (web/public/label.html) into
a training dataset root (M5).

    python import_labels.py --labels path/to/labels-all.json --images path/to/photos --out ../data_real
    python import_labels.py --labels path/to/label_json_dir --images path/to/photos --out ../data_real

Accepts either the tool's combined export (a JSON array) or a directory of
its per-image JSON files. Copies each referenced image into <out>/images/ and
writes <out>/labels/img_realNNNNNN.json in the training schema (which is the
tool's schema plus a rewritten image path). Re-running skips names already
imported. The result trains directly:  train.py --data ../data,../data_real

Corners may be clicked in any order AROUND the face (any starting corner,
either direction) - the training loss is invariant to cyclic shifts, and
this importer normalizes winding to match the synthetic convention (positive
shoelace area in image coords, i.e. clockwise on screen) so a reflection
never reaches training. Zigzag (self-intersecting) quads are caught by
check_labels.py, which should run before importing.
"""
from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path

from PIL import Image


def normalize_winding(faces: dict) -> dict:
    """Reverse any counterclockwise-clicked quad so all labels share the
    synthetic winding (a visible face always projects clockwise on screen)."""
    out = {}
    for name, fd in faces.items():
        fd = dict(fd)
        c = fd.get("corners")
        if c and len(c) == 4:
            area2 = sum(c[i][0] * c[(i + 1) % 4][1] - c[(i + 1) % 4][0] * c[i][1] for i in range(4))
            if area2 < 0:
                fd["corners"] = c[::-1]
        out[name] = fd
    return out


def load_entries(labels_path: Path):
    if labels_path.is_dir():
        for f in sorted(labels_path.glob("*.json")):
            data = json.loads(f.read_text())
            yield from data if isinstance(data, list) else [data]
    else:
        data = json.loads(labels_path.read_text())
        yield from data if isinstance(data, list) else [data]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--labels", required=True)
    ap.add_argument("--images", required=True, help="directory holding the original photos")
    ap.add_argument("--out", default="../data_real")
    args = ap.parse_args()

    out = Path(args.out)
    (out / "images").mkdir(parents=True, exist_ok=True)
    (out / "labels").mkdir(parents=True, exist_ok=True)
    existing = {}
    for f in (out / "labels").glob("*.json"):
        existing[json.loads(f.read_text())["source"]] = f
    n_have = len(existing)
    imported = updated = skipped = missing = 0
    for entry in load_entries(Path(args.labels)):
        src_name = entry["image"]
        if src_name in existing:
            # already imported: refresh in place if the labels were edited
            # (the labeler exports the whole set, so re-exports come through
            # here after fixing a face)
            lf = existing[src_name]
            stored = json.loads(lf.read_text())
            faces = normalize_winding(entry["faces"])
            if faces != stored["faces"]:
                stored["faces"] = faces
                lf.write_text(json.dumps(stored, indent=1))
                updated += 1
            else:
                skipped += 1
            continue
        src = Path(args.images) / src_name
        if not src.exists():
            print(f"  missing image, skipped: {src_name}")
            missing += 1
            continue
        if not any(f["visible"] for f in entry["faces"].values()):
            skipped += 1
            continue
        idx = n_have + imported + 1
        stem = f"img_real{idx:06d}"
        dst_img = out / "images" / (stem + src.suffix.lower())
        shutil.copyfile(src, dst_img)
        # trust the file over the label for dimensions
        with Image.open(dst_img) as im:
            w, h = im.size
        label = {
            "image": f"images/{dst_img.name}",
            "source": src_name,
            "width": w,
            "height": h,
            "style": "real",
            "faces": normalize_winding(entry["faces"]),
        }
        (out / "labels" / (stem + ".json")).write_text(json.dumps(label, indent=1))
        imported += 1
    print(f"imported {imported}, updated {updated}, skipped {skipped} (unchanged or empty), "
          f"{missing} missing images -> {out}")


if __name__ == "__main__":
    main()
