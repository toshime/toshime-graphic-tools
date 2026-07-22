// ugo-sketch UI. Wires the DOM controls to the frame pipeline, keeps a live
// preview playing, and drives the export writers. No build step, no deps.

import { DEFAULTS, prepareSource, generateFrames, playbackOrder } from './pipeline.js';
import { FIELD_TYPES, PRESETS } from './field.js';
import { exportPngSequence, exportSpriteSheet, exportGif, upscaleFrames } from './export.js';

// ---- state ----------------------------------------------------------------
const state = { ...DEFAULTS };
let sourceImage = null;      // HTMLImageElement of the loaded picture
let currentFrames = [];      // ImageData[]
let currentPalette = null;   // [[r,g,b],...] | null
let frameCanvases = [];      // one canvas per frame for fast drawImage
let genId = 0;               // generation counter, guards against races

// Which params are booleans / strings (everything else is numeric).
const BOOL_PARAMS = new Set(['pingPong', 'quantEnabled', 'quantRefine', 'sdfOutline', 'alphaCrisp', 'pixelPerfect']);
const STR_PARAMS = new Set(['fieldType', 'sampling', 'dither', 'mode']);

// ---- element refs ---------------------------------------------------------
const $ = (sel) => document.querySelector(sel);
const stage = $('#stage');
const canvas = $('#previewCanvas');
const ctx = canvas.getContext('2d');
const dropzone = $('#dropzone');
const fileInput = $('#fileInput');
const progress = $('#progress');
const progressBar = $('#progressBar');
const frameCountLabel = $('#frameCount');
const playToggle = $('#playToggle');
const compareBtn = $('#compareBtn');
const fieldSelect = $('#fieldSelect');
const fieldHint = $('#fieldHint');
const outSize = $('#outSize');
const sheetCols = $('#sheetCols');

// ---------------------------------------------------------------------------
// Build the dynamic controls (presets + field list)
// ---------------------------------------------------------------------------
function buildPresets() {
  const row = $('#presetRow');
  for (const [key, preset] of Object.entries(PRESETS)) {
    const btn = document.createElement('button');
    btn.className = 'preset-btn';
    btn.textContent = preset.label;
    btn.addEventListener('click', () => applyPreset(preset));
    row.appendChild(btn);
  }
}

function buildFieldSelect() {
  for (const f of FIELD_TYPES) {
    const opt = document.createElement('option');
    opt.value = f.id;
    opt.textContent = f.label;
    fieldSelect.appendChild(opt);
  }
}

function updateFieldHint() {
  const f = FIELD_TYPES.find((t) => t.id === state.fieldType);
  fieldHint.textContent = f ? f.hint : '';
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

function formatVal(p, v) {
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
    if (disp) disp.textContent = formatVal(p, v);
  });
  updateFieldHint();
  updateOutSize();
  updateAlphaCrispUI();
  updatePixelPerfectUI();
}

function bindInputs() {
  document.querySelectorAll('[data-param]').forEach((el) => {
    const evt = el.type === 'range' || el.type === 'number' ? 'input' : 'change';
    el.addEventListener(evt, () => {
      const p = el.dataset.param;
      state[p] = readInput(el);
      // Keep every readout for this param in sync (alphaThreshold has two rows).
      document.querySelectorAll(`[data-for="${p}"]`).forEach((d) => {
        d.textContent = formatVal(p, state[p]);
      });
      // Mirror the shared value onto any other inputs bound to the same param.
      document.querySelectorAll(`[data-param="${p}"]`).forEach((other) => {
        if (other !== el) other.value = state[p];
      });
      if (p === 'fieldType') updateFieldHint();
      if (p === 'scale' || p === 'padding') updateOutSize();
      if (p === 'alphaCrisp') updateAlphaCrispUI();
      if (p === 'pixelPerfect') updatePixelPerfectUI();
      scheduleRegen();
    });
  });
}

function applyPreset(preset) {
  for (const [k, v] of Object.entries(preset)) {
    if (k === 'label') continue;
    state[k] = v;
  }
  syncControls();
  scheduleRegen();
}

// ---------------------------------------------------------------------------
// Config persistence (localStorage) — only the pipeline params in DEFAULTS.
// ---------------------------------------------------------------------------
const STORAGE_KEY = 'ugosketch:params';
let statusTimer = 0;

function flashStatus(msg) {
  const el = $('#configStatus');
  el.textContent = msg;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => { el.textContent = ''; }, 2000);
}

/** Applies the whole current state to the UI and re-renders. Used after any
 *  bulk state change (load, reset), and keeps mode tabs/sections in sync. */
