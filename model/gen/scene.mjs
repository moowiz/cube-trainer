// Browser-side synthetic scene (M3). Runs inside headless Chrome, driven by
// generate.mjs over page.evaluate. Renders a stickered or stickerless 3x3 cube
// with a real random scramble (cubies are rigid bodies rotated in 90° face
// turns, so sticker geometry is always physically consistent), random camera
// pose, random warm/cool lighting with occasional glare, and random
// backgrounds including procedural grids/tiles as hard negatives.
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
function tileGeo(size, radius, depth) {
  const h = size / 2, r = Math.min(Math.max(radius, 0.0001), h * 0.49);
  const s = new THREE.Shape();
  s.absarc(h - r, h - r, r, 0, Math.PI / 2);
  s.absarc(r - h, h - r, r, Math.PI / 2, Math.PI);
  s.absarc(r - h, r - h, r, Math.PI, Math.PI * 1.5);
  s.absarc(h - r, r - h, r, Math.PI * 1.5, Math.PI * 2);
  s.closePath();
  return new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: false, curveSegments: 5 });
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
  const geo = new THREE.CapsuleGeometry(radius, cylLen, 4, 8);
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

function buildHands(rnd, camPos, camRight, camUp, camFwd, dist) {
  const group = new THREE.Group();
  const baseHex = pick(rnd, SKIN_TONES);
  const skin = new THREE.Color(baseHex);
  // DECISION: matte skin - high roughness, zero metalness/clearcoat, so
  // fingers never pick up the specular glare tuned for plastic stickers.
  const material = new THREE.MeshStandardMaterial({ roughness: 0.75 + rnd() * 0.2, metalness: 0 });

  // DECISION: 40% "wrap" grips straddling two adjacent screen edges (a real
  // hand curling around a corner/edge), 60% single-edge entry. Bottom entry
  // (holding the cube up to show a face) is weighted heaviest.
  const wrap = rnd() < 0.4;
  const edgePairs = [['bottom', 'left'], ['bottom', 'right'], ['top', 'left'], ['top', 'right']];
  const edges = wrap ? pick(rnd, edgePairs) : [pick(rnd, ['bottom', 'bottom', 'bottom', 'left', 'right', 'top'])];

  const nFingers = 2 + Math.floor(rnd() * 4); // 2-5
  for (let i = 0; i < nFingers; i++) {
    const edge = edges[i % edges.length];
    const { out, along } = EDGE_BASIS[edge](camRight, camUp);
    const tone = skin.clone().offsetHSL((rnd() - 0.5) * 0.02, (rnd() - 0.5) * 0.08, (rnd() - 0.5) * 0.08);
    const mat = material.clone();
    mat.color = tone;

    const alongBase = (rnd() - 0.5) * 2 * H * 0.9;
    const alongTip = alongBase + (rnd() - 0.5) * H * 0.3; // slight lateral drift = non-parallel fingers
    const outBase = H * (1.2 + rnd() * 0.6); // root, off toward the frame edge
    const outTip = H * (-0.3 + rnd() * 0.5); // tip pokes in past the cube's centerline
    const fdistBase = dist - H * (0.3 + rnd() * 1.0);
    const fdistTip = dist - H * (0.05 + rnd() * 0.35); // always nearer camera than cube surface

    const base = camPos.clone().add(camFwd.clone().multiplyScalar(fdistBase))
      .add(out.clone().multiplyScalar(outBase)).add(along.clone().multiplyScalar(alongBase));
    const tip = camPos.clone().add(camFwd.clone().multiplyScalar(fdistTip))
      .add(out.clone().multiplyScalar(outTip)).add(along.clone().multiplyScalar(alongTip));
    // slight curl: bend the finger at a knuckle offset perpendicular to its
    // own axis, so it isn't a straight rod
    const mid = base.clone().lerp(tip, 0.55 + (rnd() - 0.5) * 0.15);
    const curl = out.clone().multiplyScalar((rnd() - 0.5) * H * 0.3).add(along.clone().multiplyScalar((rnd() - 0.5) * H * 0.2));
    mid.add(curl);

    const r1 = H * (0.09 + rnd() * 0.06);
    const r2 = r1 * 0.78;
    group.add(capsuleBetween(base, mid, r1, mat));
    group.add(capsuleBetween(mid, tip, r2, mat));
  }
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
  // circular center caps (GAN RS look); logo cap hides one center's color
  const circleCaps = rnd() < 0.3;
  const centerGeo = circleCaps ? circleGeo(stickerSize * 0.5, tileDepth) : stickerGeo;
  const logoFace = rnd() < 0.22 ? (rnd() < 0.5 ? 'U' : pick(rnd, Object.keys(SCHEME))) : null;
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
  const logoMat = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color().setHSL(rnd(), 0.6 + rnd() * 0.4, 0.3 + rnd() * 0.25), roughness: rough, metalness: 0,
  });

  const cubies = [];
  for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) {
    if (x === 0 && y === 0 && z === 0) continue;
    const g = { x, y, z };
    let mesh;
    const orient = (m, d) => {
      if (d.axis === 'x') m.rotateY((Math.PI / 2) * d.sign);
      else if (d.axis === 'y') m.rotateX((-Math.PI / 2) * d.sign);
      else if (d.sign < 0) m.rotateY(Math.PI);
      m.position[d.axis] = d.sign * (CUBIE / 2 + 0.002);
      m.castShadow = true;
      // DECISION: stickers/caps now receive shadows too (previously nothing
      // on the cube did, so hard cast shadows and self-shadowing on concave
      // bevel gaps were invisible even though castShadow was set everywhere).
      m.receiveShadow = true;
    };
    const addLogoCap = (parent, d) => {
      // white disc + colored smudge: the GAN-style center cap, which hides
      // the center color so the model must not depend on always seeing it
      const cap = new THREE.Mesh(circleGeo(stickerSize * 0.49, tileDepth), capMat);
      orient(cap, d);
      parent.add(cap);
      const smudge = new THREE.Mesh(tileGeo(stickerSize * 0.42, stickerSize * 0.1, tileDepth * 0.6), logoMat);
      orient(smudge, d);
      smudge.position[d.axis] = d.sign * (CUBIE / 2 + 0.002 + tileDepth);
      smudge.rotateZ(rnd() * Math.PI);
      smudge.castShadow = true;
      smudge.receiveShadow = true;
      parent.add(smudge);
    };
    if (style === 'stickerless') {
      const mats = DIRS.map((d) => (g[d.axis] === d.sign ? faceMats[d.face] : interior));
      mesh = new THREE.Mesh(boxGeo, mats);
      for (const d of DIRS) {
        const isCenter = g[d.axis] === d.sign && ['x', 'y', 'z'].every((a) => a === d.axis || g[a] === 0);
        if (isCenter && d.face === logoFace) addLogoCap(mesh, d);
      }
    } else {
      mesh = new THREE.Mesh(boxGeo, plastic);
      for (const d of DIRS) {
        if (g[d.axis] !== d.sign) continue;
        const isCenter = ['x', 'y', 'z'].every((a) => a === d.axis || g[a] === 0);
        if (isCenter && d.face === logoFace) { addLogoCap(mesh, d); continue; }
        const sticker = new THREE.Mesh(isCenter ? centerGeo : stickerGeo, faceMats[d.face]);
        orient(sticker, d);
        mesh.add(sticker);
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
  return {
    group, nMoves, bevel,
    styleMeta: {
      bodyColor: '#' + bodyHex.toString(16).padStart(6, '0'),
      tileRadius: Number(tileRadius.toFixed(3)), tileDepth: Number(tileDepth.toFixed(3)),
      circleCaps, logoFace,
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
  const { group, nMoves, bevel, styleMeta } = buildCube(rnd, style);
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
  const fill = closeUp ? 0.55 + rnd() * 0.5 : 0.22 + rnd() * 0.42;
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
  if (hasHands && !window.DEBUG_BARE) scene.add(buildHands(rnd, camera.position, camRight, camUp, camFwd, dist));
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
    if (i === 0 && (hasTable || hardShadow)) {
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

  renderer.render(scene, camera);
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
      const v = new THREE.Vector3(x * cornerH, y * cornerH, z * cornerH).project(camera);
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
        cornerBias: Number(cornerBias) || 0, cornerOn: wantCornerOn, hasHands, hasClutter, hardShadow,
        ...styleMeta,
      },
    },
  };
};

window.ready = true;
