// Procedural background textures drawn on a 2D canvas. Grids and tiles are
// deliberately over-represented: per MILESTONES M3 they are the hard negatives
// (bathroom tiles, keyboards) the detector must learn to reject.

function hsl(h, s, l) {
  return `hsl(${((h % 360) + 360) % 360}, ${Math.round(s * 100)}%, ${Math.round(l * 100)}%)`;
}
function hsla(h, s, l, a) {
  return `hsla(${((h % 360) + 360) % 360}, ${Math.round(s * 100)}%, ${Math.round(l * 100)}%, ${a})`;
}
const clampL = (l) => Math.min(0.97, Math.max(0.03, l));

// Soft fold shading, shared by the cloth kinds: wide blurred dark curves.
function softFolds(ctx, rnd, w, h) {
  ctx.filter = `blur(${4 + rnd() * 8}px)`;
  for (let i = 0; i < 4 + rnd() * 8; i++) {
    ctx.strokeStyle = `rgba(0,0,0,${0.08 + rnd() * 0.22})`;
    ctx.lineWidth = 3 + rnd() * 14;
    ctx.beginPath();
    const x0 = rnd() * w, y0 = rnd() * h;
    ctx.moveTo(x0, y0);
    ctx.quadraticCurveTo(x0 + (rnd() - 0.5) * w, y0 + (rnd() - 0.5) * h, rnd() * w, rnd() * h);
    ctx.stroke();
  }
  ctx.filter = 'none';
}

// Run `draw` with the canvas rotated about its centre. Woven patterns
// (shirts, blankets, tablecloths) are almost never axis-aligned to the
// camera the way tiles and keyboards are, so the plaid family goes through
// this; `draw` receives a rect that covers the canvas at any angle.
function rotated(ctx, rnd, w, h, draw) {
  const angle = rnd() < 0.35 ? 0 : (rnd() - 0.5) * Math.PI / 2;
  const r = Math.ceil(Math.hypot(w, h) / 2);
  ctx.save();
  ctx.translate(w / 2, h / 2);
  ctx.rotate(angle);
  draw(-r, -r, 2 * r, 2 * r);
  ctx.restore();
}

// A tartan sett: 3-6 bands of random width and colour, repeated. Drawn
// horizontally, then vertically with multiply blending so the crossings
// darken like woven threads. The same band list both ways (a true tartan)
// most of the time, an independent one otherwise (madras, shirt checks).
function plaidBands(rnd, baseHue, baseL) {
  const n = 3 + Math.floor(rnd() * 4);
  const bands = [];
  for (let i = 0; i < n; i++) {
    const width = 3 + rnd() * rnd() * 60; // mostly thin, a few wide
    const hueShift = rnd() < 0.5 ? (rnd() - 0.5) * 40 : rnd() * 360;
    bands.push({
      width,
      color: hsla(baseHue + hueShift, 0.25 + rnd() * 0.6, clampL(baseL + (rnd() - 0.5) * 0.7), 0.55 + rnd() * 0.45),
    });
  }
  return bands;
}
function drawBands(ctx, bands, x0, y0, W, Hh, vertical) {
  const period = bands.reduce((a, b) => a + b.width, 0);
  const len = vertical ? W : Hh;
  for (let p = 0; p < len; p += period) {
    let q = p;
    for (const b of bands) {
      ctx.fillStyle = b.color;
      if (vertical) ctx.fillRect(x0 + q, y0, b.width + 0.5, Hh); else ctx.fillRect(x0, y0 + q, W, b.width + 0.5);
      q += b.width;
    }
  }
}

// Houndstooth as it is actually woven: 4-dark/4-light warp and weft in a 2/2
// twill. Rendered thread-by-thread into a tiny tile, then scaled up with
// smoothing off so the teeth stay crisp, or on for the blurry-at-distance
// look.
function houndstoothTile(dark, light, threads = 4) {
  const n = threads * 2;
  const c = document.createElement('canvas');
  c.width = n; c.height = n;
  const g = c.getContext('2d');
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const warpDark = Math.floor(x / threads) % 2 === 0;
      const weftDark = Math.floor(y / threads) % 2 === 0;
      const warpOnTop = (x + y) % 4 < 2;
      g.fillStyle = (warpOnTop ? warpDark : weftDark) ? dark : light;
      g.fillRect(x, y, 1, 1);
    }
  }
  return c;
}

