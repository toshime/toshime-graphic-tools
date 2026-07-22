// Signed distance fields.
//
// TextMeshPro wobbles text by displacing the *vertices* of an SDF glyph, so the
// outline moves while edges stay crisp and stroke weight is preserved. A raster
// image has no vertices, but it can be turned into an SDF and displaced the same
// way: sample the field at a noise-offset position, then re-threshold. That is
// what the "outline" mode does.

const INF = 1e20;

/**
 * Felzenszwalb & Huttenlocher exact squared Euclidean distance transform.
 * `src` holds 0 for seed cells and INF elsewhere; result is squared distance
 * to the nearest seed. Operates in place on a copy.
 */
function edt(src, w, h) {
  const d = Float64Array.from(src);
  const n = Math.max(w, h);
  const f = new Float64Array(n);
  const dst = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);

  const pass = (len, get, set) => {
    for (let q = 0; q < len; q++) f[q] = get(q);
    let k = 0;
    v[0] = 0;
    z[0] = -INF;
    z[1] = INF;
    for (let q = 1; q < len; q++) {
      let s;
      // Walk back over parabolas this one occludes.
      for (;;) {
        const p = v[k];
        s = (f[q] + q * q - (f[p] + p * p)) / (2 * q - 2 * p);
        if (s > z[k]) break;
        k--;
      }
      k++;
      v[k] = q;
      z[k] = s;
      z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < len; q++) {
      while (z[k + 1] < q) k++;
      const p = v[k];
      dst[q] = (q - p) * (q - p) + f[p];
    }
    for (let q = 0; q < len; q++) set(q, dst[q]);
  };

  for (let x = 0; x < w; x++) {
    pass(h, (y) => d[y * w + x], (y, val) => { d[y * w + x] = val; });
  }
  for (let y = 0; y < h; y++) {
    const row = y * w;
    pass(w, (x) => d[row + x], (x, val) => { d[row + x] = val; });
  }
  return d;
}

/**
 * Signed distance in pixels for a binary mask (Uint8Array, 1 = inside).
 * Positive inside, negative outside, ~0 on the boundary.
 */
export function signedDistance(mask, w, h) {
  const n = w * h;
  const inSeed = new Float64Array(n);
  const outSeed = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    if (mask[i]) { inSeed[i] = 0; outSeed[i] = INF; }
    else { inSeed[i] = INF; outSeed[i] = 0; }
  }
  // distToOutside is only meaningful inside, distToInside only outside.
  const dOut = edt(outSeed, w, h); // distance to nearest outside cell
  const dIn = edt(inSeed, w, h);   // distance to nearest inside cell
  const sd = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    sd[i] = mask[i] ? Math.sqrt(dOut[i]) : -Math.sqrt(dIn[i]);
  }
  return sd;
}

/** Bilinear sample of a Float32 field, clamped at the borders. */
export function sampleField(field, w, h, x, y) {
  const cx = x < 0 ? 0 : x > w - 1 ? w - 1 : x;
  const cy = y < 0 ? 0 : y > h - 1 ? h - 1 : y;
  const x0 = Math.floor(cx), y0 = Math.floor(cy);
  const x1 = x0 + 1 < w ? x0 + 1 : x0;
  const y1 = y0 + 1 < h ? y0 + 1 : y0;
  const fx = cx - x0, fy = cy - y0;
  const a = field[y0 * w + x0], b = field[y0 * w + x1];
  const c = field[y1 * w + x0], d = field[y1 * w + x1];
  return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
}

/**
 * Splits an indexed image into one SDF per palette entry, plus an SDF for the
 * opaque region. Layers with no pixels are dropped.
 *
 * This is the multi-colour hybrid: quantise first so the image becomes a small
 * set of flat regions, then treat every region as its own shape to wobble.
 */
export function buildLayers(indices, alphaMask, w, h, paletteSize) {
  const counts = new Int32Array(paletteSize);
  for (let i = 0; i < indices.length; i++) {
    if (alphaMask[i]) counts[indices[i]]++;
  }
  const layers = [];
  for (let p = 0; p < paletteSize; p++) {
    if (counts[p] === 0) continue;
    const mask = new Uint8Array(w * h);
    for (let i = 0; i < mask.length; i++) {
      mask[i] = alphaMask[i] && indices[i] === p ? 1 : 0;
    }
    layers.push({ index: p, area: counts[p], sdf: signedDistance(mask, w, h) });
  }
  // Largest region first so ties resolve toward the background.
  layers.sort((a, b) => b.area - a.area);
  return { layers, alphaSdf: signedDistance(alphaMask, w, h) };
}