function applyStateToUI() {
  syncControls();
  setMode(state.mode);  // refreshes tab highlight + section visibility, schedules regen
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
  applyStateToUI();
  flashStatus('初期値に戻しました');
}

// ---------------------------------------------------------------------------
// Mode tabs + section visibility
// ---------------------------------------------------------------------------
function setMode(mode) {
  state.mode = mode;
  document.querySelectorAll('#modeTabs .tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.mode === mode);
  });
  $('#quantGroup').hidden = mode !== 'warp';
  $('#sdfGroup').hidden = mode !== 'sdf';
  $('#sdfWarn').hidden = mode !== 'sdf';
  scheduleRegen();
}

// ---------------------------------------------------------------------------
// Output size readout
// ---------------------------------------------------------------------------
function updateOutSize() {
  if (!sourceImage) { outSize.textContent = '–'; return; }
  const w = Math.max(1, Math.round(sourceImage.width * state.scale)) + state.padding * 2;
  const h = Math.max(1, Math.round(sourceImage.height * state.scale)) + state.padding * 2;
  outSize.textContent = `${w}×${h}`;
}

// The alpha-threshold slider in the quantise section only applies when crisping.
function updateAlphaCrispUI() {
  const slider = document.querySelector('#alphaCrispThreshold');
  if (slider) slider.disabled = !state.alphaCrisp;
}

// Pixel-perfect couples the grid input and forces nearest sampling.
function updatePixelPerfectUI() {
  const grid = document.querySelector('#pixelGrid');
  const sampling = document.querySelector('#samplingSelect');
  if (grid) grid.disabled = !state.pixelPerfect;
  if (sampling) {
    if (state.pixelPerfect) {
      state.sampling = 'nearest';
      sampling.value = 'nearest';
      sampling.disabled = true;
    } else {
      sampling.disabled = false;
    }
  }
}

// Preview backdrop only. Purely visual, never affects exported frames.
function setBackground(mode, color) {
  if (mode === 'checker') {
    canvas.style.background = ''; // fall back to the CSS conic-gradient
  } else {
    const c = mode === 'white' ? '#fff' : mode === 'black' ? '#000' : color;
    canvas.style.backgroundImage = 'none';
    canvas.style.backgroundColor = c;
  }
  document.querySelectorAll('#bgGroup .bg').forEach((b) => {
    b.classList.toggle('active', b.dataset.bg === mode);
  });
  document.querySelector('#bgColor').classList.toggle('active', mode === 'custom');
}

// ---------------------------------------------------------------------------
// Generation (debounced, race-guarded)
// ---------------------------------------------------------------------------
let debTimer = null;
function scheduleRegen() {
  clearTimeout(debTimer);
  debTimer = setTimeout(regenerate, 300);
}

async function regenerate() {
  if (!sourceImage) return;
  const myId = ++genId;
  const params = { ...state };
  progress.classList.add('active');
  progressBar.style.width = '0%';

  const source = prepareSource(sourceImage, params);
  let result;
  try {
    result = await generateFrames(source, params, (p) => {
      if (myId === genId) progressBar.style.width = `${Math.round(p * 100)}%`;
    });
  } catch (err) {
    console.error(err);
    if (myId === genId) progress.classList.remove('active');
    return;
  }
  if (myId !== genId) return; // superseded by a newer request

  progress.classList.remove('active');
  currentFrames = result.frames;
  currentPalette = result.palette;
  buildFrameCanvases();
  renderPalette(result.palette);
  updateOutSize();
  if (!sheetColsTouched) sheetCols.value = state.frameCount;
  setExportEnabled(true);
  updateSnsInfo();
  restartPlayback();
}

function buildFrameCanvases() {
  frameCanvases = currentFrames.map((frame) => {
    const c = document.createElement('canvas');
    c.width = frame.width;
    c.height = frame.height;
    c.getContext('2d').putImageData(frame, 0, 0);
    return c;
  });
}

function renderPalette(palette) {
  const targets = [$('#quantPalette'), $('#sdfPalette')];
  targets.forEach((el) => { el.innerHTML = ''; });
  if (!palette) return;
  const target = state.mode === 'sdf' ? $('#sdfPalette') : $('#quantPalette');
  for (const c of palette) {
    const sw = document.createElement('div');
    sw.className = 'swatch';
    sw.style.background = `rgb(${c[0]},${c[1]},${c[2]})`;
    target.appendChild(sw);
  }
}

