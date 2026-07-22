// Output writers. These take generated frames (ImageData[]) and turn them into
// downloadable blobs: single PNGs, a numbered-PNG ZIP, a packed sprite sheet,
// or an animated GIF. Frame ordering (ping-pong) is the caller's job for GIF;
// PNG/sheet exports always use the raw frame list.

import { createZip } from './zip.js';
import { encodeGif } from './gif.js';
import { medianCut, applyPalette } from './quantize.js';

/** ImageData -> PNG bytes via the canvas encoder. */
export async function imageDataToPng(imageData) {
  const canvas = document.createElement('canvas');
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  canvas.getContext('2d').putImageData(imageData, 0, 0);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}

function frameName(i) {
  return `frame_${String(i).padStart(2, '0')}.png`;
}

/**
 * Nearest-neighbour integer upscale of every frame. Used to blow small pixel
 * art up to a social-media-friendly size without blurring. `factor` must be a
 * positive integer; factor 1 returns the frames untouched.
 */
export function upscaleFrames(frames, factor) {
  const f = Math.max(1, Math.round(factor));
  if (f === 1) return frames;
  return frames.map((frame) => {
    const src = document.createElement('canvas');
    src.width = frame.width;
    src.height = frame.height;
    src.getContext('2d').putImageData(frame, 0, 0);

    const dst = document.createElement('canvas');
    dst.width = frame.width * f;
    dst.height = frame.height * f;
    const dctx = dst.getContext('2d');
    dctx.imageSmoothingEnabled = false;
    dctx.drawImage(src, 0, 0, dst.width, dst.height);
    return dctx.getImageData(0, 0, dst.width, dst.height);
  });
}

/** Raw frames -> ZIP of frame_00.png, frame_01.png ... (no ping-pong). */
export async function exportPngSequence(frames) {
  const entries = [];
  for (let i = 0; i < frames.length; i++) {
    entries.push({ name: frameName(i), data: await imageDataToPng(frames[i]) });
  }
  return createZip(entries);
}

/**
 * Packs the raw frames into a grid `columns` wide. Returns the sheet PNG blob
 * plus a metadata JSON string describing each cell.
 */
export async function exportSpriteSheet(frames, { columns, fps, pingPong }) {
  const frameCount = frames.length;
  const cols = Math.max(1, Math.min(columns | 0 || frameCount, frameCount));
  const rows = Math.ceil(frameCount / cols);
  const fw = frames[0].width;
  const fh = frames[0].height;

  const canvas = document.createElement('canvas');
  canvas.width = cols * fw;
  canvas.height = rows * fh;
  const ctx = canvas.getContext('2d');

  const cells = [];
  for (let i = 0; i < frameCount; i++) {
    const x = (i % cols) * fw;
    const y = Math.floor(i / cols) * fh;
    ctx.putImageData(frames[i], x, y);
    cells.push({ x, y, w: fw, h: fh });
  }

  const sheetBlob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  const meta = {
    frameWidth: fw,
    frameHeight: fh,
    frameCount,
    columns: cols,
    rows,
    fps,
    pingPong,
    frames: cells,
  };
  return { sheetBlob, metaJson: JSON.stringify(meta, null, 2) };
}

// Stack frames vertically into one ImageData so a single palette covers them all.
function mergeFrames(frames) {
  const w = frames[0].width;
  const merged = new ImageData(w, frames[0].height * frames.length);
  let offset = 0;
  for (const f of frames) {
    merged.data.set(f.data, offset);
    offset += f.data.length;
  }
  return merged;
}

/**
 * Encodes a GIF. `frames` must already be in playback order. When `palette` is
 * null (plain warp output) a shared 255-colour palette is built and applied.
 */
export function exportGif(frames, palette, { fps, alphaThreshold = 128 } = {}) {
  let pal = palette;
  let out = frames;
  if (!pal) {
    pal = medianCut(mergeFrames(frames), 255, alphaThreshold);
    out = frames.map((f) => {
      const copy = new ImageData(new Uint8ClampedArray(f.data), f.width, f.height);
      applyPalette(copy, pal, 'none', 1, alphaThreshold);
      return copy;
    });
  }
  return encodeGif(out, pal, { delayMs: 1000 / fps, loop: 0, alphaThreshold });
}
