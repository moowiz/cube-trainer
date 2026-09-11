"""Import hand labels from the web labeling tool (web/public/label.html) into
a training dataset root (M5).

    python import_labels.py --labels path/to/labels-all.json --images path/to/photos --out ../data_real
    python import_labels.py --labels path/to/label_json_dir --images path/to/photos --out ../data_real

Accepts either the tool's combined export (a JSON array) or a directory of
its per-image JSON files. Copies each referenced image into <out>/images/ and
writes <out>/labels/img_realNNNNNN.json in the training schema (which is the
tool's schema plus a rewritten image path). Re-running skips names already
imported. The result trains directly:  train.py --data ../data,../data_real
"""
from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path

from PIL import Image


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
    existing = {json.loads(f.read_text())["source"] for f in (out / "labels").glob("*.json")}
    n_have = len(existing)
    imported = skipped = missing = 0
    for entry in load_entries(Path(args.labels)):
        src_name = entry["image"]
        if src_name in existing:
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
            "faces": entry["faces"],
        }
        (out / "labels" / (stem + ".json")).write_text(json.dumps(label, indent=1))
        imported += 1
    print(f"imported {imported}, skipped {skipped} (already present or empty), {missing} missing images -> {out}")


if __name__ == "__main__":
    main()
