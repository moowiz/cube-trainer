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
//
// Twist labels (M13, `label.twist`) are drawn in magenta: a ring at the
// centre of the turning face, and on every visible neighbour an arrow inset
// from the edge that borders the turning layer, pointing the way that
// layer's row moved for the labelled sign (deg > 0: from corner k+1 toward
// corner k; the arrow's length is |deg| / 90 of the half edge). Check them
// against the picture: the outer row of stickers next to the arrow should
// be displaced the way the arrow points. The console line per image prints
// the twist too.

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

// Which face lies across edge k (corner k -> corner k+1) of each face in the
// label's corner order (TL, TR, BR, BL of the cubejs sticker layout). The
// same table lives in model/train/targets.py (NEIGHBOUR) and is checked
// against the cube geometry by check_twist.py.
const NEIGHBOUR = {
  U: ['B', 'R', 'F', 'L'], R: ['U', 'B', 'D', 'F'], F: ['U', 'R', 'D', 'L'],
  D: ['F', 'R', 'B', 'L'], L: ['U', 'F', 'D', 'B'], B: ['U', 'L', 'D', 'R'],
};
const TWIST_COLOR = [255, 0, 255];

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

function drawArrow(png, from, to, color, thickness) {
  drawLine(png, from[0], from[1], to[0], to[1], color, thickness);
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const h = Math.min(12, Math.max(4, len * 0.35));
  for (const sgn of [-1, 1]) {
    const bx = to[0] - h * (ux * Math.cos(0.5) - sgn * uy * Math.sin(0.5));
    const by = to[1] - h * (uy * Math.cos(0.5) + sgn * ux * Math.sin(0.5));
    drawLine(png, to[0], to[1], bx, by, color, thickness);
  }
}

function drawRing(png, cx, cy, radius, color, thickness) {
  const n = Math.max(24, Math.round(radius * 2));
  for (let i = 0; i < n; i++) {
    const a0 = (2 * Math.PI * i) / n;
    const a1 = (2 * Math.PI * (i + 1)) / n;
    drawLine(png, cx + radius * Math.cos(a0), cy + radius * Math.sin(a0),
      cx + radius * Math.cos(a1), cy + radius * Math.sin(a1), color, thickness);
  }
}

function quadCentre(c) {
  return [(c[0][0] + c[1][0] + c[2][0] + c[3][0]) / 4, (c[0][1] + c[1][1] + c[2][1] + c[3][1]) / 4];
}

function drawTwist(png, label) {
  const tw = label.twist;
  if (!tw || !tw.face) return;
  for (const f of FACE_ORDER) {
    const face = label.faces[f];
    if (!face || !face.visible || !Array.isArray(face.corners)) continue;
    const c = face.corners;
    const [cx, cy] = quadCentre(c);
    if (f === tw.face) {
      const edge = Math.hypot(c[1][0] - c[0][0], c[1][1] - c[0][1]);
      drawRing(png, cx, cy, edge * 0.12, TWIST_COLOR, 2);
      continue;
    }
    const k = NEIGHBOUR[f].indexOf(tw.face);
    if (k < 0) continue; // the opposite face: nothing moves
    const a = c[k];
    const b = c[(k + 1) % 4];
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    // inset 15% toward the face centre so the arrow sits on the moving row
    const from = [mid[0] + (cx - mid[0]) * 0.15, mid[1] + (cy - mid[1]) * 0.15];
    const toward = tw.deg > 0 ? a : b;
    const frac = Math.min(1, Math.abs(tw.deg) / 90);
    const to = [from[0] + (toward[0] - mid[0]) * frac, from[1] + (toward[1] - mid[1]) * frac];
    drawArrow(png, from, to, TWIST_COLOR, 2);
  }
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
  drawTwist(png, label);
}

function describe(label) {
  const vis = FACE_ORDER.filter((f) => label.faces[f] && label.faces[f].visible).join('');
  const tw = label.twist;
  const m = label.meta || {};
  const twist = tw && tw.face
    ? `twist ${tw.face} ${tw.deg > 0 ? '+' : ''}${tw.deg} deg ${tw.mode}${tw.blurDeg ? ` blur ${tw.blurDeg}` : ''}`
    : 'no twist';
  return `${twist}; visible ${vis || '-'}; hands ${m.hasHands ? (m.handFocus ? `on the layer (${m.handFocus})` : 'yes') : 'no'}`;
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
    console.log(`wrote ${outPath}: ${describe(label)}`);
    written++;
  }

  console.log(`wrote ${written} overlays to ${outDir}`);
}

main();
