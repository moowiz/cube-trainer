// Browser-side synthetic scene (M3). Runs inside headless Chrome, driven by
// generate.mjs over page.evaluate. Renders a stickered or stickerless 3x3 cube
// with a real random scramble (cubies are rigid bodies rotated in 90° face
// turns, so sticker geometry is always physically consistent; one layer may
// be left slightly misaligned), random camera pose, random warm/cool lighting
// with occasional glare, hands (palm + forearm + fat fingers) and clutter,
// and random backgrounds including procedural grids/tiles as hard negatives.
//
// window.renderSample(opts) -> { dataUrl, label }
//   opts: { seed, style: 'stickered'|'stickerless', width, height, photoUrls }
//
// Label corner order per face is [top-left, top-right, bottom-right,
// bottom-left] in that face's cubejs sticker-layout orientation (the corner
// touching sticker 1, 3, 9, 7 respectively). Faces are always reported; the
// `visible` flag marks faces actually presented to the camera.
import * as THREE from 'three';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { proceduralBackground, pick } from '/backgrounds.mjs';

const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = window.DEBUG_SHADOW_TYPE ?? THREE.PCFSoftShadowMap;
// DECISION: ACES filmic tone mapping - linear output clips highlights to
// flat white and oversaturates primaries, the biggest "obviously rendered"
// tell next to sterile lighting. Exposure is randomized per sample.
renderer.toneMapping = THREE.ACESFilmicToneMapping;

// HDRI environments (model/backgrounds/hdri/*.hdr, served by generate.mjs):
// image-based lighting gives real-world color gradients and reflections that
// point lights can't. PMREM'd once per file, cached for the whole run.
const pmrem = new THREE.PMREMGenerator(renderer);
const rgbeLoader = new RGBELoader();
const hdriCache = new Map();
async function hdriEnv(url) {
  if (!hdriCache.has(url)) {
    const tex = await rgbeLoader.loadAsync(url);
    tex.mapping = THREE.EquirectangularReflectionMapping;
    hdriCache.set(url, { env: pmrem.fromEquirectangular(tex).texture, bg: tex });
  }
  return hdriCache.get(url);
}

const SPACING = 1;          // cubie grid pitch
const CUBIE = 0.96;         // cubie edge length
const H = SPACING + CUBIE / 2; // outer half-size of the whole cube (1.48)

// DECISION: corner tables match cubejs facelet orientation (verified against
// the right = forward x up screen convention for each face's outside view).
const FACE_DATA = {
  U: { n: [0, 1, 0], corners: [[-1, 1, -1], [1, 1, -1], [1, 1, 1], [-1, 1, 1]] },
  R: { n: [1, 0, 0], corners: [[1, 1, 1], [1, 1, -1], [1, -1, -1], [1, -1, 1]] },
  F: { n: [0, 0, 1], corners: [[-1, 1, 1], [1, 1, 1], [1, -1, 1], [-1, -1, 1]] },
  D: { n: [0, -1, 0], corners: [[-1, -1, 1], [1, -1, 1], [1, -1, -1], [-1, -1, -1]] },
  L: { n: [-1, 0, 0], corners: [[-1, 1, -1], [-1, 1, 1], [-1, -1, 1], [-1, -1, -1]] },
  B: { n: [0, 0, -1], corners: [[1, 1, -1], [-1, 1, -1], [-1, -1, -1], [1, -1, -1]] },
};
// BoxGeometry material index order: +x -x +y -y +z -z
const DIRS = [
  { face: 'R', axis: 'x', sign: 1 }, { face: 'L', axis: 'x', sign: -1 },
  { face: 'U', axis: 'y', sign: 1 }, { face: 'D', axis: 'y', sign: -1 },
  { face: 'F', axis: 'z', sign: 1 }, { face: 'B', axis: 'z', sign: -1 },
];
const SCHEME = { U: 0xffffff, R: 0xc41e3a, F: 0x009e60, D: 0xffd500, L: 0xff5800, B: 0x0051ba };

// DECISION: 8 base skin tones spanning light-to-dark (M4 hands feature), each
// jittered per scene so the model never sees the same 8 exact colors twice.
const SKIN_TONES = [0xffdbac, 0xf1c27d, 0xe0ac69, 0xc68642, 0xa9784f, 0x8d5524, 0x6f4423, 0x3c2414];

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function kelvinToColor(k) {
  k /= 100;
  let r, g, b;
  if (k <= 66) { r = 255; g = 99.47 * Math.log(k) - 161.12; } else { r = 329.7 * Math.pow(k - 60, -0.1332); g = 288.12 * Math.pow(k - 60, -0.0755); }
  if (k >= 66) b = 255; else if (k <= 19) b = 0; else b = 138.52 * Math.log(k - 10) - 305.04;
  const c = (x) => Math.min(255, Math.max(0, x)) / 255;
  return new THREE.Color(c(r), c(g), c(b));
}

function faceColors(rnd) {
  // Per-image jitter: sticker pigments vary between cubes, and we never want
  // the model keying on one exact RGB.
  const out = {};
  for (const [f, hex] of Object.entries(SCHEME)) {
    const c = new THREE.Color(hex);
    c.offsetHSL((rnd() - 0.5) * 0.04, (rnd() - 0.5) * 0.2, (rnd() - 0.5) * 0.1);
    out[f] = c;
  }
  return out;
}

// Sticker/tile as a rounded-rect extrusion: radius 0 = classic vinyl sticker,
// big radius + depth = the molded plastic tiles of modern cubes (GAN GES
// style), whose fat rounded gaps look nothing like thin straight seam lines.
// DECISION: real-cube seam morphology varies a lot (thin black lines, wide
// rounded crosses, white-body light seams, stickerless shadow-only seams);
// randomizing it here is the fix for the model overfitting any one seam look.
// `radius` is either one number or four, one per tile corner in the order
// [+x+y, -x+y, -x-y, +x-y] of the tile's local frame (before orient()).
function tileGeo(size, radius, depth) {
  const h = size / 2;
  const rr = (Array.isArray(radius) ? radius : [radius, radius, radius, radius])
    .map((r) => Math.min(Math.max(r, 0.0001), h * 0.49));
  const s = new THREE.Shape();
  s.absarc(h - rr[0], h - rr[0], rr[0], 0, Math.PI / 2);
  s.absarc(rr[1] - h, h - rr[1], rr[1], Math.PI / 2, Math.PI);
  s.absarc(rr[2] - h, rr[2] - h, rr[2], Math.PI, Math.PI * 1.5);
  s.absarc(h - rr[3], rr[3] - h, rr[3], Math.PI * 1.5, Math.PI * 2);
  s.closePath();
  return new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: false, curveSegments: 7 });
}

