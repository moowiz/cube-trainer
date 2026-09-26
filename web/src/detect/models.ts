// Loading the two-stage detector, in one place. The policy
// (model/PORTRAIT-DESIGN.md 3.3) is: always two-stage. A missing stage 1, a
// missing stage 2, or a stage 2 without the crop-trained stamp all mean the
// same thing - there is no learned detection path on this build and the grid
// scanner is the app. Every page used to spell this out itself; now they
// call loadTwoStage() and show `reason`.
//
// Loads are serialized: ort-web's wasm module is not reentrant across
// sessions, so a second load (an EP switch, the self-test) must wait for any
// in-flight load - including the ~1 s 'auto' benchmark - to finish.
import { timed } from '../debug/boot';
import { CubeLocalizer } from './cubebox';
import { FaceDetector, type Ep } from './facekp';

export interface TwoStageModels {
  detector: FaceDetector;
  localizer: CubeLocalizer;
}

export type LoadOutcome =
  | { models: TwoStageModels; reason: null }
  | { models: null; reason: string };

let chain: Promise<unknown> = Promise.resolve();

/** Load (or reload, on an EP change) both stages. The previous models are disposed. */
export function loadTwoStage(ep: Ep | 'auto', previous: TwoStageModels | null = null): Promise<LoadOutcome> {
  const next = chain.then(() => doLoad(ep, previous));
  chain = next.catch(() => undefined);
  return next;
}

async function doLoad(ep: Ep | 'auto', previous: TwoStageModels | null): Promise<LoadOutcome> {
  previous?.detector.dispose();
  let d: FaceDetector | null;
  try {
    d = await timed(`face model load (${ep})`, () => FaceDetector.load(ep));
  } catch (err) {
    return { models: null, reason: `stage 2 failed to load: ${String(err instanceof Error ? err.message : err)}` };
  }
  if (!d) return { models: null, reason: 'no model deployed (public/models/facekp.onnx missing) — use the grid scanner' };
  const l = previous?.localizer.ep === d.ep ? previous.localizer : await timed(`cube box model load (${d.ep})`, () => CubeLocalizer.load(d.ep));
  if (previous && l !== previous.localizer) previous.localizer.dispose();
  if (!l) {
    d.dispose();
    return { models: null, reason: 'no stage-1 model deployed (public/models/cubebox.onnx missing) — no two-stage path; use the grid scanner' };
  }
  if (!d.cropTrained) {
    d.dispose();
    if (l !== previous?.localizer) l.dispose(); // a localizer loaded just for this pair leaks otherwise
    return { models: null, reason: `model ${d.modelId} is not crop-trained — the app only runs stage 2 on crops; re-export` };
  }
  return { models: { detector: d, localizer: l }, reason: null };
}

/** One line for a status box: which models, which EP, and the EP benchmark if 'auto' ran one. */
export function describeModels(m: TwoStageModels): string {
  const d = m.detector;
  const b = d.benchMs;
  const bench = b
    ? ` (bench: ${(['webgpu', 'wasm'] as const).filter((e) => b[e] !== undefined).map((e) => `${e} ${b[e]!.toFixed(1)}ms`).join(', ')})`
    : '';
  return `${m.localizer.modelId} → ${d.modelId}, ${d.ep}${d.anonymous ? ', anonymous quads' : ''}${bench}`;
}
