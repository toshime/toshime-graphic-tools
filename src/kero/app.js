// けろけろ UI. Loads one image, drops it to a chosen resolution, then prints
// it with a handful of flat colours through うごメモ-style screen patterns.
// Everything runs in the page — no build step, no deps.

import { PATTERNS, PATTERN_BY_ID, DEFAULT_BRUSHES, DOT_BRUSHES, LADDER_ORDER, maskAt } from './patterns.js';
import { resizeImage, adjust, buildCandidates, ditherToPatterns } from './dither.js';
import { medianCut, refinePalette } from '../quantize.js';
import { createStageView } from '../viewer.js';

// ---- palette presets ------------------------------------------------------
// うごメモ本体の色。DSi 版は flipnote.js の PPM パレット、3D 版は KWZ パレット。
const PALETTE_PRESETS = [
  { name: 'うごメモDSi', paper: '#ffffff', colors: ['#ffffff', '#0e0e0e', '#ff2a2a', '#0a39ff'] },
  { name: 'うごメモ3D', paper: '#ffffff', colors: ['#ffffff', '#101010', '#ff1010', '#ffe700', '#008631', '#0038ce'] },
  { name: 'モノクロ', paper: '#ffffff', colors: ['#ffffff', '#0e0e0e'] },
  { name: '黒と赤', paper: '#ffffff', colors: ['#ffffff', '#0e0e0e', '#ff2a2a'] },
  { name: '黒と青', paper: '#ffffff', colors: ['#ffffff', '#0e0e0e', '#0a39ff'] },
  { name: '黒い紙', paper: '#0e0e0e', colors: ['#0e0e0e', '#ffffff', '#ff2a2a', '#0a39ff'] },
];

// ---- defaults / state -----------------------------------------------------
const DEFAULTS = {
  // resolution
  outW: 256,
  outH: 192,
  lockAspect: true,
  resize: 'line',          // 'line' | 'smooth' | 'nearest'

  // colours
  palette: PALETTE_PRESETS[0].colors.map((hex) => ({ hex, on: true })),
  paper: '#ffffff',
  alphaMode: 'keep',       // 'keep' | 'paper'
  alphaThreshold: 128,
  edgeDither: false,
  extractCount: 4,

  // brushes
  brushes: [...DEFAULT_BRUSHES],
  tileScale: 1,
  ditherAmount: 1,

  // adjust
  brightness: 0,
  contrast: 0,
  gamma: 1,
  edge: 0,
  outline: 0,
  errorMix: 0,

  // export
  exportScale: 1,
};

const BOOL_PARAMS = new Set(['lockAspect', 'edgeDither']);
const STR_PARAMS = new Set(['resize', 'paper', 'alphaMode']);
// Not bound to a [data-param] input — these have their own bits of UI.
const CUSTOM_PARAMS = new Set(['palette', 'brushes']);
// The output size follows whatever image is loaded, so persisting it would
// just fight the next drop.
const SKIP_SAVE = new Set(['outW', 'outH']);
// Only affect how the finished image is written out.
const RENDER_ONLY = new Set(['exportScale']);

const state = structuredClone(DEFAULTS);

let sourceImage = null;   // HTMLImageElement
let srcData = null;       // ImageData at natural size
let result = null;        // ImageData of the dithered output
let baseName = 'image';

// ---- element refs ---------------------------------------------------------
const $ = (sel) => document.querySelector(sel);
const stage = $('#stage');
const canvas = $('#previewCanvas');
const ctx = canvas.getContext('2d');
const dropzone = $('#dropzone');
const fileInput = $('#fileInput');

let showOriginal = false;

// プレビューの拡大・移動（ホイール / ドラッグ / ピンチ）。
// 網を非整数倍でニアレスト拡大すると、点の間隔が場所ごとに 1px ずれてモアレに
// なる。等倍以上は整数倍に丸めて、実際の目の並びをそのまま見せる。
const view = createStageView({
  stage,
  canvas,
  zoomGroup: $('#zoomGroup'),
  onChange: () => drawPreview(),
  fitMax: 16,
  minZoom: 0.02,
  snap: (z, kind) => (z < 1 ? z : kind === 'fit' ? Math.floor(z) : Math.round(z)),
});

