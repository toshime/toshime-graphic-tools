// Region detection for KiriSketch. Turns one image into a list of boxes:
// either by finding connected islands of non-background pixels, or by slicing
// a regular grid. Everything here is pure geometry over an ImageData — no DOM.

/**
 * Guesses how the background is encoded by looking at the border ring.
 * Returns `{ mode: 'alpha' | 'color', color: [r,g,b] }`.
 */
export function autoBackground(img, alphaThreshold) {
  const { width: w, height: h, data } = img;
  const buckets = new Map();
  let transparent = 0;
  let total = 0;

  const sample = (x, y) => {
    const p = (y * w + x) * 4;
    total++;
    if (data[p + 3] < alphaThreshold) { transparent++; return; }
    // 4 bits per channel is coarse enough to survive JPEG noise.
    const key = ((data[p] >> 4) << 8) | ((data[p + 1] >> 4) << 4) | (data[p + 2] >> 4);
    let b = buckets.get(key);
    if (!b) { b = { n: 0, r: 0, g: 0, b: 0 }; buckets.set(key, b); }
    b.n++; b.r += data[p]; b.g += data[p + 1]; b.b += data[p + 2];
  };

  for (let x = 0; x < w; x++) { sample(x, 0); if (h > 1) sample(x, h - 1); }
  for (let y = 1; y < h - 1; y++) { sample(0, y); if (w > 1) sample(w - 1, y); }

  if (total === 0 || transparent / total > 0.5) return { mode: 'alpha', color: [0, 0, 0] };

  let best = null;
  for (const b of buckets.values()) if (!best || b.n > best.n) best = b;
  if (!best) return { mode: 'alpha', color: [0, 0, 0] };
  return {
    mode: 'color',
    color: [Math.round(best.r / best.n), Math.round(best.g / best.n), Math.round(best.b / best.n)],
  };
}

/**
 * Foreground mask, 1 byte per pixel. Transparent pixels are always background;
 * in `color` mode opaque pixels close to `bgColor` count as background too.
 */
export function buildMask(img, { mode, bgColor, tolerance, alphaThreshold }) {
  const { width: w, height: h, data } = img;
  const mask = new Uint8Array(w * h);
  const useColor = mode === 'color';
  const [br, bg, bb] = bgColor || [255, 255, 255];
  const tol2 = tolerance * tolerance * 3;

  for (let i = 0, p = 0; i < mask.length; i++, p += 4) {
    if (data[p + 3] < alphaThreshold) continue;
    if (useColor) {
      const dr = data[p] - br, dg = data[p + 1] - bg, db = data[p + 2] - bb;
      if (dr * dr + dg * dg + db * db <= tol2) continue;
    }
    mask[i] = 1;
  }
  return mask;
}

/**
 * 8-connected component labelling. Returns one bounding box per island,
 * `{ x, y, w, h, count }` with `count` = number of foreground pixels.
 */
export function labelRegions(mask, w, h) {
  const seen = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  const boxes = [];

  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    let sp = 0;
    stack[sp++] = start;
    seen[start] = 1;

    let x0 = start % w, x1 = x0;
    let y0 = (start / w) | 0, y1 = y0;
    let count = 0;

    while (sp) {
      const p = stack[--sp];
      count++;
      const px = p % w;
      const py = (p / w) | 0;
      if (px < x0) x0 = px; else if (px > x1) x1 = px;
      if (py > y1) y1 = py;   // scanning top-down, y0 can only be the seed row

      for (let dy = -1; dy <= 1; dy++) {
        const ny = py + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = px + dx;
          if (nx < 0 || nx >= w) continue;
          const q = ny * w + nx;
          if (mask[q] && !seen[q]) { seen[q] = 1; stack[sp++] = q; }
        }
      }
    }
    boxes.push({ x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1, count });
  }
  return boxes;
}

/** Gap between two boxes on one axis (0 when they overlap). */
function axisGap(a0, a1, b0, b1) {
  return Math.max(0, Math.max(a0, b0) - Math.min(a1, b1));
}

/**
 * Unions boxes that sit within `gap` px of each other, so a character whose
 * eyes/limbs are separate islands still exports as one sprite. Distances are
 * measured between the *original* islands, so the grouping is stable.
 */
export function mergeBoxes(boxes, gap) {
  if (gap <= 0 || boxes.length < 2) return boxes;

  const parent = boxes.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[rb] = ra; };

  for (let i = 0; i < boxes.length; i++) {
    const a = boxes[i];
    for (let j = i + 1; j < boxes.length; j++) {
      const b = boxes[j];
      if (axisGap(a.x, a.x + a.w, b.x, b.x + b.w) > gap) continue;
      if (axisGap(a.y, a.y + a.h, b.y, b.y + b.h) > gap) continue;
      union(i, j);
    }
  }

  const groups = new Map();
  for (let i = 0; i < boxes.length; i++) {
    const root = find(i);
    const b = boxes[i];
    const g = groups.get(root);
    if (!g) {
      groups.set(root, { x: b.x, y: b.y, x1: b.x + b.w, y1: b.y + b.h, count: b.count });
    } else {
      g.x = Math.min(g.x, b.x);
      g.y = Math.min(g.y, b.y);
      g.x1 = Math.max(g.x1, b.x + b.w);
      g.y1 = Math.max(g.y1, b.y + b.h);
      g.count += b.count;
    }
  }
  return [...groups.values()].map((g) => ({ x: g.x, y: g.y, w: g.x1 - g.x, h: g.y1 - g.y, count: g.count }));
}