/** rnd: () => float in [0,1). Returns an HTMLCanvasElement. */
export function proceduralBackground(rnd, w = 512, h = 512) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  // DECISION: plaid/gingham/houndstooth/argyle join the list at a combined
  // weight matching grid+tiles. They are the cloth version of the same hard
  // negative - a regular lattice of coloured squares (flannel shirts,
  // picnic blankets, tablecloths) - and the detector had never seen one.
  const kind = pick(rnd, ['grid', 'grid', 'tiles', 'tiles', 'checker', 'stripes', 'gradient', 'solid', 'speckle', 'fabric', 'fabric', 'fabric',
    'plaid', 'plaid', 'gingham', 'houndstooth', 'argyle']);
  const baseHue = rnd() * 360;
  const baseL = 0.15 + rnd() * 0.65;
  ctx.fillStyle = hsl(baseHue, 0.05 + rnd() * 0.4, baseL);
  ctx.fillRect(0, 0, w, h);

  switch (kind) {
    case 'grid': {
      // Ruled lines both ways — keyboard edges, notebook grids, window frames.
      const spacing = 14 + rnd() * 70;
      const lw = 1 + rnd() * 5;
      const dark = rnd() < 0.5;
      ctx.strokeStyle = hsl(baseHue + rnd() * 40 - 20, 0.1 + rnd() * 0.3, dark ? Math.max(0.03, baseL - 0.25) : Math.min(0.95, baseL + 0.25));
      ctx.lineWidth = lw;
      const off = rnd() * spacing;
      for (let x = off; x < w; x += spacing) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
      for (let y = off; y < h; y += spacing) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
      break;
    }
    case 'tiles': {
      // Bathroom: big squares separated by grout.
      const tile = 40 + rnd() * 110;
      const grout = 2 + rnd() * 6;
      ctx.fillStyle = hsl(baseHue, 0.05 + rnd() * 0.2, Math.max(0.05, baseL - 0.15 - rnd() * 0.15));
      ctx.fillRect(0, 0, w, h);
      const tileL = Math.min(0.95, baseL + 0.1);
      for (let y = 0; y < h; y += tile + grout) {
        for (let x = 0; x < w; x += tile + grout) {
          ctx.fillStyle = hsl(baseHue + rnd() * 8, 0.05 + rnd() * 0.25, tileL + (rnd() - 0.5) * 0.06);
          ctx.fillRect(x, y, tile, tile);
        }
      }
      break;
    }
    case 'checker': {
      const s = 20 + rnd() * 60;
      const c2 = hsl(baseHue + (rnd() < 0.3 ? 180 : 20), 0.1 + rnd() * 0.4, baseL < 0.5 ? baseL + 0.3 : baseL - 0.3);
      ctx.fillStyle = c2;
      for (let y = 0, j = 0; y < h; y += s, j++) {
        for (let x = j % 2 ? s : 0; x < w; x += 2 * s) ctx.fillRect(x, y, s, s);
      }
      break;
    }
    case 'stripes': {
      const s = 10 + rnd() * 50;
      const vert = rnd() < 0.5;
      for (let i = 0; i < (vert ? w : h); i += 2 * s) {
        ctx.fillStyle = hsl(baseHue + rnd() * 15, 0.1 + rnd() * 0.35, baseL + (rnd() - 0.5) * 0.2);
        if (vert) ctx.fillRect(i, 0, s, h); else ctx.fillRect(0, i, w, s);
      }
      break;
    }
    case 'gradient': {
      const g = ctx.createLinearGradient(rnd() * w, 0, w - rnd() * w, h);
      g.addColorStop(0, hsl(baseHue, 0.2 + rnd() * 0.4, baseL));
      g.addColorStop(1, hsl(baseHue + 30 + rnd() * 60, 0.2 + rnd() * 0.4, Math.max(0.05, baseL - 0.3)));
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
      break;
    }
    case 'speckle': {
      const n = 200 + rnd() * 1200;
      for (let i = 0; i < n; i++) {
        ctx.fillStyle = hsl(baseHue + rnd() * 60, rnd() * 0.5, rnd());
        const r = 1 + rnd() * 4;
        ctx.beginPath();
        ctx.arc(rnd() * w, rnd() * h, r, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    }
    case 'fabric': {
      // Crumpled cloth (duvet, blanket, couch throw): bright, low-contrast,
      // soft folds. The detector collapsed on real bed scenes because every
      // procedural background here had hard edges - cloth has none.
      const l0 = 0.45 + rnd() * 0.45; // usually bright, like bedding
      const sat = rnd() * 0.18;
      ctx.fillStyle = hsl(baseHue, sat, l0);
      ctx.fillRect(0, 0, w, h);
      // smooth tonal blotches
      for (let i = 0; i < 35; i++) {
        const x = rnd() * w, y = rnd() * h, r = (0.06 + rnd() * 0.3) * w;
        const dl = (rnd() - 0.5) * 0.16;
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        const c = hsl(baseHue + (rnd() - 0.5) * 20, sat, Math.min(0.97, Math.max(0.05, l0 + dl)));
        g.addColorStop(0, c.replace('hsl', 'hsla').replace(')', `, ${0.25 + rnd() * 0.45})`));
        g.addColorStop(1, c.replace('hsl', 'hsla').replace(')', ', 0)'));
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, w, h);
      }
      // soft dark fold creases: wide blurred curved strokes
      softFolds(ctx, rnd, w, h);
      break;
    }
    case 'plaid': {
      // Tartan / flannel / madras. Horizontal bands, then vertical bands
      // multiplied over them; optional fine twill diagonals on top.
      const bandsA = plaidBands(rnd, baseHue, baseL);
      const bandsB = rnd() < 0.7 ? bandsA : plaidBands(rnd, baseHue, baseL);
      rotated(ctx, rnd, w, h, (x0, y0, W, Hh) => {
        ctx.fillStyle = hsl(baseHue, 0.1 + rnd() * 0.5, baseL);
        ctx.fillRect(x0, y0, W, Hh);
        drawBands(ctx, bandsA, x0, y0, W, Hh, false);
        ctx.globalCompositeOperation = 'multiply';
        drawBands(ctx, bandsB, x0, y0, W, Hh, true);
        ctx.globalCompositeOperation = 'source-over';
        if (rnd() < 0.5) {
          // twill: faint diagonal hatching, the weave texture of flannel
          ctx.strokeStyle = `rgba(${rnd() < 0.5 ? '0,0,0' : '255,255,255'},${0.05 + rnd() * 0.1})`;
          ctx.lineWidth = 1;
          const step = 3 + rnd() * 4;
          for (let d = -Hh; d < W + Hh; d += step) {
            ctx.beginPath(); ctx.moveTo(x0 + d, y0); ctx.lineTo(x0 + d + Hh, y0 + Hh); ctx.stroke();
          }
        }
      });
      if (rnd() < 0.6) softFolds(ctx, rnd, w, h);
      break;
    }
    case 'gingham': {
      // Two-colour check woven into three tones: colour where both threads
      // are dyed, half-tone where one is, ground where neither. Small = shirt
      // gingham, large = buffalo check / picnic blanket.
      const s = rnd() < 0.5 ? 6 + rnd() * 20 : 30 + rnd() * 90;
      const hue = rnd() < 0.7 ? baseHue : rnd() * 360;
      const sat = 0.4 + rnd() * 0.6;
      const ground = rnd() < 0.75 ? clampL(0.8 + rnd() * 0.17) : clampL(baseL);
      const ink = hsla(hue, sat, 0.2 + rnd() * 0.35, 0.55 + rnd() * 0.15);
      rotated(ctx, rnd, w, h, (x0, y0, W, Hh) => {
        ctx.fillStyle = hsl(hue, sat * 0.15, ground);
        ctx.fillRect(x0, y0, W, Hh);
        ctx.fillStyle = ink;
        for (let x = 0; x < W; x += 2 * s) ctx.fillRect(x0 + x, y0, s, Hh);
        for (let y = 0; y < Hh; y += 2 * s) ctx.fillRect(x0, y0 + y, W, s);
      });
      if (rnd() < 0.5) softFolds(ctx, rnd, w, h);
      break;
    }
    case 'houndstooth': {
      const l1 = clampL(baseL);
      const dark = hsl(baseHue, 0.05 + rnd() * 0.3, l1 < 0.5 ? l1 : l1 - 0.45);
      const light = hsl(baseHue + (rnd() - 0.5) * 30, 0.05 + rnd() * 0.3, l1 < 0.5 ? l1 + 0.45 : l1);
      const tile = houndstoothTile(dark, light);
      const scale = 2 + rnd() * rnd() * 14; // px per thread: fine cloth to a coat at arm's length
      rotated(ctx, rnd, w, h, (x0, y0, W, Hh) => {
        ctx.imageSmoothingEnabled = rnd() < 0.5;
        const n = tile.width * scale;
        for (let y = 0; y < Hh; y += n) for (let x = 0; x < W; x += n) ctx.drawImage(tile, x0 + x, y0 + y, n, n);
        ctx.imageSmoothingEnabled = true;
      });
      if (rnd() < 0.5) softFolds(ctx, rnd, w, h);
      break;
    }
    case 'argyle': {
      // Diamonds in 2-3 colours with thin contrasting lines through their
      // centres: a checkerboard drawn at ~45 deg and stretched vertically.
      const dw = 30 + rnd() * 70;
      const stretch = 1.2 + rnd() * 0.8;
      const cols = [hsl(baseHue, 0.3 + rnd() * 0.5, clampL(baseL)),
        hsl(baseHue + 150 + rnd() * 60, 0.3 + rnd() * 0.5, clampL(baseL + (rnd() < 0.5 ? 0.35 : -0.35))),
        hsl(baseHue + (rnd() - 0.5) * 60, 0.1 + rnd() * 0.3, clampL(baseL + (rnd() - 0.5) * 0.5))];
      const ncol = rnd() < 0.5 ? 2 : 3;
      const line = rnd() < 0.5 ? 'rgba(255,255,255,0.7)' : 'rgba(0,0,0,0.6)';
      ctx.save();
      ctx.translate(w / 2, h / 2);
      ctx.rotate((rnd() - 0.5) * 0.4);
      ctx.scale(1, stretch);
      ctx.rotate(Math.PI / 4);
      const r = Math.ceil(Math.hypot(w, h));
      ctx.fillStyle = cols[0];
      ctx.fillRect(-r, -r, 2 * r, 2 * r);
      let j = 0;
      for (let y = -r; y < r; y += dw, j++) {
        for (let x = -r, i = 0; x < r; x += dw, i++) {
          const k = ncol === 2 ? (i + j) % 2 : ((i + j) % 2 ? 1 : (i % 2 ? 0 : 2));
          if (k === 0) continue;
          ctx.fillStyle = cols[k];
          ctx.fillRect(x, y, dw + 0.5, dw + 0.5);
        }
      }
      ctx.strokeStyle = line;
      ctx.lineWidth = 1 + rnd() * 1.5;
      ctx.setLineDash(rnd() < 0.5 ? [] : [3, 3]);
      for (let p = -r + dw / 2; p < r; p += dw) {
        ctx.beginPath(); ctx.moveTo(p, -r); ctx.lineTo(p, r); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(-r, p); ctx.lineTo(r, p); ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.restore();
      if (rnd() < 0.5) softFolds(ctx, rnd, w, h);
      break;
    }
    case 'solid':
    default:
      break;
  }

  // Soft vignette so backgrounds aren't uniformly lit.
  if (rnd() < 0.6) {
    const v = ctx.createRadialGradient(w / 2, h / 2, w * 0.2, w / 2, h / 2, w * 0.8);
    v.addColorStop(0, 'rgba(0,0,0,0)');
    v.addColorStop(1, `rgba(0,0,0,${0.15 + rnd() * 0.4})`);
    ctx.fillStyle = v;
    ctx.fillRect(0, 0, w, h);
  }
  return canvas;
}

export function pick(rnd, arr) {
  return arr[Math.floor(rnd() * arr.length)];
}
