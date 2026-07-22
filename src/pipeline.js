// Frame generation. Two modes share the same displacement fields:
//
//   warp - resample the source image through the field. This is the AllIn1
//          HandDrawn / Line Boiler behaviour: everything inside the picture
//          moves, stroke weight breathes, works on any artwork.
//
//   sdf  - quantise to N flat colour regions, turn each region into a signed
//          distance field, displace each independently, then let the most
//          "inside" region win per pixel. Edges stay crisp and stroke weight is
//          controllable, like displacing TextMeshPro vertices.

import { makeField } from './field.js';
import { buildLayers, sampleField } from './sdf.js';
import { medianCut, refinePalette, applyPalette, binarizeAlpha } from './quantize.js';

export const DEFAULTS = {
  mode: 'warp',
  fieldType: 'perlin',
  amount: 1.2,
  density: 0.35,
  jitter: 1,
  octaves: 1,
  seed: 1,
  frameCount: 4,
  fps: 12,
  pingPong: false,

  sampling: 'bilinear',
  padding: 8,
  scale: 1,
  pixelPerfect: false,
  pixelGrid: 1,

  alphaCrisp: false,
  quantEnabled: false,
  quantColors: 16,
  quantRefine: true,
  dither: 'none',
  ditherStrength: 1,

  sdfColors: 6,
  sdfWeight: 0,
  sdfSoftness: 1,
  sdfOutline: false,
  sdfOutlineWidth: 2,
  sdfDecorrelation: 0.5,
  alphaThreshold: 128,
};

/** Draws an image into an ImageData at the requested size, with padding. */
export function prepareSource(image, { scale = 1, padding = 0, sampling = 'bilinear' }) {
  const sw = Math.max(1, Math.round(image.width * scale));
  const sh = Math.max(1, Math.round(image.height * scale));
  const w = sw + padding * 2;
  const h = sh + padding * 2;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = sampling !== 'nearest';
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(image, padding, padding, sw, sh);
  return ctx.getImageData(0, 0, w, h);
}

function samplePixel(src, w, h, x, y, out, nearest) {
  const d = src.data;
  if (nearest) {
    const xi = Math.round(x), yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= w || yi >= h) { out[0] = out[1] = out[2] = out[3] = 0; return; }
    const i = (yi * w + xi) * 4;
    out[0] = d[i]; out[1] = d[i + 1]; out[2] = d[i + 2]; out[3] = d[i + 3];
    return;
  }
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  // Premultiply so transparent neighbours do not bleed their colour in.
  let r = 0, g = 0, b = 0, a = 0;
  for (let j = 0; j < 2; j++) {
    const yy = y0 + j;
    if (yy < 0 || yy >= h) continue;
    const wy = j ? fy : 1 - fy;
    for (let i2 = 0; i2 < 2; i2++) {
      const xx = x0 + i2;
      if (xx < 0 || xx >= w) continue;
      const wgt = (i2 ? fx : 1 - fx) * wy;
      if (wgt <= 0) continue;
      const p = (yy * w + xx) * 4;
      const pa = d[p + 3] / 255;
      r += d[p] * pa * wgt; g += d[p + 1] * pa * wgt; b += d[p + 2] * pa * wgt;
      a += pa * wgt;
    }
  }
  if (a <= 0.0001) { out[0] = out[1] = out[2] = out[3] = 0; return; }
  out[0] = r / a; out[1] = g / a; out[2] = b / a; out[3] = a * 255;
}

/**
 * Pixel-perfect displacement: the field is sampled once per grid cell (at the
 * cell centre) and the offset snapped to whole cells, so entire art pixels
 * move together and every output pixel stays an exact source pixel. Cells are
 * anchored at the padding origin so they line up with the artwork's grid.
 */
function snappedOffset(field, x, y, w, h, grid, padding) {
  const bx = Math.floor((x - padding) / grid);
  const by = Math.floor((y - padding) / grid);
  const [dx, dy] = field((padding + (bx + 0.5) * grid) / w, (padding + (by + 0.5) * grid) / h);
  return [Math.round((dx * w) / grid) * grid, Math.round((dy * h) / grid) * grid];
}

function renderWarpFrame(src, w, h, params, frame) {
  const field = makeField({ ...params, aspect: h / w }, frame, params.frameCount);
  const out = new ImageData(w, h);
  const pp = params.pixelPerfect;
  const grid = Math.max(1, Math.round(params.pixelGrid || 1));
  const nearest = pp || params.sampling === 'nearest';
  const px = new Float32Array(4);
  for (let y = 0; y < h; y++) {
    const v = y / h;
    for (let x = 0; x < w; x++) {
      let sx, sy;
      if (pp) {
        const [ox, oy] = snappedOffset(field, x, y, w, h, grid, params.padding);
        sx = x + ox; sy = y + oy;
      } else {
        const [dx, dy] = field(x / w, v);
        sx = x + dx * w; sy = y + dy * h;
      }
      samplePixel(src, w, h, sx, sy, px, nearest);
      const i = (y * w + x) * 4;
      out.data[i] = px[0]; out.data[i + 1] = px[1];
      out.data[i + 2] = px[2]; out.data[i + 3] = px[3];
    }
  }
  return out;
}