// ---------------------------------------------------------------------------
// Playback
// ---------------------------------------------------------------------------
let playing = true;
let playIndex = 0;
let lastTick = 0;
let zoomMode = 'fit';
let comparing = false;

function currentOrder() {
  return playbackOrder(currentFrames.length, state.pingPong);
}

function restartPlayback() {
  playIndex = 0;
  lastTick = 0;
  drawFrame(); // paint the first frame immediately, don't wait for the rAF tick
}

function computeZoom(fw, fh) {
  if (zoomMode === 'fit') {
    const bw = stage.clientWidth - 8;
    const bh = stage.clientHeight - 8;
    return Math.max(0.05, Math.min(bw / fw, bh / fh));
  }
  return Number(zoomMode);
}

function drawFrame() {
  if (comparing && sourceImage) {
    // Show the raw source (no warp) at the same zoom footprint.
    const fw = sourceImage.width, fh = sourceImage.height;
    const z = computeZoom(fw, fh);
    canvas.classList.remove('empty');
    canvas.width = Math.round(fw * z);
    canvas.height = Math.round(fh * z);
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(sourceImage, 0, 0, canvas.width, canvas.height);
    return;
  }

  if (!frameCanvases.length) return;
  const order = currentOrder();
  const idx = order[playIndex % order.length];
  const src = frameCanvases[idx];
  const z = computeZoom(src.width, src.height);
  canvas.classList.remove('empty');
  canvas.width = Math.round(src.width * z);
  canvas.height = Math.round(src.height * z);
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(src, 0, 0, canvas.width, canvas.height);

  frameCountLabel.textContent = `${(playIndex % order.length) + 1}/${order.length}`;
}

function tick(now) {
  requestAnimationFrame(tick);
  if (!frameCanvases.length) return;
  const order = currentOrder();
  const interval = 1000 / Math.max(1, state.fps);

  if (comparing) { drawFrame(); return; }

  if (!playing) { drawFrame(); return; }
  if (!lastTick) lastTick = now;
  if (now - lastTick >= interval) {
    lastTick = now;
    playIndex = (playIndex + 1) % order.length;
    drawFrame();
  }
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
    dropzone.classList.add('hidden');
    updateOutSize();
    if (!sheetColsTouched) sheetCols.value = state.frameCount;
    regenerate();
  };
  img.onerror = () => { URL.revokeObjectURL(url); console.error('failed to load image'); };
  img.src = url;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------
let sheetColsTouched = false;

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

function setExportEnabled(on) {
  ['#exportSheet', '#copySheet', '#exportSeq', '#exportGif'].forEach((s) => { $(s).disabled = !on; });
}

// SNS integer upscale (export-only UI state, not part of the pipeline params).
function upscaleFactor() {
  if (!$('#snsUpscale').checked || !currentFrames.length) return 1;
  const target = Number($('#snsTarget').value) || 1024;
  const longEdge = Math.max(currentFrames[0].width, currentFrames[0].height);
  return Math.max(1, Math.ceil(target / longEdge));
}

// Nearest-neighbour blow-up of the frames just before an export.
function forExport(frames) {
  return upscaleFrames(frames, upscaleFactor());
}

function updateSnsInfo() {
  const info = $('#snsInfo');
  const on = $('#snsUpscale').checked;
  info.hidden = !on;
  if (!on || !currentFrames.length) return;
  const f = upscaleFactor();
  const w = currentFrames[0].width * f;
  const h = currentFrames[0].height * f;
  info.textContent = `×${f} → ${w}×${h}`;
}

function flashButton(btn, msg) {
  if (!btn.dataset.label) btn.dataset.label = btn.textContent;
  btn.textContent = msg;
  clearTimeout(btn._flashTimer);
  btn._flashTimer = setTimeout(() => { btn.textContent = btn.dataset.label; }, 2000);
}

async function doExportSheet() {
  if (!currentFrames.length) return;
  const columns = Number(sheetCols.value) || state.frameCount;
  const { sheetBlob, metaJson } = await exportSpriteSheet(forExport(currentFrames), {
    columns, fps: state.fps, pingPong: state.pingPong,
  });
  download(sheetBlob, 'ugosketch_sheet.png');
  if ($('#sheetMeta').checked) {
    download(new Blob([metaJson], { type: 'application/json' }), 'ugosketch_sheet.json');
  }
}

