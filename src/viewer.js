// プレビューの見かた（拡大・移動）を 3 ツールで共通にする小さなビューア。
//
// ステージ（窓）の中で canvas を CSS の translate だけで動かす。canvas 自身は
// これまで通り「元画像 x 倍率」の実ピクセルで描かれるので、ドット絵の輪郭は
// ぼけない。窓はスクロールさせない（overflow: hidden）ので、ページをスクロール
// したときに画像の上が切れて戻せなくなる、ということも起きない。
//
//   ホイール / トラックパッドのピンチ  … カーソルの下の点を動かさずに拡大縮小
//   ドラッグ（指 1 本）                … 移動
//   指 2 本                            … ピンチで拡大縮小 + 移動
//   ダブルクリック                     … フィットに戻す
//
// 拡大率そのものはアプリ側が持つ描画関数の中で `zoomFor(w, h)` を呼んで受け取る。
// 画像を描き直す必要があるのは倍率が変わったときだけで、移動は transform だけで
// 済む（再描画なし）。

const DRAG_SLOP = 4;      // これ未満の動きは「クリック」として通す（ばらばらの枠選択）
const CORNER = 26;       // 右下の角つまみのぶんだけ、移動の当たり判定から外す
const MIN_STAGE_H = 140;
const MAX_STAGE_H = 2000;
const STAGE_KEY = 'ugosketch.stageHeight';   // 3 ツールで共通の窓の高さ

/**
 * 右下の角つまみ。ドラッグで窓の高さを変える（横幅は列に合わせたまま）。
 * ダブルクリックで既定の 16:10 に戻す。高さはブラウザに覚えさせる。
 */
function addResizeGrip(stage, onResize) {
  const grip = document.createElement('div');
  grip.className = 'stage-resize';
  grip.title = 'ドラッグで高さを変える / ダブルクリックで 16:10 に戻す';
  stage.appendChild(grip);

  const store = (v) => {
    try {
      if (v) localStorage.setItem(STAGE_KEY, String(v));
      else localStorage.removeItem(STAGE_KEY);
    } catch (e) { /* プライベートモードなどでは覚えないだけ */ }
  };
  try {
    const saved = Number(localStorage.getItem(STAGE_KEY));
    if (saved >= MIN_STAGE_H && saved <= MAX_STAGE_H) stage.style.height = `${saved}px`;
  } catch (e) { /* 同上 */ }

  grip.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();   // 画像の移動にはしない
    const y0 = e.clientY;
    const h0 = stage.getBoundingClientRect().height;
    grip.setPointerCapture(e.pointerId);

    const move = (ev) => {
      const h = Math.min(MAX_STAGE_H, Math.max(MIN_STAGE_H, h0 + ev.clientY - y0));
      stage.style.height = `${Math.round(h)}px`;
      onResize();
    };
    const up = () => {
      grip.removeEventListener('pointermove', move);
      store(Math.round(stage.getBoundingClientRect().height));
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up, { once: true });
    grip.addEventListener('pointercancel', up, { once: true });
  });

  grip.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    stage.style.height = '';
    store(null);
    onResize();
  });
}

/**
 * @param {object}   o
 * @param {Element}  o.stage      プレビューの窓
 * @param {HTMLCanvasElement} o.canvas
 * @param {Element}  [o.zoomGroup] フィット/1x/2x… のボタン置き場
 * @param {Function} o.onChange   倍率が変わったので描き直して、と呼ばれる
 * @param {number}   [o.fitMax]   「フィット」で許す最大倍率
 * @param {number}   [o.maxZoom]  ホイールで行ける最大倍率
 * @param {number}   [o.minZoom]  同 最小倍率
 * @param {number}   [o.margin]   窓の内側に残す余白 (px)
 * @param {Function} [o.snap]     (z, kind) => z  倍率の丸め方。kind は 'fit' | 'free'
 */