function renderSdfFrame(layers, palette, w, h, params, frame) {
  const out = new ImageData(w, h);
  const aspect = h / w;
  // One field per layer, decorrelated by seed so each colour region reads as a
  // separately redrawn shape. At decorrelation 0 they all move together.
  const fields = layers.map((layer, li) => makeField(
    { ...params, aspect, seed: params.seed + li * 977 * params.sdfDecorrelation },
    frame, params.frameCount,
  ));
  const soft = Math.max(0.01, params.sdfSoftness);
  const weight = params.sdfWeight;
  const outline = params.sdfOutline;
  const outlineW = Math.max(0.5, params.sdfOutlineWidth);
  const pp = params.pixelPerfect;
  const grid = Math.max(1, Math.round(params.pixelGrid || 1));

  if (pp) {
    // One decision per grid cell: displacement is constant across a cell and
    // the quantised art is cell-aligned, so evaluating layer membership at the
    // cell centre is exact — and stamping whole cells keeps overlaps between
    // independently-moving layers from cutting through the art grid.
    const pad = params.padding;
    const first = pad % grid;
    for (let cy = first - grid; cy < h; cy += grid) {
      for (let cx = first - grid; cx < w; cx += grid) {
        const x = Math.min(w - 1, Math.max(0, cx + (grid >> 1)));
        const y = Math.min(h - 1, Math.max(0, cy + (grid >> 1)));
        let bestD = -Infinity, bestLayer = -1;
        for (let li = 0; li < layers.length; li++) {
          const [ox, oy] = snappedOffset(fields[li], x, y, w, h, grid, pad);
          const sx = Math.min(w - 1, Math.max(0, x + ox));
          const sy = Math.min(h - 1, Math.max(0, y + oy));
          const d = layers[li].sdf[sy * w + sx] + weight;
          if (d > bestD) { bestD = d; bestLayer = li; }
        }
        if (bestLayer < 0) continue;
        const solid = outline ? bestD > 0 && bestD <= outlineW : bestD > 0;
        if (!solid) continue;
        const c = palette[layers[bestLayer].index];
        for (let y2 = Math.max(0, cy); y2 < Math.min(h, cy + grid); y2++) {
          for (let x2 = Math.max(0, cx); x2 < Math.min(w, cx + grid); x2++) {
            const i = (y2 * w + x2) * 4;
            out.data[i] = c[0]; out.data[i + 1] = c[1];
            out.data[i + 2] = c[2]; out.data[i + 3] = 255;
          }
        }
      }
    }
    return out;
  }

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let bestD = -Infinity, bestLayer = -1;
      for (let li = 0; li < layers.length; li++) {
        const [dx, dy] = fields[li](x / w, y / h);
        const d = sampleField(layers[li].sdf, w, h, x + dx * w, y + dy * h) + weight;
        if (d > bestD) { bestD = d; bestLayer = li; }
      }
      const i = (y * w + x) * 4;
      if (bestLayer < 0) continue;

      let alpha;
      if (outline) {
        // Band hugging the inside of each region's boundary.
        alpha = Math.min(bestD / soft + 0.5, (outlineW - bestD) / soft + 0.5);
      } else {
        alpha = bestD / soft + 0.5;
      }
      alpha = alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
      if (alpha <= 0) continue;
      const c = palette[layers[bestLayer].index];
      out.data[i] = c[0]; out.data[i + 1] = c[1]; out.data[i + 2] = c[2];
      out.data[i + 3] = Math.round(alpha * 255);
    }
  }
  return out;
}

const yieldToUI = () => new Promise((r) => setTimeout(r, 0));

/**
 * Generates all frames. Returns { frames, palette, width, height }.
 * `palette` is non-null whenever the output is indexed (needed for GIF).
 */
export async function generateFrames(source, rawParams, onProgress) {
  const params = { ...DEFAULTS, ...rawParams };
  const w = source.width, h = source.height;
  const frames = [];
  let palette = null;

  if (params.mode === 'sdf') {
    // The hybrid: quantise the *source* once, so every frame shares regions.
    const base = new ImageData(new Uint8ClampedArray(source.data), w, h);
    binarizeAlpha(base, params.alphaThreshold);
    palette = medianCut(base, params.sdfColors, params.alphaThreshold);
    if (params.quantRefine) palette = refinePalette(base, palette, 4, params.alphaThreshold);
    const indices = applyPalette(base, palette, 'none', 1, params.alphaThreshold);
    const alphaMask = new Uint8Array(w * h);
    for (let i = 0; i < alphaMask.length; i++) alphaMask[i] = base.data[i * 4 + 3] ? 1 : 0;
    const { layers } = buildLayers(indices, alphaMask, w, h, palette.length);

    for (let f = 0; f < params.frameCount; f++) {
      frames.push(renderSdfFrame(layers, palette, w, h, params, f));
      onProgress?.((f + 1) / params.frameCount);
      await yieldToUI();
    }
  } else {
    if (params.quantEnabled) {
      palette = medianCut(source, params.quantColors, params.alphaThreshold);
      if (params.quantRefine) palette = refinePalette(source, palette, 4, params.alphaThreshold);
    }
    for (let f = 0; f < params.frameCount; f++) {
      const frame = renderWarpFrame(source, w, h, params, f);
      if (params.alphaCrisp) binarizeAlpha(frame, params.alphaThreshold);
      if (palette) {
        applyPalette(frame, palette, params.dither, params.ditherStrength, params.alphaThreshold);
      }
      frames.push(frame);
      onProgress?.((f + 1) / params.frameCount);
      await yieldToUI();
    }
  }

  return { frames, palette, width: w, height: h };
}

/** Frame order for playback and export, honouring ping-pong. */
export function playbackOrder(count, pingPong) {
  const order = [...Array(count).keys()];
  if (pingPong && count > 2) {
    for (let i = count - 2; i >= 1; i--) order.push(i);
  }
  return order;
}
