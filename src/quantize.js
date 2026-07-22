// Colour reduction: median cut palette + optional k-means refinement,
// with ordered / error-diffusion dithering. Roughly the feature set of
// raky.net/color-quantizer, applied to every generated frame with a shared
// palette so sprite sheets and GIFs stay consistent.

const BAYER4 = [
  [0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5],
];
const BAYER8 = (() => {
  // Recursive construction of the 8x8 ordered dither matrix.
  const m = Array.from({ length: 8 }, () => new Array(8).fill(0));
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      m[y][x] = BAYER4[y & 3][x & 3] * 4 + BAYER4[y >> 2][x >> 2];
    }
  }
  return m;
})();

/** Median cut over the opaque pixels of an ImageData. Returns [[r,g,b], ...]. */
export function medianCut(imageData, maxColors, alphaThreshold = 128) {
  const { data, width, height } = imageData;
  const pixels = [];
  for (let i = 0; i < width * height; i++) {
    if (data[i * 4 + 3] >= alphaThreshold) {
      pixels.push([data[i * 4], data[i * 4 + 1], data[i * 4 + 2]]);
    }
  }
  if (pixels.length === 0) return [[0, 0, 0]];

  let boxes = [pixels];
  while (boxes.length < maxColors) {
    // Split the box with the widest channel spread.
    let bestIdx = -1, bestRange = 0, bestCh = 0;
    for (let b = 0; b < boxes.length; b++) {
      const box = boxes[b];
      if (box.length < 2) continue;
      for (let ch = 0; ch < 3; ch++) {
        let lo = 255, hi = 0;
        for (const px of box) {
          if (px[ch] < lo) lo = px[ch];
          if (px[ch] > hi) hi = px[ch];
        }
        const range = hi - lo;
        if (range > bestRange) { bestRange = range; bestIdx = b; bestCh = ch; }
      }
    }
    if (bestIdx < 0) break;
    const box = boxes[bestIdx];
    box.sort((a, b) => a[bestCh] - b[bestCh]);
    const mid = box.length >> 1;
    boxes.splice(bestIdx, 1, box.slice(0, mid), box.slice(mid));
  }

  return boxes.filter((b) => b.length).map((box) => {
    let r = 0, g = 0, b = 0;
    for (const px of box) { r += px[0]; g += px[1]; b += px[2]; }
    const n = box.length;
    return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
  });
}

/** A few Lloyd iterations to tighten a median-cut palette. */
export function refinePalette(imageData, palette, iterations = 4, alphaThreshold = 128) {
  const { data, width, height } = imageData;
  const k = palette.length;
  let pal = palette.map((c) => c.slice());
  for (let it = 0; it < iterations; it++) {
    const sums = Array.from({ length: k }, () => [0, 0, 0, 0]);
    for (let i = 0; i < width * height; i++) {
      if (data[i * 4 + 3] < alphaThreshold) continue;
      const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
      const idx = nearestIndex(pal, r, g, b);
      const s = sums[idx];
      s[0] += r; s[1] += g; s[2] += b; s[3]++;
    }
    let moved = false;
    pal = pal.map((c, i) => {
      const s = sums[i];
      if (!s[3]) return c;
      const next = [Math.round(s[0] / s[3]), Math.round(s[1] / s[3]), Math.round(s[2] / s[3])];
      if (next[0] !== c[0] || next[1] !== c[1] || next[2] !== c[2]) moved = true;
      return next;
    });
    if (!moved) break;
  }
  return pal;
}

export function nearestIndex(palette, r, g, b) {
  let best = 0, bestD = Infinity;
  for (let i = 0; i < palette.length; i++) {
    const p = palette[i];
    const dr = r - p[0], dg = g - p[1], db = b - p[2];
    // Weighted to approximate perceived difference.
    const d = dr * dr * 0.299 + dg * dg * 0.587 + db * db * 0.114;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

/**
 * Maps an ImageData onto `palette` in place and returns the per-pixel index
 * array. `dither` is 'none' | 'bayer4' | 'bayer8' | 'floyd'.
 */
export function applyPalette(imageData, palette, dither = 'none', strength = 1, alphaThreshold = 128) {
  const { data, width, height } = imageData;
  const indices = new Uint8Array(width * height);

  if (dither === 'floyd') {
    // Error diffusion needs float accumulation, so work on a copy.
    const buf = new Float32Array(width * height * 3);
    for (let i = 0; i < width * height; i++) {
      buf[i * 3] = data[i * 4];
      buf[i * 3 + 1] = data[i * 4 + 1];
      buf[i * 3 + 2] = data[i * 4 + 2];
    }
    const push = (i, er, eg, eb, f) => {
      buf[i * 3] += er * f; buf[i * 3 + 1] += eg * f; buf[i * 3 + 2] += eb * f;
    };
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        const r = buf[i * 3], g = buf[i * 3 + 1], b = buf[i * 3 + 2];
        const idx = nearestIndex(palette, r, g, b);
        indices[i] = idx;
        const p = palette[idx];
        if (data[i * 4 + 3] < alphaThreshold) continue;
        const er = (r - p[0]) * strength, eg = (g - p[1]) * strength, eb = (b - p[2]) * strength;
        if (x + 1 < width) push(i + 1, er, eg, eb, 7 / 16);
        if (y + 1 < height) {
          if (x > 0) push(i + width - 1, er, eg, eb, 3 / 16);
          push(i + width, er, eg, eb, 5 / 16);
          if (x + 1 < width) push(i + width + 1, er, eg, eb, 1 / 16);
        }
      }
    }
  } else {
    const matrix = dither === 'bayer4' ? BAYER4 : dither === 'bayer8' ? BAYER8 : null;
    const size = dither === 'bayer4' ? 4 : 8;
    const levels = matrix ? size * size : 1;
    // Spread proportional to how coarse the palette is.
    const spread = (matrix ? 255 / Math.cbrt(palette.length) : 0) * strength * 0.6;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        let r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
        if (matrix) {
          const t = (matrix[y % size][x % size] / levels - 0.5) * spread;
          r += t; g += t; b += t;
        }
        indices[i] = nearestIndex(palette, r, g, b);
      }
    }
  }

  for (let i = 0; i < width * height; i++) {
    const p = palette[indices[i]];
    data[i * 4] = p[0]; data[i * 4 + 1] = p[1]; data[i * 4 + 2] = p[2];
  }
  return indices;
}

/** Hard-cuts alpha to 0/255. Needed for GIF and for clean SDF layering. */
export function binarizeAlpha(imageData, threshold = 128) {
  const { data } = imageData;
  for (let i = 3; i < data.length; i += 4) {
    data[i] = data[i] >= threshold ? 255 : 0;
  }
}
