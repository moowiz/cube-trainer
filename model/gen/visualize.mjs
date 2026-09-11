#!/usr/bin/env node
// visualize.mjs — draw synthetic-dataset face labels back onto their source
// images so a human can eyeball whether the generator's corners/visibility
// are correct.
//
// Usage:
//   node visualize.mjs --data <dataRoot> [--count N] [--out <dir>]
//
// <dataRoot> must contain `images/*.png` and `labels/*.json` (one label per
// image, same basename). N labels are picked evenly across the sorted label
// list (not just the first N) so a spot-check covers the whole dataset.
//
// Corner-order / dot-size convention drawn on each face quad (this is the
// thing M3 needs to verify at a glance):
//   corner 0 (top-left)     -> large dot, radius 6, face color, black ring
//   corner 1 (top-right)    -> medium dot, radius 4
//   corner 2 (bottom-right) -> small dot, radius 2
//   corner 3 (bottom-left)  -> small dot, radius 2
// Edges are drawn corner0->1->2->3->0. Visible faces are drawn with thick
// (3px), full-brightness edges; non-visible faces with thin (1px) edges at
// 35% brightness, so a face wrongly marked visible/non-visible stands out.
// Dots are drawn after edges (on top). Visible faces are drawn after (on
// top of) non-visible ones.

import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';

// ---- face legend -----------------------------------------------------

const FACE_COLORS = {
  U: [255, 255, 255],
  R: [220, 40, 40],
  F: [40, 190, 80],
  D: [235, 220, 50],
  L: [255, 140, 0],
  B: [50, 90, 230],
};

const FACE_ORDER = ['U', 'R', 'F', 'D', 'L', 'B'];

// ---- tiny arg parser ---------------------------------------------------

function parseArgs(argv) {
  const out = { data: null, count: 12, out: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    let key = arg.slice(2);
    let val;
    const eq = key.indexOf('=');
    if (eq !== -1) {
      val = key.slice(eq + 1);
      key = key.slice(0, eq);
    } else {
      val = argv[i + 1];
      i++;
    }
    if (key === 'data') out.data = val;
    else if (key === 'count') out.count = Number(val);
    else if (key === 'out') out.out = val;
  }
  return out;
}

// ---- pixel-level drawing helpers ---------------------------------------

function inBounds(png, x, y) {
  return x >= 0 && x < png.width && y >= 0 && y < png.height;
}

function setPixel(png, x, y, [r, g, b]) {
  x = Math.round(x);
  y = Math.round(y);
  if (!inBounds(png, x, y)) return;
  const idx = (png.width * y + x) << 2;
  png.data[idx] = r;
  png.data[idx + 1] = g;
  png.data[idx + 2] = b;
  png.data[idx + 3] = 255;
}

// Filled disc, bounds-clipped.
function fillDot(png, cx, cy, color, radius) {
  const r = Math.max(0, Math.round(radius));
  const x0 = Math.floor(cx - r);
  const x1 = Math.ceil(cx + r);
  const y0 = Math.floor(cy - r);
  const y1 = Math.ceil(cy + r);
  const r2 = r * r;
  for (let y = y0; y <= y1; y++) {
    if (y < 0 || y >= png.height) continue;
    for (let x = x0; x <= x1; x++) {
      if (x < 0 || x >= png.width) continue;
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= r2) setPixel(png, x, y, color);
    }
  }
}

// A dot with a 1px black outline ring around it (outline first, fill on top).
function fillDotOutlined(png, cx, cy, color, radius) {
  fillDot(png, cx, cy, [0, 0, 0], radius + 1);
  fillDot(png, cx, cy, color, radius);
}

// Stamp a small filled square centered on (x, y) — used to give drawLine
// its stroke thickness.
function stampSquare(png, cx, cy, color, size) {
  const half = Math.floor(size / 2);
  const x0 = Math.round(cx) - half;
  const y0 = Math.round(cy) - half;
  for (let dy = 0; dy < size; dy++) {
    for (let dx = 0; dx < size; dx++) {
      setPixel(png, x0 + dx, y0 + dy, color);
    }
  }
}

// Clamp far-off label coordinates before stepping, so a corner projected
// wildly outside the frame (faces are projected even when facing away from
// the camera) can never blow up the loop bound below.
const COORD_CLAMP = 2000;
function clampCoord(v) {
  if (Number.isNaN(v)) return 0;
  return Math.max(-COORD_CLAMP, Math.min(COORD_CLAMP, v));
}

