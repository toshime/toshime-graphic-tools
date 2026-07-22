// Displacement fields. Each returns a per-pixel UV offset in normalized units
// (1.0 == full image width/height), which the pipeline scales to pixels.
//
// The "hand drawn" feel comes from time quantisation, not from the field shape:
// a `floor(time * ...)` snaps the distortion between a small number of discrete
// states instead of sliding continuously. We do the same by giving each frame
// its own decorrelated slice of the noise volume.

import { makeNoise } from './noise.js';

export const FIELD_TYPES = [
  { id: 'sine', label: 'Sine wave (sin/cos)', hint: '縦横の帯状に揺れるサイン波。時間で階段状に切り替わる' },
  { id: 'perlin', label: 'Perlin flow', hint: '有機的なうねり。線画にもイラストにも' },
  { id: 'ripple', label: 'Ripple', hint: '中心から同心円状に波打つ' },
  { id: 'tremble', label: 'Tremble', hint: '絵全体が平行移動+微回転。紙が震える感じ' },
];

/**
 * Frame f gets a z-slice of the noise volume. `jitter` controls how far apart
 * consecutive slices are: 0 = smooth drift through the volume (frames are a
 * continuous cycle), 1 = slices so far apart they are uncorrelated (classic
 * line boil, every frame an independent redraw).
 */
export function frameZ(frame, jitter) {
  const step = 0.35 + jitter * jitter * 260;
  return frame * step;
}

/**
 * Builds a sampler `(u, v) => [dx, dy]` for one frame.
 * u/v are normalized image coords. Offsets are normalized too.
 */
export function makeField(params, frame, frameCount) {
  const {
    fieldType, amount, density, jitter, seed, octaves = 1,
    aspect = 1,
  } = params;

  const z = frameZ(frame, jitter);
  const noise = makeNoise(seed);

  switch (fieldType) {
    case 'sine': {
      // Sine/cosine UV wobble, snapped in time. `amount` drives both the
      // frequency and the magnitude of the displacement, and the final blend
      // weight is 0.0005 * amount; we keep that shape but rescale so the UI
      // slider spans a useful range.
      const a = amount * 20;
      const w = 0.0005 * a;
      // Discrete per-frame phase, standing in for the shader's floor(_Time...).
      const s = (frame / Math.max(1, frameCount)) * 40 * (0.2 + jitter) + seed * 7.13;
      const f = 4 * (0.25 + density * 0.75);
      return (u, v) => [
        Math.sin((u * a + s) * f) * w,
        Math.cos((v * a + s) * f) * w,
      ];
    }

    case 'perlin': {
      // The note.com TMP approach: perlin-driven displacement, quantised in time.
      const scale = 2 + density * 22;
      const w = amount * 0.02;
      return (u, v) => [
        noise.fbm(u * scale, v * scale * aspect, z, octaves) * w,
        noise.fbm(u * scale + 91.7, v * scale * aspect - 31.4, z + 55.3, octaves) * w,
      ];
    }

    case 'ripple': {
      const freq = (2 + density * 18) * Math.PI * 2;
      const w = amount * 0.03;
      // Phase and centre wander a little per frame so it does not look mechanical.
      const phase = noise.noise3(z * 0.37, 0, 0) * Math.PI * 2 + z * 0.9;
      const cx = 0.5 + noise.noise3(0, z * 0.21, 0) * 0.05;
      const cy = 0.5 + noise.noise3(0, 0, z * 0.21) * 0.05;
      return (u, v) => {
        const dx = u - cx, dy = (v - cy) * aspect;
        const d = Math.hypot(dx, dy);
        if (d < 1e-5) return [0, 0];
        const m = Math.sin(d * freq - phase) * w;
        return [(dx / d) * m, (dy / d) * m];
      };
    }

    case 'tremble': {
      // Rigid body jitter: translation + a touch of rotation about the centre.
      const t = amount * 0.02;
      const tx = noise.noise3(z, 0, 0) * t;
      const ty = noise.noise3(0, z, 0) * t;
      const rot = noise.noise3(0, 0, z) * amount * 0.012 * (0.2 + density);
      const cos = Math.cos(rot), sin = Math.sin(rot);
      return (u, v) => {
        const dx = u - 0.5, dy = v - 0.5;
        return [dx * cos - dy * sin - dx + tx, dx * sin + dy * cos - dy + ty];
      };
    }

    default:
      return () => [0, 0];
  }
}

/** Line Boiler-style one-click looks. Merged over the current params. */
export const PRESETS = {
  fineJitter: { label: 'Fine Jitter', fieldType: 'perlin', amount: 0.5, density: 0.7, jitter: 1, frameCount: 3, octaves: 2 },
  chunkyWarp: { label: 'Chunky Warp', fieldType: 'perlin', amount: 2.6, density: 0.12, jitter: 1, frameCount: 3, octaves: 1 },
  ripple: { label: 'Ripple', fieldType: 'ripple', amount: 1.2, density: 0.25, jitter: 0.15, frameCount: 8, octaves: 1 },
  tremble: { label: 'Tremble', fieldType: 'tremble', amount: 1.0, density: 0.5, jitter: 1, frameCount: 4, octaves: 1 },
  lineboil: { label: 'Line Boil', fieldType: 'sine', amount: 1.4, density: 0.5, jitter: 0.5, frameCount: 4, octaves: 1 },
};
