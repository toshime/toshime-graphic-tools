// ばらばら UI. Loads one image, works out where the separate pieces are
// (auto-detect or a fixed grid), and writes them back out as individual PNGs
// or a single ZIP. Everything runs in the page — no build step, no deps.

import { detectRegions, gridRegions, autoBackground, buildMask, trimBox, padBox, sortBoxes } from './detect.js';
import { createZip } from '../zip.js';
import { createStageView } from '../viewer.js';

// ---- defaults / state -----------------------------------------------------
const DEFAULTS = {
  mode: 'auto',           // 'auto' | 'grid'

  // auto detect
  bgMode: 'auto',         // 'auto' | 'alpha' | 'color'
  bgColor: '#ffffff',
  tolerance: 24,
  alphaThreshold: 8,
  gap: 2,
  minSize: 4,
  sortOrder: 'row',

  // grid
  gridMode: 'count',      // 'count' | 'size'
  cols: 4,
  rows: 4,
  cellW: 32,
  cellH: 32,
  offsetX: 0,
  offsetY: 0,
  spacingX: 0,
  spacingY: 0,
  skipEmpty: true,
  trimCells: false,

  // output
  padding: 0,
  scale: 1,
  uniform: false,
  keepBg: false,
};

const BOOL_PARAMS = new Set(['skipEmpty', 'trimCells', 'uniform', 'keepBg']);
const STR_PARAMS = new Set(['mode', 'bgMode', 'bgColor', 'sortOrder', 'gridMode']);
// These change how a region is written out, not where the regions are — so
// they only need a re-render, never a re-detect.
const RENDER_ONLY = new Set(['scale', 'uniform', 'keepBg']);

const state = { ...DEFAULTS };

let sourceImage = null;   // HTMLImageElement
let srcData = null;       // ImageData of the source at natural size
let mask = null;          // Uint8Array foreground mask matching srcData
let resolvedBg = null;    // { mode, color:[r,g,b] } actually used
let regions = [];         // [{ x, y, w, h }] in source pixels, padding applied
let excluded = new Set(); // indices the user unticked
let baseName = 'image';
const MAX_THUMBS = 300;   // keep the DOM sane on huge sheets

// ---- element refs ---------------------------------------------------------
const $ = (sel) => document.querySelector(sel);
const stage = $('#stage');
const canvas = $('#previewCanvas');
const ctx = canvas.getContext('2d');
const dropzone = $('#dropzone');
const fileInput = $('#fileInput');
const thumbGrid = $('#thumbGrid');

let showBoxes = true;
let pickingColor = false;

// プレビューの拡大・移動（ホイール / ドラッグ / ピンチ）。
const view = createStageView({
  stage,
  canvas,
  zoomGroup: $('#zoomGroup'),
  onChange: () => drawPreview(),
  fitMax: 8,
  minZoom: 0.02,
});

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
    const v = state[p];
    if (BOOL_PARAMS.has(p)) el.checked = !!v;
    else el.value = v;
    const disp = el.parentElement.querySelector(`[data-for="${p}"]`);
    if (disp) disp.textContent = formatVal(v);
  });
  updateSectionVisibility();
}

function bindInputs() {
  document.querySelectorAll('[data-param]').forEach((el) => {
    const evt = el.type === 'range' || el.type === 'number' || el.type === 'color' ? 'input' : 'change';
    el.addEventListener(evt, () => {
      const p = el.dataset.param;
      state[p] = readInput(el);
      document.querySelectorAll(`[data-for="${p}"]`).forEach((d) => { d.textContent = formatVal(state[p]); });
      updateSectionVisibility();
      if (RENDER_ONLY.has(p)) { if (srcData) renderAll(); }
      else scheduleRecompute();
    });
  });
}

