// loadTwoStage: the "no learned path" outcomes (stage 2 missing, stage 1
// missing, stage 2 not crop-trained), reload disposal/reuse, and load
// serialization. facekp.ts and cubebox.ts both import onnxruntime-web, so
// they are mocked wholesale rather than loaded - FaceDetector.load and
// CubeLocalizer.load become vi.fn()s this file controls per test.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/detect/facekp', () => ({
  FaceDetector: { load: vi.fn() },
}));
vi.mock('../src/detect/cubebox', () => ({
  CubeLocalizer: { load: vi.fn() },
}));

import { CubeLocalizer } from '../src/detect/cubebox';
import type { Ep } from '../src/detect/facekp';
import { FaceDetector } from '../src/detect/facekp';
import { loadTwoStage } from '../src/detect/models';
import type { TwoStageModels } from '../src/detect/models';

const detectorLoad = vi.mocked(FaceDetector.load);
const localizerLoad = vi.mocked(CubeLocalizer.load);

function makeDetector(overrides: { ep?: Ep; cropTrained?: boolean; modelId?: string } = {}) {
  return {
    dispose: vi.fn(),
    ep: overrides.ep ?? 'wasm',
    cropTrained: overrides.cropTrained ?? true,
    modelId: overrides.modelId ?? 'ft7 ep12 fp32',
  } as unknown as FaceDetector;
}

function makeLocalizer(overrides: { ep?: Ep } = {}) {
  return {
    dispose: vi.fn(),
    ep: overrides.ep ?? 'wasm',
  } as unknown as CubeLocalizer;
}

describe('loadTwoStage', () => {
  beforeEach(() => {
    detectorLoad.mockReset();
    localizerLoad.mockReset();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('stage 2 missing: FaceDetector.load resolves null', async () => {
    detectorLoad.mockResolvedValueOnce(null);
    const out = await loadTwoStage('wasm');
    expect(out.models).toBeNull();
    expect(out.reason).toMatch(/facekp\.onnx/);
    expect(localizerLoad).not.toHaveBeenCalled();
  });

  it('stage 1 missing: CubeLocalizer.load resolves null, the detector is disposed', async () => {
    const d = makeDetector();
    detectorLoad.mockResolvedValueOnce(d);
    localizerLoad.mockResolvedValueOnce(null);
    const out = await loadTwoStage('wasm');
    expect(out.models).toBeNull();
    expect(out.reason).toMatch(/cubebox\.onnx/);
    expect(d.dispose).toHaveBeenCalledTimes(1);
  });

  it('stage 2 without the crop stamp: the detector and the localizer loaded for it are both disposed', async () => {
    const d = makeDetector({ cropTrained: false, modelId: 'ft3 ep9 fp32' });
    const l = makeLocalizer();
    detectorLoad.mockResolvedValueOnce(d);
    localizerLoad.mockResolvedValueOnce(l);
    const out = await loadTwoStage('wasm');
    expect(out.models).toBeNull();
    expect(out.reason).toMatch(/crop-trained/);
    expect(out.reason).toMatch(/ft3 ep9 fp32/);
    expect(d.dispose).toHaveBeenCalledTimes(1);
    expect(l.dispose).toHaveBeenCalledTimes(1); // it was loaded for this pair alone; nothing else holds it
  });

  it('a load that throws is reported, not rejected', async () => {
    detectorLoad.mockRejectedValueOnce(new Error('boom'));
    const out = await loadTwoStage('wasm');
    expect(out.models).toBeNull();
    expect(out.reason).toBe('stage 2 failed to load: boom');
  });

  it('success: both models come back with reason null', async () => {
    const d = makeDetector({ ep: 'webgpu' });
    const l = makeLocalizer({ ep: 'webgpu' });
    detectorLoad.mockResolvedValueOnce(d);
    localizerLoad.mockResolvedValueOnce(l);
    const out = await loadTwoStage('webgpu');
    expect(out.reason).toBeNull();
    expect(out.models).toEqual({ detector: d, localizer: l });
  });

  it('reload disposes the previous detector and reuses the previous localizer when its ep matches', async () => {
    const prevDetector = makeDetector({ ep: 'wasm' });
    const prevLocalizer = makeLocalizer({ ep: 'wasm' });
    const previous: TwoStageModels = { detector: prevDetector, localizer: prevLocalizer };
    const newDetector = makeDetector({ ep: 'wasm' });
    detectorLoad.mockResolvedValueOnce(newDetector);
    const out = await loadTwoStage('wasm', previous);
    expect(prevDetector.dispose).toHaveBeenCalledTimes(1);
    expect(localizerLoad).not.toHaveBeenCalled(); // eps matched: no reload needed
    expect(prevLocalizer.dispose).not.toHaveBeenCalled();
    expect(out.models).toEqual({ detector: newDetector, localizer: prevLocalizer });
  });

  it('reload disposes the previous localizer when the new detector picked a different ep', async () => {
    const prevDetector = makeDetector({ ep: 'wasm' });
    const prevLocalizer = makeLocalizer({ ep: 'wasm' });
    const previous: TwoStageModels = { detector: prevDetector, localizer: prevLocalizer };
    const newDetector = makeDetector({ ep: 'webgpu' });
    const newLocalizer = makeLocalizer({ ep: 'webgpu' });
    detectorLoad.mockResolvedValueOnce(newDetector);
    localizerLoad.mockResolvedValueOnce(newLocalizer);
    const out = await loadTwoStage('webgpu', previous);
    expect(localizerLoad).toHaveBeenCalledWith('webgpu');
    expect(prevLocalizer.dispose).toHaveBeenCalledTimes(1);
    expect(out.models).toEqual({ detector: newDetector, localizer: newLocalizer });
  });

  it('serializes loads: a second load does not call FaceDetector.load until the first settles', async () => {
    let resolveFirst!: (d: FaceDetector) => void;
    const first$ = new Promise<FaceDetector>((res) => { resolveFirst = res; });
    detectorLoad.mockImplementationOnce(() => first$);
    detectorLoad.mockResolvedValueOnce(makeDetector({ ep: 'webgpu' }));

    const first = loadTwoStage('wasm');
    const second = loadTwoStage('webgpu');

    // flush microtasks so the first load has had the chance to call FaceDetector.load
    await new Promise((r) => setTimeout(r, 0));
    expect(detectorLoad).toHaveBeenCalledTimes(1);

    resolveFirst(makeDetector({ ep: 'wasm' }));
    await first;
    await second;
    expect(detectorLoad).toHaveBeenCalledTimes(2);
  });

  it('a rejected first load does not block the second', async () => {
    detectorLoad.mockRejectedValueOnce(new Error('nope'));
    detectorLoad.mockResolvedValueOnce(null);
    const r1 = await loadTwoStage('wasm');
    expect(r1.reason).toBe('stage 2 failed to load: nope');
    const r2 = await loadTwoStage('wasm');
    expect(r2.reason).toMatch(/facekp\.onnx/);
  });
});
