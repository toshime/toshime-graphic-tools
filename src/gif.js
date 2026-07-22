// GIF89a encoder with LZW compression. Frames must already share a palette of
// at most 255 colours; index 255 is reserved for transparency.

class BitWriter {
  constructor() {
    this.bytes = [];
    this.acc = 0;
    this.bits = 0;
  }
  write(code, len) {
    this.acc |= code << this.bits;
    this.bits += len;
    while (this.bits >= 8) {
      this.bytes.push(this.acc & 0xff);
      this.acc >>>= 8;
      this.bits -= 8;
    }
  }
  flush() {
    if (this.bits > 0) {
      this.bytes.push(this.acc & 0xff);
      this.acc = 0;
      this.bits = 0;
    }
  }
}

function lzwCompress(indices, minCodeSize) {
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;
  const bw = new BitWriter();
  let codeSize = minCodeSize + 1;
  let next = clearCode + 2;
  let dict = new Map();

  bw.write(clearCode, codeSize);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const key = (prefix << 8) | k;
    const found = dict.get(key);
    if (found !== undefined) {
      prefix = found;
      continue;
    }
    bw.write(prefix, codeSize);
    if (next < 4096) {
      dict.set(key, next++);
      if (next > (1 << codeSize) && codeSize < 12) codeSize++;
    } else {
      bw.write(clearCode, codeSize);
      dict = new Map();
      next = clearCode + 2;
      codeSize = minCodeSize + 1;
    }
    prefix = k;
  }
  bw.write(prefix, codeSize);
  bw.write(eoiCode, codeSize);
  bw.flush();
  return bw.bytes;
}

function subBlocks(bytes) {
  const out = [];
  for (let i = 0; i < bytes.length; i += 255) {
    const chunk = bytes.slice(i, i + 255);
    out.push(chunk.length, ...chunk);
  }
  out.push(0);
  return out;
}

/**
 * @param frames  ImageData[] already reduced to `palette`
 * @param palette [[r,g,b], ...], max 255 entries
 * @param opts    { delayMs, loop, alphaThreshold }
 */
export function encodeGif(frames, palette, { delayMs = 83, loop = 0, alphaThreshold = 128 } = {}) {
  if (!frames.length) throw new Error('no frames');
  const w = frames[0].width, h = frames[0].height;
  if (palette.length > 255) throw new Error('palette must be <= 255 colours');

  const transparentIndex = palette.length;
  const tableSize = Math.max(2, 1 << Math.ceil(Math.log2(Math.max(2, transparentIndex + 1))));
  const minCodeSize = Math.max(2, Math.log2(tableSize));

  const out = [];
  const pushStr = (s) => { for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i)); };
  const pushU16 = (v) => { out.push(v & 0xff, (v >> 8) & 0xff); };

  pushStr('GIF89a');
  pushU16(w);
  pushU16(h);
  out.push(0x80 | 0x70 | (Math.log2(tableSize) - 1)); // global table, 8-bit colour res
  out.push(0, 0);
  for (let i = 0; i < tableSize; i++) {
    const c = palette[i] || [0, 0, 0];
    out.push(c[0], c[1], c[2]);
  }

  // Netscape looping extension.
  out.push(0x21, 0xff, 11);
  pushStr('NETSCAPE2.0');
  out.push(3, 1, loop & 0xff, (loop >> 8) & 0xff, 0);

  const delay = Math.max(2, Math.round(delayMs / 10));
  const nearest = buildLookup(palette);
  for (const frame of frames) {
    const n = w * h;
    const indices = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      if (frame.data[i * 4 + 3] < alphaThreshold) {
        indices[i] = transparentIndex;
      } else {
        indices[i] = nearest(frame.data[i * 4], frame.data[i * 4 + 1], frame.data[i * 4 + 2]);
      }
    }

    // Graphic control extension: restore to background so transparency is
    // rebuilt each frame rather than smearing across the loop.
    out.push(0x21, 0xf9, 4, (2 << 2) | 1);
    pushU16(delay);
    out.push(transparentIndex, 0);

    out.push(0x2c);
    pushU16(0); pushU16(0); pushU16(w); pushU16(h);
    out.push(0);
    out.push(minCodeSize);
    out.push(...subBlocks(lzwCompress(indices, minCodeSize)));
  }

  out.push(0x3b);
  return new Blob([new Uint8Array(out)], { type: 'image/gif' });
}

function buildLookup(palette) {
  const cache = new Map();
  return (r, g, b) => {
    const key = (r << 16) | (g << 8) | b;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    let best = 0, bestD = Infinity;
    for (let i = 0; i < palette.length; i++) {
      const p = palette[i];
      const dr = r - p[0], dg = g - p[1], db = b - p[2];
      const d = dr * dr + dg * dg + db * db;
      if (d < bestD) { bestD = d; best = i; }
    }
    cache.set(key, best);
    return best;
  };
}