// Rotation that orient() applies to a tile for face direction `d` (tile is
// built in its local XY plane, extruded along +z). Used to work out which of
// a tile's local corners point toward the face center (GAN tile profile).
function faceQuat(d) {
  const o = new THREE.Object3D();
  if (d.axis === 'x') o.rotateY((Math.PI / 2) * d.sign);
  else if (d.axis === 'y') o.rotateX((-Math.PI / 2) * d.sign);
  else if (d.sign < 0) o.rotateY(Math.PI);
  return o.quaternion;
}
const TILE_CORNER_SIGNS = [[1, 1], [-1, 1], [-1, -1], [1, -1]];
// DECISION: the center logo is a drawn mark on a transparent canvas, not a
// colored smudge. Almost every real cube carries a brand mark on the white
// center and the model demonstrably struggled with the white face: a dense
// high-contrast mark inside an otherwise featureless white tile is exactly
// the "sticker with a pattern" texture it needs to have seen. The mark is
// drawn from a wide family modelled on real brands - bold monograms (YJ,
// QiYi's QY, MF), wordmarks (MoYu, Rubik's, DaYan, ShengShou's oval badge),
// isometric cube glyphs (GAN), pictograms (Cyclone Boys' cyclone, Thunderclap
// bolt, X-Man), CJK characters, ringed badges, stripes/dot grids and QR-ish
// blocks - plus inverted (filled badge, cut-out glyph) and two-tone variants.
// Family, color, weight, size and rotation are all randomized so the model
// never learns one logo; the point is "a pattern lives here", not a brand.
function logoTexture(rnd) {
  const S = 128;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, S, S);
  // brand colors skew blue/black/red like real logos, with a random tail
  const brandColor = () => {
    const hueRoll = rnd();
    const hue = hueRoll < 0.35 ? 0.55 + rnd() * 0.12 : hueRoll < 0.55 ? 0.97 + rnd() * 0.06 : rnd();
    if (rnd() < 0.25) return `hsl(0,0%,${Math.round(rnd() * 22)}%)`;
    return `hsl(${Math.round((hue % 1) * 360)},${65 + Math.round(rnd() * 35)}%,${28 + Math.round(rnd() * 24)}%)`;
  };
  const twoTone = rnd() < 0.3;
  const colA = brandColor();
  const colB = twoTone ? brandColor() : colA;
  const fonts = ['sans-serif', 'serif', 'monospace', 'Arial Black, sans-serif', 'Impact, sans-serif', 'Verdana, sans-serif', 'Georgia, serif', 'cursive'];
  const randWord = (n, mixedCase) => {
    let s = '';
    for (let i = 0; i < n; i++) s += String.fromCharCode(65 + Math.floor(rnd() * 26));
    return mixedCase ? s[0] + s.slice(1).toLowerCase() : s;
  };
  const text = (txt, px, maxW, color) => {
    ctx.fillStyle = color;
    ctx.font = `${rnd() < 0.7 ? 'bold' : 'normal'} ${rnd() < 0.2 ? 'italic ' : ''}${px}px ${pick(rnd, fonts)}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(txt, 0, 0, maxW);
  };
  const polyline = (pts, close, stroke, width) => {
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    if (close) ctx.closePath();
    if (stroke) { ctx.lineWidth = width; ctx.lineJoin = 'round'; ctx.stroke(); } else ctx.fill();
  };
  const star = (n, rOut, rIn) => {
    const pts = [];
    for (let i = 0; i < n * 2; i++) {
      const a = (i * Math.PI) / n - Math.PI / 2;
      const r = i % 2 ? rIn : rOut;
      pts.push([Math.cos(a) * r, Math.sin(a) * r]);
    }
    return pts;
  };

  ctx.translate(S / 2, S / 2);
  ctx.rotate(rnd() * Math.PI * 2);
  // inverted badge: a filled disc/rounded square, glyph cut out of it
  const inverted = rnd() < 0.22;
  if (inverted) {
    ctx.fillStyle = colA;
    const r = S * (0.36 + rnd() * 0.1);
    ctx.beginPath();
    if (rnd() < 0.5) ctx.arc(0, 0, r, 0, Math.PI * 2);
    else ctx.roundRect(-r, -r * (0.6 + rnd() * 0.4), 2 * r, 2 * r * (0.6 + rnd() * 0.4), r * 0.3);
    ctx.fill();
    ctx.globalCompositeOperation = 'destination-out';
  }
  const scale = 0.55 + rnd() * 0.35;
  const kind = pick(rnd, [
    'monogram', 'monogram', 'monogram', 'wordmark', 'wordmark', 'wordmark', 'badge', 'badge',
    'cubeGlyph', 'pictogram', 'pictogram', 'cjk', 'cjk', 'stripes', 'dots', 'qr', 'blob', 'arrows',
  ]);
  ctx.fillStyle = colA;
  ctx.strokeStyle = colA;
  if (kind === 'monogram') {
    const n = 1 + Math.floor(rnd() * 3);
    const px = S * (0.5 + rnd() * 0.4) * scale * (n === 1 ? 1.3 : 1);
    if (twoTone && n > 1) {
      // letters in two colors, e.g. a blue Q next to a red Y
      const w = randWord(n);
      ctx.font = `bold ${px}px ${pick(rnd, fonts)}`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      const total = ctx.measureText(w).width;
      let x = -total / 2;
      for (let i = 0; i < n; i++) {
        ctx.fillStyle = i % 2 ? colB : colA;
        ctx.fillText(w[i], x, 0);
        x += ctx.measureText(w[i]).width;
      }
    } else text(randWord(n), px, S * 0.92, colA);
  } else if (kind === 'wordmark') {
    const n = 4 + Math.floor(rnd() * 5);
    const px = S * (0.24 + rnd() * 0.12);
    const word = randWord(n, rnd() < 0.5);
    if (rnd() < 0.5) {
      // two-line: word + smaller tagline or icon above
      text(word, px, S * 0.9, colA);
      ctx.save();
      ctx.translate(0, -px * 0.9);
      if (rnd() < 0.5) text(randWord(3 + Math.floor(rnd() * 5), true), px * 0.5, S * 0.7, colB);
      else { ctx.fillStyle = colB; polyline(star(5, px * 0.45, px * 0.2), true, false); }
      ctx.restore();
    } else text(word, px, S * 0.92, colA);
    if (rnd() < 0.4) { // underline / accent bar
      ctx.fillStyle = colB;
      ctx.fillRect(-S * 0.35, px * 0.55, S * 0.7, S * 0.03 + rnd() * S * 0.03);
    }
  } else if (kind === 'badge') {
    // ring or oval outline with a short word inside (ShengShou / Rubik's style)
    const r = S * 0.38 * (0.85 + rnd() * 0.2);
    const oval = rnd() < 0.5;
    ctx.lineWidth = S * (0.035 + rnd() * 0.05);
    ctx.beginPath();
    if (oval) ctx.ellipse(0, 0, r, r * (0.55 + rnd() * 0.25), 0, 0, Math.PI * 2);
    else ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.stroke();
    if (rnd() < 0.8) text(randWord(2 + Math.floor(rnd() * 5), rnd() < 0.4), r * (oval ? 0.5 : 0.55), r * 1.6, colB);
    else { ctx.fillStyle = colB; ctx.beginPath(); ctx.arc(0, 0, r * (0.25 + rnd() * 0.25), 0, Math.PI * 2); ctx.fill(); }
  } else if (kind === 'cubeGlyph') {
    // isometric cube outline built from a hexagon + Y
    const r = S * 0.34 * scale;
    ctx.lineWidth = S * (0.07 + rnd() * 0.06);
    const hex = [];
    for (let i = 0; i < 6; i++) { const a = Math.PI / 6 + (i * Math.PI) / 3; hex.push([Math.cos(a) * r, Math.sin(a) * r]); }
    polyline(hex, true, true, ctx.lineWidth);
    ctx.strokeStyle = colB;
    for (let i = 0; i < 3; i++) {
      const a = Math.PI / 6 + (i * 2 * Math.PI) / 3;
      polyline([[0, 0], [Math.cos(a) * r, Math.sin(a) * r]], false, true, ctx.lineWidth);
    }
    if (rnd() < 0.5) { ctx.fillStyle = colB; ctx.beginPath(); ctx.arc(0, 0, r * (0.15 + rnd() * 0.15), 0, Math.PI * 2); ctx.fill(); }
  } else if (kind === 'pictogram') {
    const r = S * 0.36 * scale;
    const p = pick(rnd, ['star', 'bolt', 'heart', 'cyclone', 'shield', 'diamond', 'x']);
    if (p === 'star') polyline(star(4 + Math.floor(rnd() * 4), r, r * (0.4 + rnd() * 0.2)), true, false);
    else if (p === 'bolt') polyline([[-r * 0.2, -r], [r * 0.35, -r * 0.1], [r * 0.05, -r * 0.1], [r * 0.25, r], [-r * 0.4, r * 0.05], [-r * 0.1, r * 0.05]], true, false);
    else if (p === 'heart') {
      ctx.beginPath();
      ctx.moveTo(0, r * 0.9);
      ctx.bezierCurveTo(-r * 1.4, -r * 0.1, -r * 0.5, -r * 1.1, 0, -r * 0.35);
      ctx.bezierCurveTo(r * 0.5, -r * 1.1, r * 1.4, -r * 0.1, 0, r * 0.9);
      ctx.fill();
    } else if (p === 'cyclone') {
      ctx.lineWidth = S * (0.05 + rnd() * 0.05);
      ctx.lineCap = 'round';
      ctx.beginPath();
      for (let i = 0; i < 80; i++) { const a = i * 0.16, rr = r * (i / 80); ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr); }
      ctx.stroke();
    } else if (p === 'shield') {
      polyline([[-r, -r * 0.8], [r, -r * 0.8], [r, r * 0.1], [0, r], [-r, r * 0.1]], true, false);
      ctx.fillStyle = colB;
      ctx.globalCompositeOperation = inverted ? 'source-over' : 'destination-out';
      polyline([[-r * 0.5, -r * 0.4], [r * 0.5, -r * 0.4], [r * 0.5, 0], [0, r * 0.45], [-r * 0.5, 0]], true, false);
    } else if (p === 'diamond') polyline([[0, -r], [r * 0.7, 0], [0, r], [-r * 0.7, 0]], true, false);
    else { ctx.lineWidth = S * (0.08 + rnd() * 0.08); ctx.lineCap = 'round'; polyline([[-r, -r], [r, r]], false, true, ctx.lineWidth); ctx.strokeStyle = colB; polyline([[r, -r], [-r, r]], false, true, ctx.lineWidth); }
  } else if (kind === 'cjk') {
    // 1-3 CJK characters (many cubes are Chinese brands); falls back to
    // tofu boxes where no CJK font is installed, which is still a pattern
    const n = 1 + Math.floor(rnd() * 3);
    let s = '';
    for (let i = 0; i < n; i++) s += String.fromCharCode(0x4e00 + Math.floor(rnd() * 0x51a5));
    text(s, S * (0.5 + rnd() * 0.3) * scale * (n === 1 ? 1.3 : 0.9), S * 0.92, colA);
  } else if (kind === 'stripes') {
    const n = 2 + Math.floor(rnd() * 4);
    const w = S * 0.7 * scale, h = w / (n * 2 - 1);
    for (let i = 0; i < n; i++) { ctx.fillStyle = i % 2 ? colB : colA; ctx.fillRect(-w / 2, -w / 2 + i * 2 * h, w * (0.6 + rnd() * 0.4), h); }
  } else if (kind === 'dots') {
    const n = 2 + Math.floor(rnd() * 3);
    const w = S * 0.7 * scale, step = w / n;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      if (rnd() < 0.2) continue;
      ctx.fillStyle = (i + j) % 2 ? colB : colA;
      ctx.beginPath(); ctx.arc(-w / 2 + (i + 0.5) * step, -w / 2 + (j + 0.5) * step, step * (0.25 + rnd() * 0.15), 0, Math.PI * 2); ctx.fill();
    }
  } else if (kind === 'qr') {
    const n = 5 + Math.floor(rnd() * 4);
    const w = S * 0.66 * scale, cell = w / n;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (rnd() < 0.5) ctx.fillRect(-w / 2 + i * cell, -w / 2 + j * cell, cell + 0.5, cell + 0.5);
  } else if (kind === 'arrows') {
    const r = S * 0.34 * scale;
    ctx.lineWidth = S * (0.06 + rnd() * 0.05);
    ctx.lineCap = 'round';
    const n = 2 + Math.floor(rnd() * 3);
    for (let i = 0; i < n; i++) {
      ctx.strokeStyle = i % 2 ? colB : colA;
      ctx.beginPath();
      ctx.arc(0, 0, r, (i * 2 * Math.PI) / n, ((i + 0.75) * 2 * Math.PI) / n);
      ctx.stroke();
      const a = ((i + 0.75) * 2 * Math.PI) / n;
      ctx.fillStyle = ctx.strokeStyle;
      polyline([[Math.cos(a) * r * 1.3, Math.sin(a) * r * 1.3], [Math.cos(a) * r * 0.7, Math.sin(a) * r * 0.7], [Math.cos(a + 0.35) * r, Math.sin(a + 0.35) * r]], true, false);
    }
  } else {
    // irregular filled polygon - the "some shape" fallback
    const n = 3 + Math.floor(rnd() * 5);
    const r = S * 0.32 * scale;
    const pts = [];
    for (let i = 0; i < n; i++) { const a = (i * 2 * Math.PI) / n, rr = r * (0.6 + rnd() * 0.4); pts.push([Math.cos(a) * rr, Math.sin(a) * rr]); }
    polyline(pts, true, false);
  }
  ctx.globalCompositeOperation = 'source-over';
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

// Sorted (desc) camera-facing values for all 6 faces, for a trial camera
// position. Mirrors the per-face `facing` formula in the label block below
// exactly (same normal/center math) so CORNER_BIAS rejection sampling targets
// the same quantity the label reports - it does not replace or shortcut that
// per-face computation, which still runs unconditionally at label time.
function faceFacings(camPos) {
  const out = [];
  for (const fd of Object.values(FACE_DATA)) {
    const n = new THREE.Vector3(...fd.n);
    const center = n.clone().multiplyScalar(H);
    out.push(n.dot(camPos.clone().sub(center).normalize()));
  }
  return out.sort((a, b) => b - a);
}

// A capsule mesh spanning two world-space points (long axis along a-b).
// `length` passed to CapsuleGeometry is just the straight cylindrical section
// - total tip-to-tip extent is length + 2*radius - so we subtract that back
// out from the requested span.
function capsuleBetween(a, b, radius, material) {
  const delta = new THREE.Vector3().subVectors(b, a);
  const span = Math.max(delta.length(), radius * 2.01);
  const cylLen = Math.max(0.001, span - 2 * radius);
  const geo = new THREE.CapsuleGeometry(radius, cylLen, 6, 16);
  const mesh = new THREE.Mesh(geo, material);
  mesh.position.addVectors(a, b).multiplyScalar(0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.normalize());
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

// DECISION: fingers are placed in camera-space (base/tip offsets along the
// camera's own right/up/forward axes) rather than in cube-local space, so
// occlusion is guaranteed to land in the visible frame regardless of which
// way the cube happens to be facing - a world-space grip would often end up
// entirely behind the cube from the camera's point of view. Depth is always
// nearer to the camera than the cube center (fdist < dist), so fingers always
// z-composite in front of the cube.
const EDGE_BASIS = {
  bottom: (r, u) => ({ out: u.clone().negate(), along: r }),
  top: (r, u) => ({ out: u, along: r }),
  left: (r, u) => ({ out: r.clone().negate(), along: u }),
  right: (r, u) => ({ out: r, along: u }),
};

// Scale reference, measured on the real phone photos (batch4-6): a finger is
// ~1/3 of the cube's width (~18 mm vs a 56 mm cube), the thumb closer to
// 0.4, and the cube sits in a palm ~1.5 cube-widths across with the forearm
// running out of frame. The first version rendered fingers at ~1/10 of the
// cube width with no hand behind them - stick-thin rods, nothing like the
// big skin mass every real usage photo has around the cube.
function buildHands(rnd, camPos, camRight, camUp, camFwd, dist) {
  const group = new THREE.Group();
  const baseHex = pick(rnd, SKIN_TONES);
  const skin = new THREE.Color(baseHex);
  // DECISION: matte skin - high roughness, zero metalness/clearcoat, so
  // fingers never pick up the specular glare tuned for plastic stickers.
  const material = new THREE.MeshStandardMaterial({ roughness: 0.75 + rnd() * 0.2, metalness: 0 });
  const skinMat = () => {
    const m = material.clone();
    m.color = skin.clone().offsetHSL((rnd() - 0.5) * 0.02, (rnd() - 0.5) * 0.08, (rnd() - 0.5) * 0.08);
    return m;
  };
  const at = (fdist, out, outAmt, along, alongAmt) => camPos.clone()
    .add(camFwd.clone().multiplyScalar(fdist))
    .add(out.clone().multiplyScalar(outAmt))
    .add(along.clone().multiplyScalar(alongAmt));

  // DECISION: 40% "wrap" grips straddling two adjacent screen edges (a real
  // hand curling around a corner/edge), 60% single-edge entry. Bottom entry
  // (holding the cube up to show a face) is weighted heaviest.
  const wrap = rnd() < 0.4;
  const edgePairs = [['bottom', 'left'], ['bottom', 'right'], ['top', 'left'], ['top', 'right']];
  const edges = wrap ? pick(rnd, edgePairs) : [pick(rnd, ['bottom', 'bottom', 'bottom', 'left', 'right', 'top'])];
  const bases = edges.map((e) => EDGE_BASIS[e](camRight, camUp));

  // --- palm + forearm ---
  // DECISION: palm is a flattened ellipsoid sitting just BEHIND the cube's
  // center depth, offset toward the entry edge(s), so the cube hides it
  // where they overlap and the skin mass shows around the cube's silhouette
  // (cube-on-skin is the most common boundary in real frames). Forearm is a
  // fat capsule from the palm off toward the frame edge.
  const hasPalm = rnd() < 0.85;
  // direction from cube toward the hand: the entry edge, or the diagonal for wraps
  const handDir = bases.reduce((v, b) => v.add(b.out), new THREE.Vector3()).normalize();
  const handAlong = bases[0].along.clone();
  if (hasPalm) {
    const palmMat = skinMat();
    const pOut = H * (1.15 + rnd() * 0.45);
    const pAlong = (rnd() - 0.5) * H * 0.8;
    const pDepth = dist + H * (0.3 + rnd() * 0.4);
    const palm = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), palmMat);
    palm.position.copy(at(pDepth, handDir, pOut, handAlong, pAlong));
    const basis = new THREE.Matrix4().makeBasis(handDir, handAlong, camFwd);
    palm.quaternion.setFromRotationMatrix(basis);
    palm.scale.set(H * (0.9 + rnd() * 0.4), H * (1.1 + rnd() * 0.5), H * (0.4 + rnd() * 0.15));
    palm.castShadow = true;
    palm.receiveShadow = true;
    group.add(palm);

    const armMat = skinMat();
    const a0 = palm.position.clone().add(handDir.clone().multiplyScalar(H * 0.5));
    const a1 = at(pDepth + H * (rnd() * 1.5 - 0.3), handDir, pOut + H * 5, handAlong, pAlong + (rnd() - 0.5) * H * 3);
    group.add(capsuleBetween(a0, a1, H * (0.55 + rnd() * 0.25), armMat));
  }

  // --- fingers ---
  // Rooted at the palm rim, running toward the camera and inward over the
  // near edge of the cube; tips land on the outer row of stickers, sometimes
  // reaching the center. Evenly spaced along the edge with jitter (random
  // placement stacked fat fingers on top of each other).
  const nFingers = 2 + Math.floor(rnd() * 3); // 2-4
  const perEdge = edges.map(() => 0);
  const slot = edges.map(() => 0);
  for (let i = 0; i < nFingers; i++) perEdge[i % edges.length]++;
  const thumbIdx = rnd() < 0.6 ? Math.floor(rnd() * nFingers) : -1;
  for (let i = 0; i < nFingers; i++) {
    const e = i % edges.length;
    const { out, along } = bases[e];
    const mat = skinMat();
    const n = perEdge[e];
    const k = slot[e]++;
    const alongBase = -H * 0.85 + ((k + 0.5) * (H * 1.7)) / n + (rnd() - 0.5) * H * 0.25;
    const alongTip = alongBase + (rnd() - 0.5) * H * 0.35; // slight lateral drift = non-parallel fingers
    // DECISION: a finger is three points in camera space - root beside the
    // cube at the cube's depth, knuckle at the cube's near edge, tip lying on
    // the near face - so it wraps the edge the way a gripping finger does.
    // Real fingers (~75 mm) are longer than the cube (~56 mm): tips reach
    // the middle row and sometimes past it. Two earlier attempts rendered as
    // clusters of balls: capsules that were shorter than ~2 diameters, with
    // the bend in the middle of the face instead of at the edge.
    const thumb = i === thumbIdx;
    const r1 = H * (0.24 + rnd() * 0.12) * (thumb ? 1.25 : 1);
    const r2 = r1 * (0.82 + rnd() * 0.12);
    const root = at(dist - H * (rnd() * 0.4 - 0.1), out, H * (1.2 + rnd() * 0.35), along, alongBase);
    const knuckle = at(dist - H * (1.0 + rnd() * 0.25), out, H * (0.95 + rnd() * 0.2), along, alongBase + (rnd() - 0.5) * H * 0.1);
    const tip = at(dist - H * (1.0 + rnd() * 0.3) - r2 * 0.6, out, H * (-0.3 + rnd() * 0.85), along, alongTip);
    group.add(capsuleBetween(root, knuckle, r1, mat));
    group.add(capsuleBetween(knuckle, tip, r2, mat));
  }
  group.userData.hasPalm = hasPalm;
  group.userData.nFingers = nFingers;
  return group;
}

// DECISION: 1-3 simple foreground primitives, placed with the same
// camera-space depth trick as fingers so roughly half of them z-composite in
// front of the cube (partial occlusion) and half sit beside/behind it
// (visible clutter, no occlusion) - matches how random junk near a phone
// camera actually behaves.
function buildClutter(rnd, camPos, camRight, camUp, camFwd, dist) {
  const group = new THREE.Group();
  const n = 1 + Math.floor(rnd() * 3); // 1-3
  for (let i = 0; i < n; i++) {
    const size = H * (0.2 + rnd() * 0.5);
    const mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color().setHSL(rnd(), 0.3 + rnd() * 0.6, 0.25 + rnd() * 0.5),
      roughness: rnd(),
    });
    const kind = pick(rnd, ['box', 'cylinder', 'sphere']);
    let geo;
    if (kind === 'box') geo = new THREE.BoxGeometry(size, size * (0.6 + rnd() * 0.8), size * (0.6 + rnd() * 0.8));
    else if (kind === 'cylinder') geo = new THREE.CylinderGeometry(size * 0.4, size * 0.4, size * (1 + rnd()), 12);
    else geo = new THREE.SphereGeometry(size * 0.5, 12, 10);
    const mesh = new THREE.Mesh(geo, mat);

    const theta = rnd() * Math.PI * 2;
    const dirOffset = camRight.clone().multiplyScalar(Math.cos(theta)).add(camUp.clone().multiplyScalar(Math.sin(theta)));
    const radial = H * (0.8 + rnd() * 1.3);
    const fdist = dist - H * (rnd() * 1.6 - 0.5); // ranges well-in-front to slightly-behind
    mesh.position.copy(camPos).add(camFwd.clone().multiplyScalar(fdist)).add(dirOffset.multiplyScalar(radial));
    mesh.rotation.set(rnd() * Math.PI, rnd() * Math.PI, rnd() * Math.PI);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  return group;
}

function circleGeo(rad, depth) {
  const s = new THREE.Shape();
  s.absarc(0, 0, rad, 0, Math.PI * 2);
  s.closePath();
  return new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: false, curveSegments: 14 });
}

function buildCube(rnd, style) {
  const group = new THREE.Group();
  const colors = faceColors(rnd);
  const rough = 0.15 + rnd() * 0.5; // low roughness -> specular glare
  // Rounded cubies like real cubes. RoundedBoxGeometry subclasses
  // BoxGeometry, so the 6 material groups (+x -x +y -y +z -z) survive and
  // stickerless per-face coloring splits along the bevel like molded plastic.
  const bevel = CUBIE * (0.045 + rnd() * 0.045);
  const boxGeo = new RoundedBoxGeometry(CUBIE, CUBIE, CUBIE, 3, bevel);
  const stickerSize = (CUBIE - 2 * bevel) * (0.82 + rnd() * 0.15);
  // tile corner radius (fraction of tile size): sharp / medium / GAN-fat
  const radRoll = rnd();
  const tileRadius = radRoll < 0.3 ? rnd() * 0.08 : radRoll < 0.7 ? 0.08 + rnd() * 0.17 : 0.25 + rnd() * 0.23;
  const tileDepth = CUBIE * (0.006 + rnd() * 0.035);
  const stickerGeo = tileGeo(stickerSize, stickerSize * tileRadius, tileDepth);
  // DECISION: GAN-style tile profile in 35% of stickered cubes. Measured on
  // the real GAN 356 photos: on edge and corner tiles the corners that face
  // the center circle are heavily rounded (~0.4 of the tile) while the
  // corners on the face perimeter stay nearly square, giving the "D"-shaped
  // edge tiles and teardrop corner tiles. Which local corner is inner
  // depends on the cubie's position and the tile's orientation, so those
  // geometries are built per tile below.
  const ganProfile = style === 'stickered' && rnd() < 0.35;
  const ganInnerR = stickerSize * (0.32 + rnd() * 0.14);
  const ganOuterR = stickerSize * (0.02 + rnd() * 0.06);
  // circular center caps (GAN RS look); logo cap hides one center's color
  const circleCaps = ganProfile || rnd() < 0.3;
  const centerGeo = circleCaps ? circleGeo(stickerSize * 0.5, tileDepth) : stickerGeo;
  // DECISION: a brand mark on the white (U) center in ~80% of cubes (real
  // cubes almost all have one, and the white face was a measured weak spot);
  // occasionally on a random other face instead, 15% no logo at all.
  const logoRoll = rnd();
  const logoFace = logoRoll < 0.8 ? 'U' : logoRoll < 0.85 ? pick(rnd, Object.keys(SCHEME)) : null;
  // logo on a white cap (GAN style) vs printed straight on the face's own tile
  const logoOnCap = rnd() < 0.7;
  const logoTex = logoFace ? logoTexture(rnd) : null;
  // body color: black classic, white/light (light seams!), or oddball
  const bodyRoll = rnd();
  const bodyHex = bodyRoll < 0.68 ? 0x0a0a0a : bodyRoll < 0.85 ? 0xefefef : pick(rnd, [0xd5d5d5, 0x22224a, 0x4a1515]);
  const plastic = new THREE.MeshStandardMaterial({ color: bodyHex, roughness: 0.35 + rnd() * 0.3 });
  const interior = new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.6 });
  // glossy cubes get a clearcoat layer (the lacquered look of a new cube);
  // otherwise plain plastic reads matte/frosted
  const coat = rnd() < 0.5 ? 0.3 + rnd() * 0.7 : 0;
  const coatRough = 0.05 + rnd() * 0.3;
  const faceMats = {};
  for (const f of Object.keys(SCHEME)) {
    faceMats[f] = new THREE.MeshPhysicalMaterial({
      color: colors[f], roughness: rough, metalness: 0,
      clearcoat: coat, clearcoatRoughness: coatRough,
    });
  }
  const capMat = new THREE.MeshPhysicalMaterial({
    color: 0xf5f5f5, roughness: rough, metalness: 0, clearcoat: coat, clearcoatRoughness: coatRough,
  });
  const logoMat = logoTex ? new THREE.MeshStandardMaterial({
    map: logoTex, transparent: true, alphaTest: 0.2, roughness: 0.6, metalness: 0,
  }) : null;

  // per-tile geometry for the GAN profile: big radius on the tile corners
  // that point toward the face center, small on the perimeter ones
  const ganTileGeo = (g, d) => {
    const q = faceQuat(d);
    const axes = ['x', 'y', 'z'].filter((a) => a !== d.axis);
    const radii = TILE_CORNER_SIGNS.map(([sx, sy]) => {
      const dir = new THREE.Vector3(sx, sy, 0).applyQuaternion(q);
      const onPerimeter = axes.some((a) => g[a] !== 0 && Math.sign(Math.round(dir[a])) === g[a]);
      return onPerimeter ? ganOuterR : ganInnerR;
    });
    return tileGeo(stickerSize, radii, tileDepth);
  };

  const cubies = [];
  for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) {
    if (x === 0 && y === 0 && z === 0) continue;
    const g = { x, y, z };
    let mesh;
    const orient = (m, d) => {
      m.quaternion.copy(faceQuat(d));
      m.position[d.axis] = d.sign * (CUBIE / 2 + 0.002);
      m.castShadow = true;
      // DECISION: stickers/caps now receive shadows too (previously nothing
      // on the cube did, so hard cast shadows and self-shadowing on concave
      // bevel gaps were invisible even though castShadow was set everywhere).
      m.receiveShadow = true;
    };
    // The logo decal: a transparent glyph plane floating a hair above the
    // center tile/cap. On a white cap it hides the center color (GAN style),
    // so the model must not depend on always seeing it.
    const addLogo = (parent, d, onCap) => {
      if (onCap) {
        const cap = new THREE.Mesh(circleGeo(stickerSize * 0.49, tileDepth), capMat);
        orient(cap, d);
        parent.add(cap);
      }
      const side = stickerSize * (onCap ? 0.7 : 0.62);
      const decal = new THREE.Mesh(new THREE.PlaneGeometry(side, side), logoMat);
      orient(decal, d);
      decal.position[d.axis] = d.sign * (CUBIE / 2 + 0.002 + tileDepth + 0.003);
      decal.castShadow = false;
      parent.add(decal);
    };
    if (style === 'stickerless') {
      const mats = DIRS.map((d) => (g[d.axis] === d.sign ? faceMats[d.face] : interior));
      mesh = new THREE.Mesh(boxGeo, mats);
      for (const d of DIRS) {
        const isCenter = g[d.axis] === d.sign && ['x', 'y', 'z'].every((a) => a === d.axis || g[a] === 0);
        if (isCenter && d.face === logoFace) addLogo(mesh, d, logoOnCap);
      }
    } else {
      mesh = new THREE.Mesh(boxGeo, plastic);
      for (const d of DIRS) {
        if (g[d.axis] !== d.sign) continue;
        const isCenter = ['x', 'y', 'z'].every((a) => a === d.axis || g[a] === 0);
        if (isCenter && d.face === logoFace && logoOnCap) { addLogo(mesh, d, true); continue; }
        const geo = isCenter ? centerGeo : ganProfile ? ganTileGeo(g, d) : stickerGeo;
        const sticker = new THREE.Mesh(geo, faceMats[d.face]);
        orient(sticker, d);
        mesh.add(sticker);
        if (isCenter && d.face === logoFace) addLogo(mesh, d, false);
      }
    }
    mesh.position.set(x * SPACING, y * SPACING, z * SPACING);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    cubies.push(mesh);
  }

  // Scramble with real face turns. Solved (0 moves) and barely-scrambled
  // cubes are deliberately common: they show whole solid-color faces in
  // every scheme color, which real cubes do all the time - and the stage-1
  // localizer under-boxed featureless solid faces because the training mix
  // almost never contained them (its boxes anchored on the dense regions).
  const axisVec = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) };
  const moveRoll = rnd();
  const nMoves = moveRoll < 0.08 ? 0 : moveRoll < 0.22 ? 1 + Math.floor(rnd() * 3) : 14 + Math.floor(rnd() * 16);
  for (let i = 0; i < nMoves; i++) {
    const axis = pick(rnd, ['x', 'y', 'z']);
    // Outer layers only: slice moves would relocate center cubies, breaking
    // the face-letter <-> center-color identity the labels promise.
    const layer = rnd() < 0.5 ? -1 : 1;
    const dir = rnd() < 0.5 ? 1 : -1;
    const q = new THREE.Quaternion().setFromAxisAngle(axisVec[axis], (dir * Math.PI) / 2);
    for (const c of cubies) {
      if (Math.round(c.position[axis] / SPACING) !== layer) continue;
      c.position.applyAxisAngle(axisVec[axis], (dir * Math.PI) / 2);
      c.position.round();
      c.quaternion.premultiply(q);
    }
  }

  // DECISION: layer misalignment in ~22% of cubes. A held cube's last-turned
  // layer often doesn't sit flush (several of the real bathroom photos show
  // it): one outer layer is left rotated a few degrees, so that face's tiles
  // and the adjacent faces' outer rows are visibly skewed. Mostly small
  // (2-9 deg), occasionally a blatant 10-20 deg. One layer only, so the
  // geometry stays physically possible and every cube vertex belongs to
  // exactly one twisted/untwisted rigid body - the labels below rotate the
  // vertices in the twisted layer by the same angle, which is exactly what
  // a hand labeler clicking the plastic corner would do.
  let twist = null;
  if (rnd() < 0.22) {
    const axis = pick(rnd, ['x', 'y', 'z']);
    const layer = rnd() < 0.5 ? -1 : 1;
    const deg = (rnd() < 0.5 ? 1 : -1) * (rnd() < 0.8 ? 2 + rnd() * 7 : 10 + rnd() * 10);
    const angle = THREE.MathUtils.degToRad(deg);
    const q = new THREE.Quaternion().setFromAxisAngle(axisVec[axis], angle);
    for (const c of cubies) {
      if (Math.round(c.position[axis] / SPACING) !== layer) continue;
      c.position.applyAxisAngle(axisVec[axis], angle);
      c.quaternion.premultiply(q);
    }
    twist = { axis, layer, deg: Number(deg.toFixed(2)), angle };
  }
  return {
    group, nMoves, bevel, twist,
    styleMeta: {
      bodyColor: '#' + bodyHex.toString(16).padStart(6, '0'),
      tileRadius: Number(tileRadius.toFixed(3)), tileDepth: Number(tileDepth.toFixed(3)),
      circleCaps, logoFace, logoOnCap: logoFace ? logoOnCap : null, ganProfile,
      layerTwist: twist ? { axis: twist.axis, layer: twist.layer, deg: twist.deg } : null,
    },
  };
}

const texLoader = new THREE.TextureLoader();
const photoCache = new Map();
async function photoTexture(url) {
  if (!photoCache.has(url)) {
    const t = await texLoader.loadAsync(url);
    t.colorSpace = THREE.SRGBColorSpace;
    photoCache.set(url, t);
  }
  return photoCache.get(url);
}

function canvasTexture(rnd) {
  const t = new THREE.CanvasTexture(proceduralBackground(rnd));
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

window.renderSample = async function renderSample(opts) {
  // DECISION: cornerBias default 0 - current behavior unchanged. Set to a
  // fraction f (see generate.mjs --cornerBias / CORNER_BIAS env var) and that
  // fraction of scenes rejection-sample the camera direction until the cube
  // is seen near-corner-on (see the pose block below).
  const { seed, style, width = 640, height = 480, photoUrls = [], hdriUrls = [], cornerBias = 0 } = opts;
  const rnd = mulberry32(seed);
  if (canvas.width !== width || canvas.height !== height) renderer.setSize(width, height, false);

  const scene = new THREE.Scene();
  const disposables = [];

  if (window.DEBUG_MINIMAL) {
    camera_setup: {
      const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 200);
      if (window.DEBUG_MINIMAL_RANDCAM) {
        const randDir = () => {
          const z = 2 * rnd() - 1; const p = 2 * Math.PI * rnd(); const r = Math.sqrt(1 - z * z);
          return new THREE.Vector3(r * Math.cos(p), r * Math.sin(p), z);
        };
        const fov = 30 + rnd() * 32;
        camera.fov = fov; camera.updateProjectionMatrix();
        const R = H * Math.sqrt(3);
        const fill = 0.3 + rnd() * 0.4;
        const dist = R / (fill * Math.tan(THREE.MathUtils.degToRad(fov / 2)));
        const dirV = randDir();
        camera.position.copy(dirV).multiplyScalar(dist);
        const target = randDir().multiplyScalar(rnd() * H * 1.1);
        camera.lookAt(target);
        camera.rotateZ((rnd() - 0.5) * 0.9);
        camera.updateMatrixWorld();
      } else {
        camera.position.set(0, 0, 6);
        camera.lookAt(0, 0, 0);
      }
      const boxGeo = new THREE.BoxGeometry(H * 2, H * 2, H * 2);
      const boxMat = new THREE.MeshStandardMaterial({ color: 0xffcc00, roughness: 0.4 });
      const box = new THREE.Mesh(boxGeo, boxMat);
      box.castShadow = true; box.receiveShadow = true;
      scene.add(box);
      const dl = new THREE.DirectionalLight(0xffffff, 3.5);
      dl.position.set(3, 6, 4);
      dl.castShadow = true;
      dl.shadow.camera.left = -6; dl.shadow.camera.right = 6; dl.shadow.camera.top = 6; dl.shadow.camera.bottom = -6;
      dl.shadow.camera.updateProjectionMatrix();
      dl.shadow.mapSize.set(2048, 2048);
      scene.add(dl);
      scene.add(new THREE.HemisphereLight(0xffffff, 0x202025, 0.6));
      if (window.DEBUG_MINIMAL_TABLE) {
        const table = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), new THREE.MeshStandardMaterial({ color: 0xdddddd, roughness: 0.85 }));
        table.rotateX(-Math.PI / 2);
        table.position.y = -H - 0.02;
        table.receiveShadow = true;
        scene.add(table);
      }
      if (window.DEBUG_MINIMAL_2LIGHT) {
        const dl2 = new THREE.DirectionalLight(0xffddaa, 1.5);
        dl2.position.set(-4, 3, -5);
        scene.add(dl2);
      }
      const lightDist = dl.position.length();
      const lightDir = dl.position.clone().normalize();
      const perp = new THREE.Vector3().crossVectors(lightDir, new THREE.Vector3(0, 1, 0)).normalize();
      const occ = new THREE.Mesh(
        new THREE.BoxGeometry(H * 1.2, H * 1.2 * 0.9, H * 1.2 * 0.5),
        new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.85 }),
      );
      occ.position.copy(lightDir.clone().multiplyScalar(lightDist * 0.45)).add(perp.multiplyScalar(H * 0.5));
      occ.lookAt(0, 0, 0);
      occ.castShadow = true;
      scene.add(occ);
      renderer.render(scene, camera);
      return { dataUrl: renderer.domElement.toDataURL('image/png'), label: { width, height, style, faces: {}, meta: {} } };
    }
  }

  // occasional murky scenes: the real webcam fixtures are mostly lit by a
  // monitor in a dark room, far dimmer than the average render
  const dim = rnd() < 0.18 ? 0.2 + rnd() * 0.35 : 1;
  renderer.toneMappingExposure = 0.75 + rnd() * 0.7;

  // --- environment lighting (image-based; the point/hemi lights only add
  // shadows and glare on top) ---
  let envName = null;
  let env = null;
  if (hdriUrls.length) {
    const url = pick(rnd, hdriUrls);
    envName = decodeURIComponent(url.split('/').pop()).replace(/\.hdr$/i, '');
    env = await hdriEnv(url);
    scene.environment = env.env;
    scene.environmentIntensity = dim * (0.5 + rnd() * 1.1);
  }
  if (window.DEBUG_NO_ENV) { scene.environment = null; env = null; }

  // --- background ---
  let bgKind;
  const bgRoll = rnd();
  if (env && bgRoll < 0.45) {
    // the environment itself: a real room behind the cube, consistent with
    // the light falling on it - the strongest anti-"rendered" cue we have
    bgKind = 'hdri';
    scene.background = env.bg;
    scene.backgroundIntensity = dim * (0.7 + rnd() * 0.6);
    scene.backgroundBlurriness = rnd() < 0.5 ? rnd() * 0.3 : 0; // webcam-ish defocus half the time
  } else if (photoUrls.length && bgRoll < 0.7) {
    bgKind = 'photo';
    scene.background = await photoTexture(pick(rnd, photoUrls));
  } else {
    bgKind = 'procedural';
    const t = canvasTexture(rnd);
    scene.background = t;
    disposables.push(t);
  }

  // --- cube ---
  // Hard negatives (M8): a slice of samples has NO cube at all - just the
  // background/table/lights. Without them the conf head never learns what
  // "no cube anywhere" looks like and can hallucinate faces on empty scenes
  // (tiles and keyboards are the known false-candidate case). All faces get
  // visible:false, corners:null - the training loader maps null corners to
  // valid=0, so no corner gradient flows from these.
  const negative = rnd() < 0.07;
  const { group, nMoves, bevel, twist, styleMeta } = buildCube(rnd, style);
  if (window.DEBUG_SIMPLE_CUBE) {
    const ref = new THREE.Mesh(new THREE.BoxGeometry(H * 2, H * 2, H * 2), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5 }));
    ref.castShadow = true;
    ref.receiveShadow = true;
    scene.add(ref);
  } else if (!negative) scene.add(group);

  // --- camera ---
  // seeded random direction (THREE's randomDirection uses Math.random and
  // would break per-sample determinism)
  const randDir = () => {
    const z = 2 * rnd() - 1;
    const p = 2 * Math.PI * rnd();
    const r = Math.sqrt(1 - z * z);
    return new THREE.Vector3(r * Math.cos(p), r * Math.sin(p), z);
  };
  const fov = 30 + rnd() * 32;
  const camera = new THREE.PerspectiveCamera(fov, width / height, 0.1, 200);
  const R = H * Math.sqrt(3);
  // DECISION: two framing regimes. The grid-scanner use case holds one face
  // near-frontal filling most of the frame; the first 20k renders almost
  // never did (real webcam frames sat far outside the trained scale range,
  // see model/README sim-to-real notes). 40% close-ups now.
  const closeUp = rnd() < 0.4;
  // DECISION 2026-09-12 (user): never render the cube further away than a
  // person can physically hold one. `fill` is the cube's bounding-sphere
  // radius as a fraction of the half frame height, so a face's longest edge
  // lands at ~138.5 * fill px at the 320x240 model input. Measured on a photo
  // of the user holding a cube at full arm's reach, that edge is 36.8 px,
  // i.e. fill 0.27 - and the old floor of 0.22 was rendering cubes ~20%
  // further than anyone will ever scan from. Those frames cost capacity and
  // dragged every recall number for a distance the app does not have to
  // serve. The matching "don't score it either" floor is
  // train/targets.py MIN_FACE_EDGE_PX (32 px = fill 0.23), deliberately a
  // little lower so nothing we generate sits in the ignored band.
  const fill = closeUp ? 0.55 + rnd() * 0.5 : 0.27 + rnd() * 0.37;
  const dist = R / (fill * Math.tan(THREE.MathUtils.degToRad(fov / 2)));
  let dirV;
  // DECISION: near-corner-on poses (3rd-most-facing face >= 0.30 facing) are
  // only ~2% of uniform samples (measured) and are the model's weakest class.
  // Rejection-sample straight from randDir() - not the near-face-on branch,
  // which biases toward one dominant face and away from corners - until the
  // constraint holds. It's a small solid angle; cap tries at 200 and fall
  // back to the last (still oblique, still useful) draw rather than loop
  // forever.
  const wantCornerOn = cornerBias > 0 && rnd() < cornerBias;
  if (wantCornerOn) {
    let tries = 0;
    do {
      dirV = randDir();
      tries++;
    } while (tries < 200 && faceFacings(dirV.clone().multiplyScalar(dist))[2] < 0.30);
  } else if (rnd() < 0.35) {
    // near-face-on view of a random face, like a cube held up to a webcam
    const a = pick(rnd, [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]);
    dirV = new THREE.Vector3(a[0], a[1], a[2])
      .add(randDir().multiplyScalar(0.15 + rnd() * 0.45))
      .normalize();
  } else {
    dirV = randDir();
  }
  camera.position.copy(dirV).multiplyScalar(dist);
  const target = randDir().multiplyScalar(rnd() * H * 1.1);
  camera.lookAt(target);
  camera.rotateZ((rnd() - 0.5) * 0.9 + (rnd() < 0.1 ? Math.PI * rnd() : 0));
  camera.updateMatrixWorld();

  // --- hands + foreground clutter (M4) ---
  // Occlusion only: never touch corners/visible/facing below, which are pure
  // projected-geometry labels computed from the cube's true (unoccluded)
  // pose. The model is meant to learn to predict corners under occlusion.
  const camRight = new THREE.Vector3(1, 0, 0).transformDirection(camera.matrixWorld);
  const camUp = new THREE.Vector3(0, 1, 0).transformDirection(camera.matrixWorld);
  const camFwd = new THREE.Vector3(0, 0, -1).transformDirection(camera.matrixWorld);
  // DECISION: hands in ~50% of scenes - every real usage photo has them, and
  // M3 data had none. Gated on a real cube being present (nothing to grip in
  // a negative/no-cube scene).
  const hasHands = !negative && rnd() < 0.5;
  let handMeta = null;
  if (hasHands && !window.DEBUG_BARE) {
    const hands = buildHands(rnd, camera.position, camRight, camUp, camFwd, dist);
    scene.add(hands);
    handMeta = hands.userData;
  }
  // DECISION: unrelated foreground junk in ~20% of scenes.
  const hasClutter = !negative && rnd() < 0.2;
  if (hasClutter && !window.DEBUG_BARE) scene.add(buildClutter(rnd, camera.position, camRight, camUp, camFwd, dist));

  // --- surfaces behind/below (perspective hard negatives + shadow catcher) ---
  // DECISION: these planes COVER scene.background whenever they're in view,
  // so with procedural-only maps the visible-pixel background distribution
  // was ~all hard-edged canvases no matter what bgKind claimed, and the
  // detector collapsed on soft real scenes (crumpled duvet). They now draw
  // from the photo pool too. Photo textures are cached in photoCache; clone
  // per use and never dispose the cache's copy.
  const surfaceTexture = async () => {
    if (photoUrls.length && rnd() < 0.5) {
      const t = (await photoTexture(pick(rnd, photoUrls))).clone();
      t.wrapS = t.wrapT = THREE.MirroredRepeatWrapping;
      return { tex: t, photo: true };
    }
    const t = canvasTexture(rnd);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    return { tex: t, photo: false };
  };
  const viewDir = target.clone().sub(camera.position).normalize();
  const hasTable = window.DEBUG_FORCE_TABLE || rnd() < 0.45;
  if (rnd() < 0.55 && !window.DEBUG_BARE) {
    const { tex: t, photo } = await surfaceTexture();
    const rep = photo ? 1 + Math.floor(rnd() * 2) : 2 + Math.floor(rnd() * 5);
    t.repeat.set(rep, rep);
    const mat = new THREE.MeshStandardMaterial({ map: t, roughness: 0.9 });
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), mat);
    plane.position.copy(viewDir).multiplyScalar(4 + rnd() * 8);
    plane.lookAt(camera.position);
    plane.rotateX((rnd() - 0.5) * 0.8);
    plane.rotateY((rnd() - 0.5) * 0.8);
    scene.add(plane);
    disposables.push(t, mat, plane.geometry);
  }
  if (hasTable && !window.DEBUG_BARE) {
    const { tex: t, photo } = await surfaceTexture();
    t.repeat.set(photo ? 2 : 4, photo ? 2 : 4);
    const mat = new THREE.MeshStandardMaterial({ map: t, roughness: 0.85 });
    const table = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), mat);
    table.rotateX(-Math.PI / 2);
    table.position.y = -H - 0.02;
    table.receiveShadow = true;
    scene.add(table);
    disposables.push(t, mat, table.geometry);
  }

  // --- lights ---
  // With an environment map the analytic lights are only there for cast
  // shadows and glare; without one (no hdri files) they carry the scene.
  const lightScale = env ? 0.35 : 1;
  const hemi = new THREE.HemisphereLight(kelvinToColor(4500 + rnd() * 3500), 0x202025,
    dim * lightScale * (0.25 + rnd() * 0.7));
  scene.add(hemi);
  const nDir = 1 + (rnd() < 0.6 ? 1 : 0);
  // DECISION: hard cast shadows in ~25% of scenes - a real occluder between
  // the light and the cube, not just a shadow-intensity slider. Gated on a
  // real cube being present. Reuses the first directional light (forcing its
  // castShadow on even without a table) rather than adding a dedicated light,
  // so scenes don't get an extra uncontrolled light source.
  const hardShadow = !negative && (window.DEBUG_FORCE_SHADOW || rnd() < 0.25);
  let shadowLight = null;
  const kelvins = [];
  for (let i = 0; i < nDir; i++) {
    const k = 2500 + rnd() * 4500; // warm indoor light is the known hard case
    kelvins.push(Math.round(k));
    const dl = new THREE.DirectionalLight(kelvinToColor(k), dim * lightScale * (0.6 + rnd() * 2.2));
    dl.position.set((rnd() - 0.5) * 16, 2 + rnd() * 10, (rnd() - 0.5) * 16);
    if (i === 0 && hardShadow) {
      // A hard edge needs a light that actually dominates the ambient/IBL
      // fill - with an HDRI env, lightScale already knocked this light down
      // to 0.35x specifically so it wouldn't double up with the environment,
      // which made the shadow real but imperceptible (the env's IBL isn't
      // shadow-mapped, so it fills the "shadowed" region right back in).
      // Override lightScale here: a hard cast shadow implies a strong
      // directional source (a sunbeam through a window) that would
      // overpower ambient in a real photo too.
      dl.intensity = dim * (2.2 + rnd() * 2.0);
    }
    // DECISION: hands also turn shadow casting on - fingers gripping the cube
    // always shade it a little in real photos (soft finger shadows across the
    // outer stickers), and without a shadow-mapped light those never rendered
    // even though the finger meshes had castShadow set.
    if (i === 0 && (hasTable || hardShadow || hasHands)) {
      dl.castShadow = true;
      dl.shadow.camera.left = dl.shadow.camera.bottom = -6;
      dl.shadow.camera.right = dl.shadow.camera.top = 6;
      // BUG FIXED: the default near/far (0.5/500) was hugely oversized for
      // this scene's actual scale (light distance ~2-20 units) - that starves
      // the shadow map's depth precision badly enough that the depth test
      // silently always passes, i.e. no occlusion is ever detected and the
      // "shadow" render is indistinguishable from no shadow at all. Tighten
      // to the light's actual distance +/- a cube-scale margin.
      const ld = dl.position.length();
      dl.shadow.camera.near = Math.max(0.5, ld - H * 4);
      dl.shadow.camera.far = ld + H * 4;
      dl.shadow.camera.updateProjectionMatrix();
      dl.shadow.mapSize.set(hardShadow ? 2048 : 1024, hardShadow ? 2048 : 1024);
      shadowLight = dl;
    }
    scene.add(dl);
  }
  if (hardShadow && shadowLight) {
    // Occluder sits between the light and the cube. DirectionalLight shadows
    // are orthographic (parallel rays), so its distance along the light
    // direction doesn't change the shadow's shape on the cube - only the
    // lateral offset (within the +/-6 shadow-camera box above) does, which is
    // what determines how much of the cube the hard edge crosses.
    const lightDist = shadowLight.position.length();
    const lightDir = shadowLight.position.clone().normalize();
    // BUG FIXED: picking the lateral direction uniformly at random around the
    // light axis put the shadow on a uniformly random side of the cube,
    // independent of the camera - e.g. an overhead light shadows the top
    // face while the camera is looking at a side face, so the "hard shadow"
    // was real but landed somewhere the camera never sees. Bias toward the
    // camera's side of the light axis (the component of the camera direction
    // perpendicular to the light), with only a moderate jitter, so the shadow
    // reliably crosses a face the camera is actually looking at.
    const toCam = camera.position.clone().normalize();
    let perpBase = toCam.clone().sub(lightDir.clone().multiplyScalar(toCam.dot(lightDir)));
    if (perpBase.lengthSq() < 1e-6) {
      // degenerate: camera nearly on the light's own axis - any perpendicular works
      const arbitrary = Math.abs(lightDir.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
      perpBase = new THREE.Vector3().crossVectors(lightDir, arbitrary);
    }
    perpBase.normalize();
    const angle = (rnd() - 0.5) * Math.PI * 0.6; // jitter, but stay on the camera-facing side
    const perp = perpBase.applyAxisAngle(lightDir, angle);
    const lateral = window.DEBUG_SHADOW_MAX ? 0 : H * (0.2 + rnd() * 0.7); // partial coverage - a hard edge across faces, not a full eclipse
    // BUG FIXED: this used to be a fixed H-scaled distance (~2.7-4.7 units),
    // which for a light placed close to the origin (y as low as 2) could
    // exceed the light's own distance from origin - putting the occluder
    // *behind* the light, outside the shadow camera's near plane, casting no
    // shadow at all. Scale as a fraction of the light's actual distance so
    // it's always strictly between the light and the cube.
    const along = lightDist * (0.3 + rnd() * 0.4);
    const occSize = window.DEBUG_SHADOW_MAX ? H * 4 : H * (0.7 + rnd() * 0.7); // kept modest: sits outside frame most of the time, never dominates it
    const occGeo = new THREE.BoxGeometry(occSize, occSize * (0.6 + rnd() * 0.6), occSize * (0.3 + rnd() * 0.5));
    const occMat = new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.85 });
    const occluder = new THREE.Mesh(occGeo, occMat);
    occluder.position.copy(lightDir.multiplyScalar(along)).add(perp.multiplyScalar(lateral));
    occluder.lookAt(0, 0, 0);
    occluder.castShadow = true;
    scene.add(occluder);
    disposables.push(occGeo, occMat);
    if (window.DEBUG_LOG_SHADOW) {
      const box = new THREE.Box3().setFromObject(occluder);
      const rc = new THREE.Raycaster();
      // Sample the cube surface point nearest the camera and ray-test toward the light.
      const toCam = camera.position.clone().normalize();
      const surfacePoint = toCam.clone().multiplyScalar(H);
      const toLight = shadowLight.position.clone().sub(surfacePoint).normalize();
      rc.set(surfacePoint.clone().add(toLight.clone().multiplyScalar(0.01)), toLight);
      const hit = rc.intersectObject(occluder, false);
      console.log('[shadowdbg]', JSON.stringify({
        lightPos: shadowLight.position.toArray().map(n => +n.toFixed(2)),
        lightDist: +lightDist.toFixed(2), along: +along.toFixed(2), lateral: +lateral.toFixed(2),
        occPos: occluder.position.toArray().map(n => +n.toFixed(2)),
        occBoxMin: box.min.toArray().map(n => +n.toFixed(2)), occBoxMax: box.max.toArray().map(n => +n.toFixed(2)),
        surfacePoint: surfacePoint.toArray().map(n => +n.toFixed(2)),
        rayHitsOccluder: hit.length > 0,
      }));
    }
  }
  if (rnd() < 0.3) {
    // Glare: a bright point source near the camera blows out the nearest face.
    const pl = new THREE.PointLight(kelvinToColor(2800 + rnd() * 3500), 30 + rnd() * 120, 0, 2);
    pl.position.copy(camera.position).multiplyScalar(0.5).add(new THREE.Vector3((rnd() - 0.5) * 3, rnd() * 3, (rnd() - 0.5) * 3));
    scene.add(pl);
  }

  // DECISION: auto-exposure floor. ~3% of frames came out near-black (night
  // HDRIs x low `dim` x low exposure: cube mean < 25/255, sticker colors
  // unreadable even to a human - data_v4 img_000007). A phone camera
  // auto-exposes and never delivers that frame, so do the same: measure the
  // mean luminance over the cube's projected box (whole frame for no-cube
  // negatives) and re-render with more exposure until it clears a floor.
  // Murky-but-legible dark scenes (the monitor-lit webcam case) stay: the
  // floor is low, and only frames below it are lifted.
  const LUM_FLOOR = 0.15, LUM_TARGET = 0.23;
  const meter = document.createElement('canvas');
  meter.width = 64; meter.height = 48;
  const mctx = meter.getContext('2d', { willReadFrequently: true });
  const cubeBox = () => {
    let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
      const v = new THREE.Vector3(sx * H, sy * H, sz * H).project(camera);
      x0 = Math.min(x0, v.x * 0.5 + 0.5); x1 = Math.max(x1, v.x * 0.5 + 0.5);
      y0 = Math.min(y0, -v.y * 0.5 + 0.5); y1 = Math.max(y1, -v.y * 0.5 + 0.5);
    }
    return [Math.max(0, x0), Math.max(0, y0), Math.min(1, x1), Math.min(1, y1)];
  };
  const meanLuminance = () => {
    mctx.drawImage(renderer.domElement, 0, 0, meter.width, meter.height);
    const [bx0, by0, bx1, by1] = negative ? [0, 0, 1, 1] : cubeBox();
    const cx0 = Math.floor(bx0 * meter.width), cx1 = Math.ceil(bx1 * meter.width);
    const cy0 = Math.floor(by0 * meter.height), cy1 = Math.ceil(by1 * meter.height);
    const w = cx1 - cx0, h = cy1 - cy0;
    if (w < 2 || h < 2) return 1; // cube (nearly) out of frame: nothing to meter
    const d = mctx.getImageData(cx0, cy0, w, h).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    return sum / (255 * (d.length / 4));
  };
  let exposureBoost = 1;
  let cubeLum = 0;
  for (let attempt = 0; ; attempt++) {
    renderer.render(scene, camera);
    cubeLum = meanLuminance();
    if (cubeLum >= LUM_FLOOR || attempt >= 3) break;
    const f = Math.min(3, Math.max(1.4, LUM_TARGET / Math.max(cubeLum, 0.01)));
    renderer.toneMappingExposure *= f;
    exposureBoost *= f;
  }
  if (window.DEBUG_LOG_SHADOW) {
    console.log('[shadowdbg2]', JSON.stringify({
      shadowMapEnabled: renderer.shadowMap.enabled,
      shadowMapType: renderer.shadowMap.type,
      hardShadow, hasShadowLight: !!shadowLight,
      shadowLightCastShadow: shadowLight ? shadowLight.castShadow : null,
      shadowLightIntensity: shadowLight ? shadowLight.intensity : null,
      shadowMapExists: shadowLight ? !!shadowLight.shadow.map : null,
      sceneChildCount: scene.children.length,
    }));
  }
  const dataUrl = renderer.domElement.toDataURL('image/png');

  // --- labels ---
  // Rounded cubies pull the cube's corner silhouette in from the sharp-box
  // vertex: the outermost point of a corner rounded with radius r sits at
  // +/-(H - r(1 - 1/sqrt(3))) per axis. Matches the hand-labeling convention
  // "outermost point of the plastic, never extrapolate past the edge".
  const cornerH = H - bevel * (1 - 1 / Math.sqrt(3));
  const twistAxisVec = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) };
  const faces = {};
  const camPos = camera.position;
  if (negative) {
    for (const f of Object.keys(FACE_DATA)) faces[f] = { visible: false, facing: 0, corners: null };
  } else
  for (const [f, fd] of Object.entries(FACE_DATA)) {
    const normal = new THREE.Vector3(...fd.n);
    const center = normal.clone().multiplyScalar(H);
    const facing = normal.dot(camPos.clone().sub(center).normalize());
    const corners = fd.corners.map(([x, y, z]) => {
      const v = new THREE.Vector3(x * cornerH, y * cornerH, z * cornerH);
      // vertices on a misaligned layer move with it (see buildCube)
      if (twist && { x, y, z }[twist.axis] === twist.layer) v.applyAxisAngle(twistAxisVec[twist.axis], twist.angle);
      v.project(camera);
      return [Number(((v.x * 0.5 + 0.5) * width).toFixed(2)), Number(((-v.y * 0.5 + 0.5) * height).toFixed(2))];
    });
    const pc = center.clone().project(camera);
    const cx = (pc.x * 0.5 + 0.5) * width;
    const cy = (-pc.y * 0.5 + 0.5) * height;
    const inFrame = cx > -8 && cx < width + 8 && cy > -8 && cy < height + 8;
    faces[f] = { visible: facing > 0.15 && inFrame, facing: Number(facing.toFixed(3)), corners };
  }

  // --- cleanup ---
  scene.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) { const ms = Array.isArray(o.material) ? o.material : [o.material]; for (const m of ms) m.dispose(); }
  });
  for (const d of disposables) if (d.dispose) d.dispose();

  return {
    dataUrl,
    label: {
      width, height, style, faces,
      meta: {
        seed, scrambleMoves: nMoves, fov: Number(fov.toFixed(1)), bgKind, lightKelvins: kelvins,
        closeUp, dim: Number(dim.toFixed(2)), envName, negative,
        exposure: Number(renderer.toneMappingExposure.toFixed(2)), bevel: Number(bevel.toFixed(3)),
        exposureBoost: Number(exposureBoost.toFixed(2)), cubeLum: Number(cubeLum.toFixed(3)),
        cornerBias: Number(cornerBias) || 0, cornerOn: wantCornerOn, hasHands, hasClutter, hardShadow,
        hasPalm: handMeta ? handMeta.hasPalm : false, nFingers: handMeta ? handMeta.nFingers : 0,
        ...styleMeta,
      },
    },
  };
};

window.logoTexture = logoTexture; // debug: tools can sheet the logo family
window.ready = true;
