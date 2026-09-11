// Procedural background textures drawn on a 2D canvas. Grids and tiles are
// deliberately over-represented: per MILESTONES M3 they are the hard negatives
// (bathroom tiles, keyboards) the detector must learn to reject.

function hsl(h, s, l) {
  return `hsl(${((h % 360) + 360) % 360}, ${Math.round(s * 100)}%, ${Math.round(l * 100)}%)`;
}

/** rnd: () => float in [0,1). Returns an HTMLCanvasElement. */
export function proceduralBackground(rnd, w = 512, h = 512) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  const kind = pick(rnd, ['grid', 'grid', 'tiles', 'tiles', 'checker', 'stripes', 'gradient', 'solid', 'speckle']);
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