// ---------------------------------------------------------------------------
// Colour helpers
// ---------------------------------------------------------------------------
function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return [0, 0, 0];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex([r, g, b]) {
  return `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
}

function activeColors() {
  const list = state.palette.filter((c) => c.on).map((c) => hexToRgb(c.hex));
  // Something has to be printable, so fall back to the paper colour.
  return list.length ? list : [hexToRgb(state.paper)];
}

function activeBrushes() {
  return LADDER_ORDER.filter((id) => state.brushes.includes(id)).map((id) => PATTERN_BY_ID.get(id));
}

// ---------------------------------------------------------------------------
// Two-way binding between [data-param] inputs and `state`
// ---------------------------------------------------------------------------
function readInput(el) {
  const p = el.dataset.param;
  if (BOOL_PARAMS.has(p)) return el.checked;
  if (STR_PARAMS.has(p)) return el.value;
  return Number(el.value);
}

function formatVal(v) {
  if (typeof v !== 'number') return String(v);
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

function syncControls() {
  document.querySelectorAll('[data-param]').forEach((el) => {
    const p = el.dataset.param;
    if (CUSTOM_PARAMS.has(p)) return;
    const v = state[p];
    if (BOOL_PARAMS.has(p)) el.checked = !!v;
    else el.value = v;
    const disp = el.parentElement.querySelector(`[data-for="${p}"]`);
    if (disp) disp.textContent = formatVal(v);
  });
  renderPalette();
  renderBrushes();
  updateSizeLabels();
}

function bindInputs() {
  document.querySelectorAll('[data-param]').forEach((el) => {
    const evt = el.type === 'range' || el.type === 'number' || el.type === 'color' ? 'input' : 'change';
    el.addEventListener(evt, () => {
      const p = el.dataset.param;
      state[p] = readInput(el);
      if (p === 'outW' || p === 'outH') applyAspect(p);
      document.querySelectorAll(`[data-for="${p}"]`).forEach((d) => { d.textContent = formatVal(state[p]); });
      if (p === 'paper') renderBrushes();
      updateSizeLabels();
      if (RENDER_ONLY.has(p)) drawPreview();
      else scheduleRender();
    });
  });
}

/** Keeps the other side of the output size in step when the ratio is locked. */
function applyAspect(changed) {
  state.outW = clampSize(state.outW);
  state.outH = clampSize(state.outH);
  if (!state.lockAspect || !srcData) return;
  const ratio = srcData.height / srcData.width;
  if (changed === 'outW') state.outH = clampSize(Math.round(state.outW * ratio));
  else state.outW = clampSize(Math.round(state.outH / ratio));
  document.querySelectorAll('[data-param="outW"]').forEach((el) => { el.value = state.outW; });
  document.querySelectorAll('[data-param="outH"]').forEach((el) => { el.value = state.outH; });
}

function clampSize(v) {
  return Math.min(4096, Math.max(1, Math.round(Number(v) || 1)));
}

function updateSizeLabels() {
  const src = srcData ? `${srcData.width}×${srcData.height} → ` : '';
  $('#sizeInfo').textContent = srcData ? `${src}${state.outW}×${state.outH}` : '–';
  const s = state.exportScale;
  $('#exportSize').textContent = `${state.outW * s}×${state.outH * s}${s > 1 ? ` (${s}倍)` : ''}`;
}

// ---------------------------------------------------------------------------
// Palette editor
// ---------------------------------------------------------------------------
function renderPalettePresets() {
  const row = $('#palettePresets');
  row.innerHTML = '';
  for (const preset of PALETTE_PRESETS) {
    const b = document.createElement('button');
    b.className = 'preset-btn';
    b.textContent = preset.name;
    b.addEventListener('click', () => {
      state.palette = preset.colors.map((hex) => ({ hex, on: true }));
      state.paper = preset.paper;
      syncControls();
      scheduleRender();
    });
    row.appendChild(b);
  }
}

function renderPalette() {
  const list = $('#palList');
  list.innerHTML = '';
  state.palette.forEach((entry, i) => {
    const row = document.createElement('div');
    row.className = 'pal-row';
    row.classList.toggle('off', !entry.on);

    const on = document.createElement('input');
    on.type = 'checkbox';
    on.checked = entry.on;
    on.title = 'この色を使う';
    on.addEventListener('change', () => {
      entry.on = on.checked;
      row.classList.toggle('off', !entry.on);
      renderBrushes();
      scheduleRender();
    });

    const pick = document.createElement('input');
    pick.type = 'color';
    pick.className = 'bg-color';
    pick.value = entry.hex;
    pick.addEventListener('input', () => {
      entry.hex = pick.value;
      hex.textContent = entry.hex.toUpperCase();
      renderBrushes();
      scheduleRender();
    });

    const hex = document.createElement('span');
    hex.className = 'pal-hex';
    hex.textContent = entry.hex.toUpperCase();

    const del = document.createElement('button');
    del.className = 'mini-btn';
    del.textContent = '×';
    del.title = 'この色を消す';
    del.addEventListener('click', () => {
      state.palette.splice(i, 1);
      renderPalette();
      renderBrushes();
      scheduleRender();
    });

    row.append(on, pick, hex, del);
    list.appendChild(row);
  });
}

// ---------------------------------------------------------------------------
// Brush picker
// ---------------------------------------------------------------------------
const BRUSH_PREVIEW = 24;   // logical px; CSS blows it up 2x, pixelated

/** Draws one brush as it would print: ink over the paper colour. */
function drawBrushPreview(c, pattern) {
  const paper = hexToRgb(state.paper);
  // Ink = whichever enabled colour is furthest from the paper, so the preview
  // reflects the palette the user is actually working with.
  let ink = [0, 0, 0];
  let best = -1;
  for (const col of activeColors()) {
    const d = (col[0] - paper[0]) ** 2 + (col[1] - paper[1]) ** 2 + (col[2] - paper[2]) ** 2;
    if (d > best) { best = d; ink = col; }
  }
  const g = c.getContext('2d');
  const img = g.createImageData(BRUSH_PREVIEW, BRUSH_PREVIEW);
  for (let y = 0; y < BRUSH_PREVIEW; y++) {
    for (let x = 0; x < BRUSH_PREVIEW; x++) {
      const col = maskAt(pattern, x, y, state.tileScale) ? ink : paper;
      const p = (y * BRUSH_PREVIEW + x) * 4;
      img.data[p] = col[0]; img.data[p + 1] = col[1]; img.data[p + 2] = col[2]; img.data[p + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
}

function renderBrushes() {
  const grid = $('#brushGrid');
  grid.innerHTML = '';
  for (const p of PATTERNS) {
    const b = document.createElement('button');
    b.className = 'brush';
    b.dataset.brush = p.id;
    b.classList.toggle('on', state.brushes.includes(p.id));

    const c = document.createElement('canvas');
    c.width = BRUSH_PREVIEW;
    c.height = BRUSH_PREVIEW;
    drawBrushPreview(c, p);

    const name = document.createElement('span');
    name.className = 'brush-name';
    name.textContent = p.name;

    const den = document.createElement('span');
    den.className = 'brush-density';
    den.textContent = `${Math.round(p.density * 100)}%`;

    b.append(c, name, den);
    b.addEventListener('click', () => toggleBrush(p.id));
    grid.appendChild(b);
  }
}

function toggleBrush(id) {
  const i = state.brushes.indexOf(id);
  if (i >= 0) state.brushes.splice(i, 1);
  else state.brushes.push(id);
  const btn = $(`.brush[data-brush="${id}"]`);
  if (btn) btn.classList.toggle('on', i < 0);
  scheduleRender();
}

function setBrushes(ids) {
  state.brushes = [...ids];
  renderBrushes();
  scheduleRender();
}

/** After a render, show which brushes actually made it into the picture. */
function showUsage(usage, total) {
  document.querySelectorAll('.brush').forEach((b) => {
    b.classList.toggle('used', (usage.get(b.dataset.brush) || 0) > 0);
  });
  if (!total) { $('#usageInfo').textContent = ''; return; }
  const rows = [...usage.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id, n]) => `${PATTERN_BY_ID.get(id)?.name ?? id} ${Math.round(n / total * 100)}%`);
  let inked = 0;
  for (const n of usage.values()) inked += n;
  const flat = Math.round((total - inked) / total * 100);
  $('#usageInfo').textContent = rows.length
    ? `使われた網: ${rows.join(' / ')}　ベタ ${flat}%`
    : 'すべてベタ塗りです。網を増やすか「なじませ」を上げると中間の濃さが出ます。';
}

// ---------------------------------------------------------------------------
// Config persistence (localStorage)
// ---------------------------------------------------------------------------
const STORAGE_KEY = 'amisketch:params';   // 保存ずみの設定を捨てないよう、鍵は昔のまま
let statusTimer = 0;

function flashStatus(msg) {
  const el = $('#configStatus');
  el.textContent = msg;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => { el.textContent = ''; }, 2000);
}

function saveConfig() {
  const params = {};
  for (const k of Object.keys(DEFAULTS)) {
    if (!SKIP_SAVE.has(k)) params[k] = state[k];
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(params));
    flashStatus('✓ 保存しました');
  } catch (e) {
    flashStatus('保存できませんでした');
  }
}

function loadConfig() {
  let raw;
  try { raw = localStorage.getItem(STORAGE_KEY); } catch (e) { return; }
  if (!raw) return;
  let saved;
  try { saved = JSON.parse(raw); } catch (e) { return; }

  // Only accept keys we know, and sanity-check the two structured ones, so an
  // old or hand-edited payload can't inject junk into the render.
  for (const k of Object.keys(DEFAULTS)) {
    if (SKIP_SAVE.has(k) || saved[k] === undefined) continue;
    if (k === 'palette') {
      if (!Array.isArray(saved.palette)) continue;
      const clean = saved.palette
        .filter((c) => c && /^#[0-9a-f]{6}$/i.test(c.hex))
        .map((c) => ({ hex: c.hex, on: c.on !== false }));
      if (clean.length) state.palette = clean;
    } else if (k === 'brushes') {
      if (!Array.isArray(saved.brushes)) continue;
      const known = saved.brushes.filter((id) => PATTERN_BY_ID.has(id));
      // ブラシの id を変えた版の保存データだと空になるので、そのときは初期値。
      state.brushes = known.length ? known : [...DEFAULT_BRUSHES];
    } else {
      state[k] = saved[k];
    }
  }
}

function resetConfig() {
  const { outW, outH } = state;
  Object.assign(state, structuredClone(DEFAULTS), { outW, outH });
  try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* ignore */ }
  syncControls();
  scheduleRender();
  flashStatus('初期値に戻しました');
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------
let renderTimer = null;
function scheduleRender() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(render, 180);
}

function render() {
  if (!srcData) return;

  const small = resizeImage(srcData, state.outW, state.outH, state.resize);
  adjust(small, {
    brightness: state.brightness,
    contrast: state.contrast,
    gamma: state.gamma,
    edge: state.edge,
    outline: state.outline,
  });

  const candidates = buildCandidates(activeColors(), activeBrushes());
  const out = ditherToPatterns(small, {
    candidates,
    tileScale: state.tileScale,
    amount: state.ditherAmount,
    errorMix: state.errorMix,
    alphaThreshold: state.alphaThreshold,
    keepAlpha: state.alphaMode === 'keep',
    paper: hexToRgb(state.paper),
    edgeDither: state.edgeDither,
  });

  result = out.image;
  showUsage(out.usage, small.width * small.height);
  updateSizeLabels();
  drawPreview();
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------
function drawPreview() {
  if (!result && !sourceImage) return;
  const showSrc = showOriginal && sourceImage;
  const w = showSrc ? sourceImage.width : result.width;
  const h = showSrc ? sourceImage.height : result.height;
  const z = view.zoomFor(w, h);

  canvas.classList.remove('empty');
  canvas.width = Math.max(1, Math.round(w * z));
  canvas.height = Math.max(1, Math.round(h * z));
  // 縮小表示のときだけ補間をかける。1px の網を間引いて見せるとまだら
  // になるので、ならして灰色に見せたほうが実際の見た目に近い。
  ctx.imageSmoothingEnabled = z < 1;
  ctx.imageSmoothingQuality = 'high';
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (showSrc) {
    ctx.drawImage(sourceImage, 0, 0, canvas.width, canvas.height);
    return;
  }
  // The result is a small ImageData; go through a 1x canvas so the zoom stays
  // a clean nearest-neighbour blow-up.
  const base = document.createElement('canvas');
  base.width = result.width;
  base.height = result.height;
  base.getContext('2d').putImageData(result, 0, 0);
  ctx.drawImage(base, 0, 0, canvas.width, canvas.height);
}

// ---------------------------------------------------------------------------
// Image loading
// ---------------------------------------------------------------------------
function loadImageFromFile(file) {
  if (!file || !file.type.startsWith('image/')) return;
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    URL.revokeObjectURL(url);
    sourceImage = img;
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const cctx = c.getContext('2d', { willReadFrequently: true });
    cctx.drawImage(img, 0, 0);
    srcData = cctx.getImageData(0, 0, img.width, img.height);

    // A new image brings its own size; anything else stays as the user left it.
    state.outW = clampSize(img.width);
    state.outH = clampSize(img.height);
    syncControls();

    baseName = sanitizeBase(file.name);
    $('#baseName').value = baseName;
    dropzone.classList.add('hidden');
    render();
  };
  img.onerror = () => { URL.revokeObjectURL(url); console.error('failed to load image'); };
  img.src = url;
}

/** "art (1).png" -> "art_1" — safe for a download filename. */
function sanitizeBase(name) {
  const stem = String(name || '').replace(/\.[^.]+$/, '');
  const clean = stem.replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
  return clean || 'image';
}

function setSizePreset(kind) {
  if (!srcData) return;
  const ratio = srcData.height / srcData.width;
  if (kind === 'orig') { state.outW = clampSize(srcData.width); state.outH = clampSize(srcData.height); }
  else if (kind === 'dsi') { state.outW = 256; state.outH = 192; }
  else if (/^w\d+$/.test(kind)) {
    const w = Number(kind.slice(1));
    state.outW = clampSize(w);
    state.outH = clampSize(w * ratio);
  }
  else {
    const f = Number(kind);
    state.outW = clampSize(srcData.width * f);
    state.outH = clampSize(srcData.height * f);
  }
  syncControls();
  scheduleRender();
}

/** Pulls the most-used colours out of the image and makes them the palette. */
function extractPalette() {
  if (!srcData) return;
  const small = resizeImage(srcData, state.outW, state.outH, state.resize);
  const n = Math.max(2, Math.min(12, state.extractCount));
  const pal = refinePalette(small, medianCut(small, n, state.alphaThreshold), 6, state.alphaThreshold);
  state.palette = pal.map((c) => ({ hex: rgbToHex(c), on: true }));
  renderPalette();
  renderBrushes();
  scheduleRender();
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------
/** The output at the export scale, nearest-neighbour so the screen stays crisp. */
function resultCanvas(scale = 1) {
  const base = document.createElement('canvas');
  base.width = result.width;
  base.height = result.height;
  base.getContext('2d').putImageData(result, 0, 0);
  const f = Math.max(1, Math.round(scale));
  if (f === 1) return base;

  const out = document.createElement('canvas');
  out.width = result.width * f;
  out.height = result.height * f;
  const octx = out.getContext('2d');
  octx.imageSmoothingEnabled = false;
  octx.drawImage(base, 0, 0, out.width, out.height);
  return out;
}

function canvasToBlob(c) {
  return new Promise((resolve) => c.toBlob(resolve, 'image/png'));
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Momentary "done" label on a button, then back to what it said. */
async function withLabel(btn, msg, fn) {
  const label = btn.textContent;
  try {
    await fn();
    btn.textContent = msg;
  } catch (e) {
    btn.textContent = 'できませんでした';
  }
  setTimeout(() => { btn.textContent = label; }, 1600);
}

async function exportPng() {
  if (!result) return;
  const blob = await canvasToBlob(resultCanvas(state.exportScale));
  download(blob, `${baseName || 'image'}_kerokero.png`);
}

async function copyPng(btn) {
  if (!result) return;
  await withLabel(btn, '✓ コピーしました', async () => {
    const blob = await canvasToBlob(resultCanvas(state.exportScale));
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
  });
}

async function copyPalette(btn) {
  await withLabel(btn, '✓ コピーしました', async () => {
    const text = state.palette.filter((c) => c.on).map((c) => c.hex.toUpperCase()).join('\n');
    await navigator.clipboard.writeText(text);
  });
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
function setBackground(mode) {
  // 窓（ステージ）に敷く。画像が窓より小さくても下地が見える。
  stage.classList.remove('bg-checker', 'bg-white', 'bg-black');
  stage.classList.add(`bg-${mode}`);
  document.querySelectorAll('#bgGroup .bg').forEach((b) => {
    b.classList.toggle('active', b.dataset.bg === mode);
  });
}

function wireEvents() {
  dropzone.addEventListener('click', () => fileInput.click());
  $('#changeImage').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    loadImageFromFile(fileInput.files[0]);
    fileInput.value = '';  // let the same file be re-picked later
  });

  window.addEventListener('dragover', (e) => { e.preventDefault(); stage.classList.add('dragover'); });
  window.addEventListener('dragleave', (e) => {
    if (e.target === document.documentElement || !e.relatedTarget) stage.classList.remove('dragover');
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    stage.classList.remove('dragover');
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) loadImageFromFile(file);
  });

  document.querySelectorAll('#sizePresets .preset-btn').forEach((b) => {
    b.addEventListener('click', () => setSizePreset(b.dataset.size));
  });

  $('#addColor').addEventListener('click', () => {
    state.palette.push({ hex: '#808080', on: true });
    renderPalette();
    scheduleRender();
  });
  $('#palAll').addEventListener('click', () => {
    state.palette.forEach((c) => { c.on = true; });
    renderPalette();
    renderBrushes();
    scheduleRender();
  });
  $('#extractPalette').addEventListener('click', extractPalette);

  $('#brushAll').addEventListener('click', () => setBrushes(PATTERNS.map((p) => p.id)));
  $('#brushNone').addEventListener('click', () => setBrushes([]));
  $('#brushDots').addEventListener('click', () => setBrushes(DOT_BRUSHES));

  $('#saveConfig').addEventListener('click', saveConfig);
  $('#resetConfig').addEventListener('click', resetConfig);

  document.querySelectorAll('#bgGroup .bg').forEach((b) => {
    b.addEventListener('click', () => setBackground(b.dataset.bg));
  });

  const compare = $('#compareBtn');
  const hold = (on) => () => {
    showOriginal = on;
    compare.classList.toggle('holding', on);
    drawPreview();
  };
  compare.addEventListener('pointerdown', hold(true));
  compare.addEventListener('pointerup', hold(false));
  compare.addEventListener('pointerleave', hold(false));
  compare.addEventListener('pointercancel', hold(false));

  // Keep the raw text in the field; only the download name gets sanitised.
  $('#baseName').addEventListener('input', (e) => {
    baseName = sanitizeBase(e.currentTarget.value);
  });

  $('#exportPng').addEventListener('click', exportPng);
  $('#copyPng').addEventListener('click', (e) => copyPng(e.currentTarget));
  $('#exportPalette').addEventListener('click', (e) => copyPalette(e.currentTarget));

}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
function init() {
  renderPalettePresets();
  bindInputs();
  wireEvents();
  loadConfig();
  syncControls();
  setBackground('checker');
  canvas.classList.add('empty');
}

init();