/** Reading order: top-to-bottom by row band, left-to-right inside a row. */
export function sortReadingOrder(boxes) {
  const sorted = [...boxes].sort((a, b) => a.y - b.y || a.x - b.x);
  const rows = [];
  let cur = null;
  for (const b of sorted) {
    // A box starting past (row bottom − half the shortest member) opens a new row.
    if (!cur || b.y > cur.bottom - Math.min(b.h, cur.minH) * 0.5) {
      cur = { items: [b], bottom: b.y + b.h, minH: b.h };
      rows.push(cur);
    } else {
      cur.items.push(b);
      cur.bottom = Math.max(cur.bottom, b.y + b.h);
      cur.minH = Math.min(cur.minH, b.h);
    }
  }
  return rows.flatMap((r) => r.items.sort((a, b) => a.x - b.x));
}

/** Column-major twin of `sortReadingOrder`. */
export function sortColumnOrder(boxes) {
  const sorted = [...boxes].sort((a, b) => a.x - b.x || a.y - b.y);
  const cols = [];
  let cur = null;
  for (const b of sorted) {
    if (!cur || b.x > cur.right - Math.min(b.w, cur.minW) * 0.5) {
      cur = { items: [b], right: b.x + b.w, minW: b.w };
      cols.push(cur);
    } else {
      cur.items.push(b);
      cur.right = Math.max(cur.right, b.x + b.w);
      cur.minW = Math.min(cur.minW, b.w);
    }
  }
  return cols.flatMap((c) => c.items.sort((a, b) => a.y - b.y));
}

export function sortBoxes(boxes, order) {
  if (order === 'col') return sortColumnOrder(boxes);
  if (order === 'size') return [...boxes].sort((a, b) => b.w * b.h - a.w * a.h);
  return sortReadingOrder(boxes);
}

/**
 * Full auto-detect pass. `opts` mirrors the UI state; returns sorted boxes in
 * source-image pixel coordinates (no padding applied yet). Callers that
 * already built the mask can pass it in as `pre` to skip a second pass.
 */
export function detectRegions(img, opts, pre) {
  const bg = pre ? pre.background
    : opts.bgMode === 'auto' ? autoBackground(img, opts.alphaThreshold)
    : { mode: opts.bgMode, color: opts.bgColor };

  const mask = pre ? pre.mask : buildMask(img, {
    mode: bg.mode,
    bgColor: bg.color,
    tolerance: opts.tolerance,
    alphaThreshold: opts.alphaThreshold,
  });

  let boxes = labelRegions(mask, img.width, img.height);
  // Drop specks before the O(n²) merge so noise can't blow up the pass.
  boxes = boxes.filter((b) => b.w >= opts.minSize && b.h >= opts.minSize);
  boxes = mergeBoxes(boxes, opts.gap);
  boxes = boxes.filter((b) => b.w >= opts.minSize && b.h >= opts.minSize);
  return { boxes: sortBoxes(boxes, opts.sortOrder), background: bg };
}

/**
 * Regular grid slicing. Either a cell count (`gridMode: 'count'`) or a fixed
 * cell size in px, both with an origin offset and inter-cell spacing.
 */
export function gridRegions(width, height, opts) {
  const ox = Math.max(0, opts.offsetX | 0);
  const oy = Math.max(0, opts.offsetY | 0);
  const sx = Math.max(0, opts.spacingX | 0);
  const sy = Math.max(0, opts.spacingY | 0);

  let cols, rows, cw, ch;
  if (opts.gridMode === 'size') {
    cw = Math.max(1, opts.cellW | 0);
    ch = Math.max(1, opts.cellH | 0);
    cols = Math.max(1, Math.floor((width - ox + sx) / (cw + sx)));
    rows = Math.max(1, Math.floor((height - oy + sy) / (ch + sy)));
  } else {
    cols = Math.max(1, opts.cols | 0);
    rows = Math.max(1, opts.rows | 0);
    cw = Math.max(1, Math.floor((width - ox - sx * (cols - 1)) / cols));
    ch = Math.max(1, Math.floor((height - oy - sy * (rows - 1)) / rows));
  }

  const boxes = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = ox + c * (cw + sx);
      const y = oy + r * (ch + sy);
      if (x >= width || y >= height) continue;
      boxes.push({ x, y, w: Math.min(cw, width - x), h: Math.min(ch, height - y), count: 0 });
    }
  }
  return { boxes, cols, rows, cellW: cw, cellH: ch };
}

/**
 * Shrinks a box to the non-background content inside it. Returns null when the
 * box holds nothing at all (used to drop empty grid cells).
 */
export function trimBox(mask, imgW, box) {
  let x0 = box.x + box.w, y0 = box.y + box.h, x1 = box.x - 1, y1 = box.y - 1;
  for (let y = box.y; y < box.y + box.h; y++) {
    const row = y * imgW;
    for (let x = box.x; x < box.x + box.w; x++) {
      if (!mask[row + x]) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < x0 || y1 < y0) return null;
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1, count: box.count };
}

/** Grows a box by `pad` px on every side (clamping is the caller's business). */
export function padBox(box, pad) {
  if (!pad) return box;
  return { ...box, x: box.x - pad, y: box.y - pad, w: box.w + pad * 2, h: box.h + pad * 2 };
}