export function createStageView({
  stage,
  canvas,
  zoomGroup = null,
  onChange = () => {},
  fitMax = 16,
  maxZoom = 16,
  minZoom = 0.05,
  margin = 8,
  snap = null,
}) {
  let mode = 'fit';        // 'fit' | 数値（= 実際の倍率）
  let raw = 1;             // 丸める前の倍率。ホイールはこちらを積む
  let scale = 1;           // 実際に使っている倍率
  let content = { w: 0, h: 0 };
  let offset = { x: 0, y: 0 };   // 窓の中心から見た canvas の中心のずれ (px)
  let pending = false;

  const round = (z, kind) => (snap ? snap(z, kind) : z);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const hasArt = () => !canvas.classList.contains('empty') && content.w > 0;

  /** その画像が窓にちょうど収まる倍率。 */
  function fitScale(w, h) {
    const bw = Math.max(1, stage.clientWidth - margin);
    const bh = Math.max(1, stage.clientHeight - margin);
    const z = Math.min(bw / w, bh / h, fitMax);
    return round(Math.max(minZoom, z), 'fit');
  }

  /** 画像が大きすぎるときに canvas が現実的なサイズに収まる上限。 */
  function zoomCeil() {
    const side = Math.max(content.w, content.h) || 1;
    return Math.max(1, Math.min(maxZoom, 4096 / side));
  }

  // -------------------------------------------------------------------------
  // 配置
  // -------------------------------------------------------------------------
  function schedule() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => { pending = false; apply(); });
  }

  /** はみ出した分だけ動かせるように offset を締めて、transform に流す。 */
  function apply() {
    const art = hasArt();
    stage.classList.toggle('has-art', art);
    if (!art) {
      stage.classList.remove('pannable');
      canvas.style.transform = '';
      return;
    }
    const maxX = Math.max(0, (canvas.width - stage.clientWidth) / 2);
    const maxY = Math.max(0, (canvas.height - stage.clientHeight) / 2);
    offset.x = clamp(offset.x, -maxX, maxX);
    offset.y = clamp(offset.y, -maxY, maxY);
    canvas.style.transform = `translate(${Math.round(offset.x)}px, ${Math.round(offset.y)}px)`;
    stage.classList.toggle('pannable', maxX > 0.5 || maxY > 0.5);
  }

  // -------------------------------------------------------------------------
  // 倍率
  // -------------------------------------------------------------------------
  function syncButtons() {
    if (!zoomGroup) return;
    zoomGroup.querySelectorAll('.zoom').forEach((b) => {
      const on = mode === 'fit'
        ? b.dataset.zoom === 'fit'
        : Number(b.dataset.zoom) === scale;
      b.classList.toggle('active', on);
    });
  }

  /**
   * 窓の中心から (cx, cy) の位置にある点を動かさずに倍率を変える。
   * cx, cy を省くと中心を保つ。
   */
  function zoomTo(next, cx = 0, cy = 0) {
    const z = clamp(next, minZoom, zoomCeil());
    const snapped = round(z, 'free');
    if (snapped !== scale) {
      // 掴んでいる点 = canvas 中心からの距離 / 倍率（元画像の座標）
      const ux = (cx - offset.x) / scale;
      const uy = (cy - offset.y) / scale;
      offset.x = cx - ux * snapped;
      offset.y = cy - uy * snapped;
    }
    raw = z;
    scale = snapped;
    mode = snapped;
    syncButtons();
    onChange();
    schedule();
  }

  function setMode(next) {
    mode = next === 'fit' ? 'fit' : Number(next);
    offset.x = 0;
    offset.y = 0;
    if (mode !== 'fit') raw = scale = mode;
    syncButtons();
    onChange();
    schedule();
  }

  /**
   * 描画のたびにアプリから呼ぶ。いまの倍率を返しつつ、画像サイズを覚えて
   * 次のフレームで配置し直す。
   */
  function zoomFor(w, h) {
    content = { w, h };
    if (mode === 'fit') {
      scale = raw = fitScale(w, h);
      offset.x = offset.y = 0;
    } else {
      scale = clamp(mode, minZoom, zoomCeil());
    }
    schedule();
    return scale;
  }

  // -------------------------------------------------------------------------
  // 入力
  // -------------------------------------------------------------------------
  /** イベント位置を「窓の中心からの px」に直す。 */
  function stagePoint(e) {
    const r = stage.getBoundingClientRect();
    return {
      x: e.clientX - r.left - stage.clientWidth / 2,
      y: e.clientY - r.top - stage.clientHeight / 2,
    };
  }

  stage.addEventListener('wheel', (e) => {
    if (!hasArt()) return;   // 画像がないときはページのスクロールに任せる
    e.preventDefault();
    // トラックパッドのピンチは ctrlKey 付きで届く。行送りのホイールは deltaMode=1。
    const unit = e.deltaMode === 1 ? 16 : 1;
    const k = e.ctrlKey ? 0.01 : 0.0022;
    const p = stagePoint(e);
    zoomTo(raw * Math.exp(-e.deltaY * unit * k), p.x, p.y);
  }, { passive: false });

  stage.addEventListener('dblclick', () => { if (hasArt()) setMode('fit'); });

  // ドラッグ（1 本）とピンチ（2 本）。DRAG_SLOP 未満の動きはクリックのまま通す。
  const pointers = new Map();
  let drag = null;
  let pinch = null;
  let moved = false;

  const spread = () => {
    const [a, b] = [...pointers.values()];
    return {
      dist: Math.hypot(a.x - b.x, a.y - b.y),
      mid: { clientX: (a.x + b.x) / 2, clientY: (a.y + b.y) / 2 },
    };
  };

  stage.addEventListener('pointerdown', (e) => {
    if (!hasArt()) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const r = stage.getBoundingClientRect();
    if (e.clientX > r.right - CORNER && e.clientY > r.bottom - CORNER) return;   // 角つまみ
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) {
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y };
      moved = false;
    } else if (pointers.size === 2) {
      drag = null;
      const s = spread();
      pinch = { dist: s.dist, raw };
    }
  });

  stage.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pinch && pointers.size >= 2) {
      const s = spread();
      if (pinch.dist > 0) {
        const p = stagePoint(s.mid);
        zoomTo(pinch.raw * (s.dist / pinch.dist), p.x, p.y);
      }
      return;
    }
    if (!drag || e.pointerId !== drag.id) return;

    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!moved) {
      if (Math.hypot(dx, dy) < DRAG_SLOP) return;
      moved = true;
      stage.classList.add('dragging');
      try { stage.setPointerCapture(e.pointerId); } catch { /* 取れなくても動く */ }
    }
    offset.x = drag.ox + dx;
    offset.y = drag.oy + dy;
    apply();
  });

  const endPointer = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (drag && e.pointerId === drag.id) {
      drag = null;
      if (moved) {
        // 動かしたあとの click は選択ではないので飲み込む。窓の外で指を離すと
        // click 自体が来ないので、少し待って外す（次のクリックを食べないように）。
        const swallow = (ev) => ev.stopPropagation();
        stage.addEventListener('click', swallow, { capture: true, once: true });
        setTimeout(() => stage.removeEventListener('click', swallow, { capture: true }), 300);
      }
      moved = false;
      stage.classList.remove('dragging');
    }
    // 1 本だけ残ったら、そこから掴み直す
    if (pointers.size === 1 && !drag) {
      const [id] = [...pointers.keys()];
      const p = pointers.get(id);
      drag = { id, x: p.x, y: p.y, ox: offset.x, oy: offset.y };
      moved = false;
    }
  };
  stage.addEventListener('pointerup', endPointer);
  stage.addEventListener('pointercancel', endPointer);

  if (zoomGroup) {
    zoomGroup.querySelectorAll('.zoom').forEach((b) => {
      b.addEventListener('click', () => setMode(b.dataset.zoom));
    });
  }

  // 窓の大きさが変わるとフィット倍率も変わる
  const relayout = () => { if (hasArt()) { onChange(); schedule(); } };
  new ResizeObserver(relayout).observe(stage);
  addResizeGrip(stage, relayout);

  return {
    zoomFor,
    setMode,
    apply: schedule,
    get scale() { return scale; },
    get mode() { return mode; },
  };
}