async function doCopySheet() {
  if (!currentFrames.length) return;
  const btn = $('#copySheet');
  const columns = Number(sheetCols.value) || state.frameCount;
  try {
    // Hand a Promise<Blob> to ClipboardItem so the user gesture survives the
    // async canvas encode (required by Safari, tolerated elsewhere).
    const blobPromise = exportSpriteSheet(forExport(currentFrames), {
      columns, fps: state.fps, pingPong: state.pingPong,
    }).then((r) => r.sheetBlob);
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blobPromise })]);
    flashButton(btn, '✓ コピーしました');
  } catch (err) {
    console.error(err);
    flashButton(btn, 'コピー失敗');
  }
}

async function doExportSeq() {
  if (!currentFrames.length) return;
  download(await exportPngSequence(forExport(currentFrames)), 'ugosketch_frames.zip');
}

function doExportGif() {
  if (!currentFrames.length) return;
  const order = playbackOrder(currentFrames.length, state.pingPong);
  const ordered = forExport(order.map((i) => currentFrames[i]));
  const blob = exportGif(ordered, currentPalette, {
    fps: state.fps, alphaThreshold: state.alphaThreshold,
  });
  download(blob, 'ugosketch.gif');
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
function wireEvents() {
  // mode tabs
  document.querySelectorAll('#modeTabs .tab').forEach((t) => {
    t.addEventListener('click', () => setMode(t.dataset.mode));
  });

  // seed random
  $('#seedRandom').addEventListener('click', () => {
    state.seed = Math.floor(Math.random() * 99999);
    syncControls();
    scheduleRegen();
  });

  // file input + dropzone + "change image" button (all reuse the same picker,
  // so a new pick replaces the current image in place — no reload needed).
  dropzone.addEventListener('click', () => fileInput.click());
  $('#changeImage').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    loadImageFromFile(fileInput.files[0]);
    fileInput.value = '';  // let the same file be re-picked later
  });

  // config persistence
  $('#saveConfig').addEventListener('click', saveConfig);
  $('#resetConfig').addEventListener('click', resetConfig);

  // page-wide drag & drop
  window.addEventListener('dragover', (e) => {
    e.preventDefault();
    stage.classList.add('dragover');
  });
  window.addEventListener('dragleave', (e) => {
    if (e.target === document.documentElement || !e.relatedTarget) {
      stage.classList.remove('dragover');
    }
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    stage.classList.remove('dragover');
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) loadImageFromFile(file);
  });

  // playback
  playToggle.addEventListener('click', () => {
    playing = !playing;
    playToggle.textContent = playing ? '⏸' : '▶';
    lastTick = 0;
  });

  // zoom
  document.querySelectorAll('#zoomGroup .zoom').forEach((b) => {
    b.addEventListener('click', () => {
      zoomMode = b.dataset.zoom;
      document.querySelectorAll('#zoomGroup .zoom').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      drawFrame();
    });
  });

  // compare (hold)
  const startCompare = () => { comparing = true; compareBtn.classList.add('holding'); };
  const endCompare = () => { comparing = false; compareBtn.classList.remove('holding'); };
  compareBtn.addEventListener('mousedown', startCompare);
  compareBtn.addEventListener('mouseup', endCompare);
  compareBtn.addEventListener('mouseleave', endCompare);
  compareBtn.addEventListener('touchstart', (e) => { e.preventDefault(); startCompare(); });
  compareBtn.addEventListener('touchend', endCompare);

  // preview background toggle (display only)
  const bgColor = $('#bgColor');
  document.querySelectorAll('#bgGroup .bg').forEach((b) => {
    b.addEventListener('click', () => setBackground(b.dataset.bg));
  });
  bgColor.addEventListener('input', () => setBackground('custom', bgColor.value));

  // sheet columns manual edit flag
  sheetCols.addEventListener('input', () => { sheetColsTouched = true; });

  // SNS upscale controls (export-only, refresh the size readout)
  $('#snsUpscale').addEventListener('change', updateSnsInfo);
  $('#snsTarget').addEventListener('input', updateSnsInfo);

  // export buttons
  $('#exportSheet').addEventListener('click', doExportSheet);
  $('#copySheet').addEventListener('click', doCopySheet);
  $('#exportSeq').addEventListener('click', doExportSeq);
  $('#exportGif').addEventListener('click', doExportGif);
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
function init() {
  buildPresets();
  buildFieldSelect();
  bindInputs();
  wireEvents();
  loadConfig();          // restore saved params over DEFAULTS, if any
  syncControls();
  setMode(state.mode);   // honour the restored mode (defaults to 'warp')
  setExportEnabled(false);
  canvas.classList.add('empty');
  playToggle.textContent = '⏸';
  requestAnimationFrame(tick);
}

init();
