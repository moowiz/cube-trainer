// Model-assisted suggestions for the labeler (label.html), on the app's own
// detection path. label.html used to carry hand-ported copies of the
// letterbox, decodeMaps, the Lab conversion and the centre naming, and ran
// stage 2 on the whole photo - which the crop-trained model cannot do. Now
// it calls window.__labelSuggest, which is detectTwoStage + nameQuads, the
// same functions the scan page runs on a camera frame.
import { loadTwoStage, type TwoStageModels } from './detect/models';
import { detectTwoStage } from './detect/twostage';
import type { FaceId } from './types';

export interface LabelSuggestion {
  /** Named faces with corners in photo px (the human still verifies). */
  faces: { face: FaceId; conf: number; corners: [number, number][] }[];
  /** Quads the model found but could not name (colour refused); shown for information. */
  unnamed: number;
  /** Stage 1's objectness; 0 faces with a low value means "no cube found", not "model unsure". */
  obj: number;
}

let models: TwoStageModels | null = null;

async function suggest(img: HTMLImageElement | HTMLCanvasElement): Promise<LabelSuggestion> {
  if (!models) {
    const outcome = await loadTwoStage('wasm');
    if (!outcome.models) throw new Error(outcome.reason);
    models = outcome.models;
  }
  const c = document.createElement('canvas');
  c.width = img instanceof HTMLImageElement ? img.naturalWidth : img.width;
  c.height = img instanceof HTMLImageElement ? img.naturalHeight : img.height;
  c.getContext('2d')!.drawImage(img, 0, 0);
  // Fresh exemplars per photo: each labeling photo is its own scene, the
  // scheme prior is the right starting point every time.
  models.detector.exemplars.reset();
  const tick = await detectTwoStage(models.localizer, models.detector, c);
  return {
    faces: (tick.result?.faces ?? []).map((f) => ({ face: f.face, conf: f.conf, corners: f.corners.map((p) => [p[0], p[1]]) })),
    unnamed: tick.result?.unnamed.length ?? 0,
    obj: tick.obj,
  };
}

(window as unknown as { __labelSuggest: typeof suggest }).__labelSuggest = suggest;