// ---------------------------------------------------------------------------
// Section visibility
// ---------------------------------------------------------------------------
function updateSectionVisibility() {
  $('#autoGroup').hidden = state.mode !== 'auto';
  $('#gridGroup').hidden = state.mode !== 'grid';
  $('#modeHint').textContent = state.mode === 'auto'
    ? '背景から浮いている塊をひとつずつ探して切り出します。バラバラに並んだ素材向け。'
    : '画像を等間隔のマス目で切ります。コマが整列したスプライトシート向け。';

  $('#bgColorRow').hidden = state.bgMode !== 'color';
  $('#toleranceRow').hidden = state.bgMode === 'alpha';

  document.querySelectorAll('[data-grid]').forEach((el) => {
    el.hidden = el.dataset.grid !== state.gridMode;
  });

  document.querySelectorAll('#modeTabs .tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.mode === state.mode);
  });
}

function setMode(mode) {
  state.mode = mode;
  updateSectionVisibility();
  scheduleRecompute();
}

// ---------------------------------------------------------------------------
// Config persistence (localStorage)
// ---------------------------------------------------------------------------
const STORAGE_KEY = 'kirisketch:params';   // 保存ずみの設定を捨てないよう、鍵は昔のまま
let statusTimer = 0;

function flashStatus(msg) {
  const el = $('#configStatus');
  el.textContent = msg;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => { el.textContent = ''; }, 2000);
}

function saveConfig() {
  const params = {};
  for (const k of Object.keys(DEFAULTS)) params[k] = state[k];
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
  // Only accept keys we know, so an old/garbage payload can't inject fields.
  for (const k of Object.keys(DEFAULTS)) {
    if (saved[k] !== undefined) state[k] = saved[k];
  }
}

