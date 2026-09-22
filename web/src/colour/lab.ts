// CIE Lab: the colour space every comparison in this app is made in
// (CLAUDE.md: "Colors are compared in Lab, never RGB or raw HSV"). Pure
// functions on plain numbers, so they test without a camera.

import type { Lab } from '../types';

// ---------- sRGB (0-255) -> CIE Lab, D65 ----------

export function srgbToLab(r: number, g: number, b: number): Lab {
  const lin = (c: number) => {
    c /= 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return linearRgbToLab(lin(r), lin(g), lin(b));
}

/** Linear sRGB (0-1, D65 primaries) -> CIE Lab. */
export function linearRgbToLab(rl: number, gl: number, bl: number): Lab {
  let x = 0.4124564 * rl + 0.3575761 * gl + 0.1804375 * bl;
  const y = 0.2126729 * rl + 0.7151522 * gl + 0.072175 * bl;
  let z = 0.0193339 * rl + 0.119192 * gl + 0.9503041 * bl;
  x /= 0.95047;
  z /= 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);
  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

/** CIE Lab (D65) -> sRGB 0-255, clamped; the inverse of srgbToLab, for showing measured colours. */
export function labToSrgb(lab: Lab): [number, number, number] {
  const fy = (lab.L + 16) / 116;
  const fx = fy + lab.a / 500;
  const fz = fy - lab.b / 200;
  const finv = (t: number) => (t > 0.206893 ? t * t * t : (t - 16 / 116) / 7.787);
  const x = finv(fx) * 0.95047;
  const y = finv(fy);
  const z = finv(fz) * 1.08883;
  const rl = 3.2404542 * x - 1.5371385 * y - 0.4985314 * z;
  const gl = -0.969266 * x + 1.8760108 * y + 0.041556 * z;
  const bl = 0.0556434 * x - 0.2040259 * y + 1.0572252 * z;
  const gam = (c: number) => {
    const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(Math.max(c, 0), 1 / 2.4) - 0.055;
    return Math.round(Math.min(255, Math.max(0, v * 255)));
  };
  return [gam(rl), gam(gl), gam(bl)];
}

export function labDistance(p: Lab, q: Lab): number {
  const dL = p.L - q.L;
  const da = p.a - q.a;
  const db = p.b - q.b;
  return Math.sqrt(dL * dL + da * da + db * db);
}

/** Component-wise median — robust per-cell color over a window of frames. */
export function labMedian(samples: readonly Lab[]): Lab {
  if (samples.length === 0) throw new Error('labMedian: empty input');
  const med = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
  };
  return {
    L: med(samples.map((s) => s.L)),
    a: med(samples.map((s) => s.a)),
    b: med(samples.map((s) => s.b)),
  };
}

/** Component-wise mean. */
export function labMean(samples: readonly Lab[]): Lab {
  if (samples.length === 0) throw new Error('labMean: empty input');
  let L = 0;
  let a = 0;
  let b = 0;
  for (const s of samples) {
    L += s.L;
    a += s.a;
    b += s.b;
  }
  const n = samples.length;
  return { L: L / n, a: a / n, b: b / n };
}

// DECISION: a face is hopeless only when it is BOTH dark (median L < 22) and
