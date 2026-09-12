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
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
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

function buildCube(rnd, style) {
  const group = new THREE.Group();
  const colors = faceColors(rnd);
  const rough = 0.15 + rnd() * 0.5; // low roughness -> specular glare
  // Rounded cubies like real cubes. RoundedBoxGeometry subclasses
  // BoxGeometry, so the 6 material groups (+x -x +y -y +z -z) survive and
  // stickerless per-face coloring splits along the bevel like molded plastic.
  const bevel = CUBIE * (0.045 + rnd() * 0.045);
  const boxGeo = new RoundedBoxGeometry(CUBIE, CUBIE, CUBIE, 3, bevel);
  const stickerSize = (CUBIE - 2 * bevel) * (0.88 + rnd() * 0.09);
  const stickerGeo = new THREE.PlaneGeometry(stickerSize, stickerSize);
  const plastic = new THREE.MeshStandardMaterial({ color: 0x0a0a0a, roughness: 0.35 + rnd() * 0.3 });
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

  const cubies = [];
  for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) {
    if (x === 0 && y === 0 && z === 0) continue;
    const g = { x, y, z };
    let mesh;
    if (style === 'stickerless') {
      const mats = DIRS.map((d) => (g[d.axis] === d.sign ? faceMats[d.face] : interior));
      mesh = new THREE.Mesh(boxGeo, mats);
    } else {
      mesh = new THREE.Mesh(boxGeo, plastic);
      for (const d of DIRS) {
        if (g[d.axis] !== d.sign) continue;
        const sticker = new THREE.Mesh(stickerGeo, faceMats[d.face]);
        if (d.axis === 'x') sticker.rotateY((Math.PI / 2) * d.sign);
        else if (d.axis === 'y') sticker.rotateX((-Math.PI / 2) * d.sign);
        else if (d.sign < 0) sticker.rotateY(Math.PI);
        sticker.position[d.axis] = d.sign * (CUBIE / 2 + 0.004);
        sticker.castShadow = true;
        mesh.add(sticker);
      }
    }
    mesh.position.set(x * SPACING, y * SPACING, z * SPACING);
    mesh.castShadow = true;
    group.add(mesh);
    cubies.push(mesh);
  }

  // Scramble with real face turns.
  const axisVec = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) };
  const nMoves = 14 + Math.floor(rnd() * 16);
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
  return { group, nMoves, bevel };
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
  const { seed, style, width = 640, height = 480, photoUrls = [], hdriUrls = [] } = opts;
  const rnd = mulberry32(seed);
  if (canvas.width !== width || canvas.height !== height) renderer.setSize(width, height, false);

  const scene = new THREE.Scene();
  const disposables = [];

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
  const { group, nMoves, bevel } = buildCube(rnd, style);
  if (!negative) scene.add(group);

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
  if (rnd() < 0.35) {
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

  // --- surfaces behind/below (perspective hard negatives + shadow catcher) ---
  const viewDir = target.clone().sub(camera.position).normalize();
  const hasTable = rnd() < 0.45;
  if (rnd() < 0.55) {
    const t = canvasTexture(rnd);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    const rep = 2 + Math.floor(rnd() * 5);
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
  if (hasTable) {
    const t = canvasTexture(rnd);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(4, 4);
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
  const kelvins = [];
  for (let i = 0; i < nDir; i++) {
    const k = 2500 + rnd() * 4500; // warm indoor light is the known hard case
    kelvins.push(Math.round(k));
    const dl = new THREE.DirectionalLight(kelvinToColor(k), dim * lightScale * (0.6 + rnd() * 2.2));
    dl.position.set((rnd() - 0.5) * 16, 2 + rnd() * 10, (rnd() - 0.5) * 16);
    if (i === 0 && hasTable) {
      dl.castShadow = true;
      dl.shadow.camera.left = dl.shadow.camera.bottom = -6;
      dl.shadow.camera.right = dl.shadow.camera.top = 6;
      dl.shadow.mapSize.set(1024, 1024);
    }
    scene.add(dl);
  }
  if (rnd() < 0.3) {
    // Glare: a bright point source near the camera blows out the nearest face.
    const pl = new THREE.PointLight(kelvinToColor(2800 + rnd() * 3500), 30 + rnd() * 120, 0, 2);
    pl.position.copy(camera.position).multiplyScalar(0.5).add(new THREE.Vector3((rnd() - 0.5) * 3, rnd() * 3, (rnd() - 0.5) * 3));
    scene.add(pl);
  }

  renderer.render(scene, camera);
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
      },
    },
  };
};

window.ready = true;