function resetConfig() {
  Object.assign(state, DEFAULTS);
  try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* ignore */ }
  syncControls();
  scheduleRecompute();
  flashStatus('初期値に戻しました');
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------
function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return [255, 255, 255];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex([r, g, b]) {
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

let recomputeTimer = null;
function scheduleRecompute() {
  clearTimeout(recomputeTimer);
  recomputeTimer = setTimeout(recompute, 200);
}

function recompute() {
  if (!srcData) return;
  const W = srcData.width;
  const H = srcData.height;

  // Resolve the background once — both modes need the mask (trim / knockout).
  resolvedBg = state.bgMode === 'auto'
    ? autoBackground(srcData, state.alphaThreshold)
    : { mode: state.bgMode, color: hexToRgb(state.bgColor) };
  mask = buildMask(srcData, {
    mode: resolvedBg.mode,
    bgColor: resolvedBg.color,
    tolerance: state.tolerance,
    alphaThreshold: state.alphaThreshold,
  });

  let boxes;
  if (state.mode === 'grid') {
    const g = gridRegions(W, H, state);
    $('#cellInfo').textContent = `${g.cellW}×${g.cellH} / ${g.cols}列 ${g.rows}行`;
    boxes = g.boxes;
    if (state.skipEmpty || state.trimCells) {
      boxes = boxes
        .map((b) => {
          const t = trimBox(mask, W, b);
          if (!t) return state.skipEmpty ? null : b;
          return state.trimCells ? t : b;
        })
        .filter(Boolean);
    }
  } else {
    boxes = detectRegions(srcData, {
      gap: state.gap,
      minSize: state.minSize,
      sortOrder: state.sortOrder,
    }, { mask, background: resolvedBg }).boxes;
  }

  if (state.mode === 'grid' && state.trimCells) boxes = sortBoxes(boxes, 'row');
  regions = boxes.map((b) => padBox(b, state.padding));
  excluded = new Set();

  $('#bgInfo').textContent = state.bgMode === 'auto'
    ? (resolvedBg.mode === 'alpha' ? '自動判定: 透明部分を背景として扱っています' : `自動判定: 背景色 ${rgbToHex(resolvedBg.color)}`)
    : '';

  renderAll();
}

// ---------------------------------------------------------------------------
// Cropping
// ---------------------------------------------------------------------------
/** Output box size for a region, honouring the "same size" option. */
let uniformSize = { w: 0, h: 0 };
function recomputeUniformSize() {
  let w = 0, h = 0;
  for (const r of regions) { if (r.w > w) w = r.w; if (r.h > h) h = r.h; }
  uniformSize = { w: Math.max(1, w), h: Math.max(1, h) };
}

/** Cuts one region out of the source at 1×, as an ImageData. */
function cropRegion(box) {
  const W = srcData.width;
  const H = srcData.height;
  const dw = state.uniform ? uniformSize.w : box.w;
  const dh = state.uniform ? uniformSize.h : box.h;
  const offX = state.uniform ? Math.floor((dw - box.w) / 2) : 0;
  const offY = state.uniform ? Math.floor((dh - box.h) / 2) : 0;

  const out = new ImageData(Math.max(1, dw), Math.max(1, dh));
  const sd = srcData.data;
  const od = out.data;
  // With a colour background we knock it out to transparent unless asked not to.
  const knockout = resolvedBg.mode === 'color' && !state.keepBg;

  for (let y = 0; y < box.h; y++) {
    const sy = box.y + y;
    const dy = offY + y;
    if (sy < 0 || sy >= H || dy < 0 || dy >= out.height) continue;
    for (let x = 0; x < box.w; x++) {
      const sx = box.x + x;
      const dx = offX + x;
      if (sx < 0 || sx >= W || dx < 0 || dx >= out.width) continue;
      const si = sy * W + sx;
      if (knockout && !mask[si]) continue;
      const sp = si * 4;
      const dp = (dy * out.width + dx) * 4;
      od[dp] = sd[sp];
      od[dp + 1] = sd[sp + 1];
      od[dp + 2] = sd[sp + 2];
      od[dp + 3] = sd[sp + 3];
    }
  }
  return out;
}

/** Region as a canvas, with the export upscale applied (nearest neighbour). */
function regionCanvas(box, scale = 1) {
  const data = cropRegion(box);
  const base = document.createElement('canvas');
  base.width = data.width;
  base.height = data.height;
  base.getContext('2d').putImageData(data, 0, 0);
  if (scale <= 1) return base;

  const out = document.createElement('canvas');
  out.width = data.width * scale;
  out.height = data.height * scale;
  const octx = out.getContext('2d');
  octx.imageSmoothingEnabled = false;
  octx.drawImage(base, 0, 0, out.width, out.height);
  return out;
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------
function drawPreview() {
  if (!sourceImage) return;
  const z = view.zoomFor(sourceImage.width, sourceImage.height);
  canvas.classList.remove('empty');
  canvas.width = Math.max(1, Math.round(sourceImage.width * z));
  canvas.height = Math.max(1, Math.round(sourceImage.height * z));
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(sourceImage, 0, 0, canvas.width, canvas.height);
  if (!showBoxes) return;

  // 枠の色はページのテーマ（ツール色）から拾う。CSS 側で色を変えても追従する。
  const css = getComputedStyle(document.body);
  const theme = {
    accent: css.getPropertyValue('--accent-deep').trim() || '#c46a1a',
    warn: css.getPropertyValue('--warn').trim() || '#d4573f',
    ink: css.getPropertyValue('--sheet').trim() || '#fffdf6',
  };
  ctx.lineWidth = 1;
  ctx.font = '10px system-ui, sans-serif';
  ctx.textBaseline = 'top';
  const labelled = regions.length <= 120;

  regions.forEach((r, i) => {
    const x = r.x * z;
    const y = r.y * z;
    const w = Math.max(1, r.w * z);
    const h = Math.max(1, r.h * z);
    const off = excluded.has(i);

    if (off) {
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(x, y, w, h);
    }
    ctx.strokeStyle = off ? theme.warn : theme.accent;
    ctx.setLineDash(off ? [3, 3] : []);
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    ctx.setLineDash([]);

    if (labelled && w > 16 && h > 12) {
      const label = String(i + 1);
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = off ? theme.warn : theme.accent;
      ctx.fillRect(x, y, tw + 6, 13);
      ctx.fillStyle = theme.ink;
      ctx.fillText(label, x + 3, y + 2);
    }
  });
}

// ---------------------------------------------------------------------------
// Thumbnails
// ---------------------------------------------------------------------------
function paddedIndex(i) {
  const digits = Math.max(2, String(regions.length).length);
  return String(i + 1).padStart(digits, '0');
}

function fileNameFor(i) {
  return `${baseName || 'image'}_${paddedIndex(i)}.png`;
}

function renderThumbs() {
  thumbGrid.innerHTML = '';
  const shown = Math.min(regions.length, MAX_THUMBS);
  const note = $('#thumbNote');
  note.hidden = regions.length <= MAX_THUMBS;
  note.textContent = `※ サムネイル表示は先頭 ${MAX_THUMBS} 枚まで。ZIPには選択中の ${regions.length} 枚すべてが入ります。`;

  for (let i = 0; i < shown; i++) {
    const r = regions[i];
    const cell = document.createElement('div');
    cell.className = 'thumb';
    cell.classList.toggle('off', excluded.has(i));

    const box = document.createElement('div');
    box.className = 'thumb-img';
    const c = regionCanvas(r, 1);
    box.appendChild(c);
    box.title = 'クリックで選択／解除';
    box.addEventListener('click', () => toggleRegion(i));

    const bar = document.createElement('div');
    bar.className = 'thumb-bar';

    // Show what actually lands in the file: uniform box and upscale included.
    const ow = (state.uniform ? uniformSize.w : r.w) * state.scale;
    const oh = (state.uniform ? uniformSize.h : r.h) * state.scale;
    const label = document.createElement('span');
    label.className = 'thumb-label';
    label.textContent = `${paddedIndex(i)} · ${ow}×${oh}`;

    const dl = document.createElement('button');
    dl.className = 'mini-btn';
    dl.textContent = '⤓';
    dl.title = 'この1枚を保存';
    dl.addEventListener('click', (e) => { e.stopPropagation(); downloadOne(i); });

    bar.append(label, dl);
    cell.append(box, bar);
    thumbGrid.appendChild(cell);
  }
}

function toggleRegion(i) {
  if (excluded.has(i)) excluded.delete(i); else excluded.add(i);
  const cell = thumbGrid.children[i];
  if (cell) cell.classList.toggle('off', excluded.has(i));
  updateCounts();
  drawPreview();
}

function updateCounts() {
  const total = regions.length;
  const sel = total - excluded.size;
  $('#regionCount').textContent = total ? `${total}枚` : '–';
  $('#selectedCount').textContent = `${sel} / ${total}`;
  $('#exportZip').disabled = sel === 0;
}

function renderAll() {
  recomputeUniformSize();
  drawPreview();
  renderThumbs();
  updateCounts();
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

    baseName = sanitizeBase(file.name);
    $('#baseName').value = baseName;
    dropzone.classList.add('hidden');
    recompute();
  };
  img.onerror = () => { URL.revokeObjectURL(url); console.error('failed to load image'); };
  img.src = url;
}

/** "sheet (1).png" -> "sheet_1" — safe for a download filename. */
function sanitizeBase(name) {
  const stem = String(name || '').replace(/\.[^.]+$/, '');
  const clean = stem.replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
  return clean || 'image';
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------
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

function canvasToBlob(c) {
  return new Promise((resolve) => c.toBlob(resolve, 'image/png'));
}

async function downloadOne(i) {
  const c = regionCanvas(regions[i], state.scale);
  download(await canvasToBlob(c), fileNameFor(i));
}

function selectedIndices() {
  return regions.map((_, i) => i).filter((i) => !excluded.has(i));
}

async function exportZip() {
  const picks = selectedIndices();
  if (!picks.length) return;
  const btn = $('#exportZip');
  const label = btn.textContent;
  btn.disabled = true;

  try {
    const entries = [];
    const meta = [];
    for (let n = 0; n < picks.length; n++) {
      const i = picks[n];
      btn.textContent = `書き出し中… ${n + 1}/${picks.length}`;
      const c = regionCanvas(regions[i], state.scale);
      const blob = await canvasToBlob(c);
      const name = fileNameFor(i);
      entries.push({ name, data: new Uint8Array(await blob.arrayBuffer()) });
      meta.push({ name, x: regions[i].x, y: regions[i].y, w: regions[i].w, h: regions[i].h, scale: state.scale });
      // Yield now and then so the label actually repaints on big sheets.
      if (n % 8 === 7) await new Promise((r) => setTimeout(r, 0));
    }
    if ($('#metaJson').checked) {
      const json = JSON.stringify({
        source: `${baseName}.png`,
        sourceWidth: srcData.width,
        sourceHeight: srcData.height,
        count: entries.length,
        pieces: meta,
      }, null, 2);
      entries.push({ name: `${baseName}_barabara.json`, data: new TextEncoder().encode(json) });
    }
    download(createZip(entries), `${baseName}_barabara.zip`);
  } finally {
    btn.textContent = label;
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Preview interaction
// ---------------------------------------------------------------------------
function canvasToImageCoords(e) {
  const rect = canvas.getBoundingClientRect();
  const z = canvas.width / sourceImage.width;
  return {
    x: Math.floor((e.clientX - rect.left) * (canvas.width / rect.width) / z),
    y: Math.floor((e.clientY - rect.top) * (canvas.height / rect.height) / z),
  };
}

function onCanvasClick(e) {
  if (!sourceImage) return;
  const { x, y } = canvasToImageCoords(e);

  if (pickingColor) {
    pickingColor = false;
    canvas.classList.remove('picking');
    $('#pickFromImage').classList.remove('holding');
    if (x < 0 || y < 0 || x >= srcData.width || y >= srcData.height) return;
    const p = (y * srcData.width + x) * 4;
    const hex = rgbToHex([srcData.data[p], srcData.data[p + 1], srcData.data[p + 2]]);
    state.bgMode = 'color';
    state.bgColor = hex;
    syncControls();
    scheduleRecompute();
    return;
  }

  // Topmost (last drawn) region wins when boxes overlap.
  for (let i = regions.length - 1; i >= 0; i--) {
    const r = regions[i];
    if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) { toggleRegion(i); return; }
  }
}

function setBackground(mode) {
  // 窓（ステージ）に敷く。画像が窓より小さくても下地が見える。
  stage.classList.remove('bg-checker', 'bg-white', 'bg-black');
  stage.classList.add(`bg-${mode}`);
  document.querySelectorAll('#bgGroup .bg').forEach((b) => {
    b.classList.toggle('active', b.dataset.bg === mode);
  });
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
function wireEvents() {
  document.querySelectorAll('#modeTabs .tab').forEach((t) => {
    t.addEventListener('click', () => setMode(t.dataset.mode));
  });

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

  $('#saveConfig').addEventListener('click', saveConfig);
  $('#resetConfig').addEventListener('click', resetConfig);

  document.querySelectorAll('#bgGroup .bg').forEach((b) => {
    b.addEventListener('click', () => setBackground(b.dataset.bg));
  });

  $('#toggleBoxes').addEventListener('click', (e) => {
    showBoxes = !showBoxes;
    e.currentTarget.textContent = showBoxes ? '枠を隠す' : '枠を表示';
    drawPreview();
  });

  $('#pickFromImage').addEventListener('click', (e) => {
    pickingColor = !pickingColor;
    canvas.classList.toggle('picking', pickingColor);
    e.currentTarget.classList.toggle('holding', pickingColor);
  });

  canvas.addEventListener('click', onCanvasClick);

  $('#selectAll').addEventListener('click', () => {
    excluded.clear();
    renderThumbs();
    updateCounts();
    drawPreview();
  });
  $('#selectNone').addEventListener('click', () => {
    excluded = new Set(regions.map((_, i) => i));
    renderThumbs();
    updateCounts();
    drawPreview();
  });

  // Keep the raw text in the field; only the download name gets sanitised.
  $('#baseName').addEventListener('input', (e) => {
    baseName = sanitizeBase(e.currentTarget.value);
  });

  $('#exportZip').addEventListener('click', exportZip);

}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
function init() {
  bindInputs();
  wireEvents();
  loadConfig();
  syncControls();
  updateCounts();
  setBackground('checker');
  canvas.classList.add('empty');
}

init();