// DDA line, stamped with a square of side `thickness` at every step.
// Endpoints are clamped first, so `steps` is always bounded even when the
// raw label coordinates are absurdly large.
function drawLine(png, x0, y0, x1, y1, color, thickness) {
  x0 = clampCoord(x0);
  y0 = clampCoord(y0);
  x1 = clampCoord(x1);
  y1 = clampCoord(y1);

  const dx = x1 - x0;
  const dy = y1 - y0;
  const steps = Math.max(1, Math.round(Math.max(Math.abs(dx), Math.abs(dy))));
  const size = Math.max(1, Math.round(thickness));

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = x0 + dx * t;
    const y = y0 + dy * t;
    stampSquare(png, x, y, color, size);
  }
}

function dim(color, factor) {
  return color.map((c) => Math.round(c * factor));
}

// ---- face-quad overlay ---------------------------------------------------

function drawFaceQuad(png, corners, color, visible) {
  const thickness = visible ? 3 : 1;
  const strokeColor = visible ? color : dim(color, 0.35);

  for (let i = 0; i < 4; i++) {
    const [x0, y0] = corners[i];
    const [x1, y1] = corners[(i + 1) % 4];
    drawLine(png, x0, y0, x1, y1, strokeColor, thickness);
  }

  const [c0, c1, c2, c3] = corners;
  fillDotOutlined(png, c0[0], c0[1], color, 6);
  fillDot(png, c1[0], c1[1], color, 4);
  fillDot(png, c2[0], c2[1], color, 2);
  fillDot(png, c3[0], c3[1], color, 2);
}

function drawOverlay(png, label) {
  const entries = FACE_ORDER.map((key) => [key, label.faces[key]]).filter(
    ([, face]) => face && Array.isArray(face.corners)
  );

  // Non-visible faces first, then visible faces on top.
  for (const [key, face] of entries) {
    if (face.visible) continue;
    drawFaceQuad(png, face.corners, FACE_COLORS[key], false);
  }
  for (const [key, face] of entries) {
    if (!face.visible) continue;
    drawFaceQuad(png, face.corners, FACE_COLORS[key], true);
  }
}

// ---- evenly-spread selection --------------------------------------------

function pickIndices(length, count) {
  if (count <= 0 || length <= 0) return [];
  if (count >= length) return Array.from({ length }, (_, i) => i);
  if (count === 1) return [Math.floor((length - 1) / 2)];
  const idxs = [];
  for (let i = 0; i < count; i++) {
    idxs.push(Math.round((i * (length - 1)) / (count - 1)));
  }
  return [...new Set(idxs)];
}

// ---- main ----------------------------------------------------------------

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.data) {
    console.error('error: --data <dataRoot> is required');
    process.exitCode = 1;
    return;
  }

  const dataRoot = path.resolve(args.data);
  const labelsDir = path.join(dataRoot, 'labels');
  const outDir = args.out ? path.resolve(args.out) : path.join(dataRoot, 'viz');
  const count = Number.isFinite(args.count) && args.count > 0 ? Math.floor(args.count) : 12;

  if (!fs.existsSync(dataRoot) || !fs.statSync(dataRoot).isDirectory()) {
    console.error(`error: data root not found: ${dataRoot}`);
    process.exitCode = 1;
    return;
  }

  if (!fs.existsSync(labelsDir) || !fs.statSync(labelsDir).isDirectory()) {
    console.error(`error: labels dir not found: ${labelsDir}`);
    process.exitCode = 1;
    return;
  }

  const labelFiles = fs
    .readdirSync(labelsDir)
    .filter((f) => f.endsWith('.json'))
    .sort();

  if (labelFiles.length === 0) {
    console.error(`error: no label files found in ${labelsDir}`);
    process.exitCode = 1;
    return;
  }

  fs.mkdirSync(outDir, { recursive: true });

  const indices = pickIndices(labelFiles.length, count);
  let written = 0;

  for (const idx of indices) {
    const labelFile = labelFiles[idx];
    const labelPath = path.join(labelsDir, labelFile);

    let label;
    try {
      label = JSON.parse(fs.readFileSync(labelPath, 'utf8'));
    } catch (err) {
      console.error(`skipping ${labelFile}: failed to parse JSON (${err.message})`);
      continue;
    }

    if (!label.image || !label.faces) {
      console.error(`skipping ${labelFile}: missing "image" or "faces"`);
      continue;
    }

    const imagePath = path.join(dataRoot, label.image);
    if (!fs.existsSync(imagePath)) {
      console.error(`skipping ${labelFile}: image not found (${imagePath})`);
      continue;
    }

    let png;
    try {
      png = PNG.sync.read(fs.readFileSync(imagePath));
    } catch (err) {
      console.error(`skipping ${labelFile}: failed to read PNG (${err.message})`);
      continue;
    }

    drawOverlay(png, label);

    const basename = path.basename(labelFile, '.json');
    const outPath = path.join(outDir, `${basename}.png`);
    fs.writeFileSync(outPath, PNG.sync.write(png));
    console.log(`wrote ${outPath}`);
    written++;
  }

  console.log(`wrote ${written} overlays to ${outDir}`);
}

main();
