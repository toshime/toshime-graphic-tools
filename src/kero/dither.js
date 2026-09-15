// 解像度変更 → 明るさ等の下ごしらえ → うごメモ風のパターンディザ。
// すべて ImageData を受け取って ImageData を返す純粋な関数で、DOM は
// 拡大用の canvas を借りるところだけ。

import { maskAt } from './patterns.js';

// ---------------------------------------------------------------------------
// 解像度変更
// ---------------------------------------------------------------------------
/** ニアレストネイバー。ドット絵の輪郭をそのまま残す。 */
function resizeNearest(src, w, h) {
  const out = new ImageData(w, h);
  const sd = src.data;
  const od = out.data;
  for (let y = 0; y < h; y++) {
    const sy = Math.min(src.height - 1, Math.floor((y + 0.5) * src.height / h));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(src.width - 1, Math.floor((x + 0.5) * src.width / w));
      const sp = (sy * src.width + sx) * 4;
      const dp = (y * w + x) * 4;
      od[dp] = sd[sp]; od[dp + 1] = sd[sp + 1]; od[dp + 2] = sd[sp + 2]; od[dp + 3] = sd[sp + 3];
    }
  }
  return out;
}

/** 拡大はブラウザの補間に任せる（縮小はここを通らない）。 */
function resizeSmoothUp(src, w, h) {
  const c = document.createElement('canvas');
  c.width = src.width;
  c.height = src.height;
  c.getContext('2d').putImageData(src, 0, 0);
  const dst = document.createElement('canvas');
  dst.width = w;
  dst.height = h;
  const dctx = dst.getContext('2d', { willReadFrequently: true });
  dctx.imageSmoothingEnabled = true;
  dctx.imageSmoothingQuality = 'high';
  dctx.drawImage(c, 0, 0, w, h);
  return dctx.getImageData(0, 0, w, h);
}

/**
 * 範囲平均で縮小する。出力 1 ピクセルが覆う元ピクセルをぜんぶ足して割る
 * だけなので、ノイズもモアレも出ない。α は前乗算で扱い、透明なピクセルの
 * 色に引っぱられないようにする。
 *
 * keepLines を立てると「ライン重視」: その範囲にいちばん暗いピクセルが
 * 平均よりはっきり暗いとき（＝細い主線が通っているとき）だけ、そちらへ
 * 半分寄せる。平均だけだと 1px の線は縮小で薄まって消えてしまう。明るい
 * 外れ値には反応しないので、写真のノイズや JPEG の粒は拾わない。
 */
function resizeArea(src, w, h, keepLines) {
  const out = new ImageData(w, h);
  const sd = src.data;
  const od = out.data;
  const sw = src.width;
  const sh = src.height;

  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * sh / h);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * sh / h));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * sw / w);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * sw / w));

      let r = 0, g = 0, b = 0, a = 0, n = 0;
      let minL = 1e9, mr = 0, mg = 0, mb = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const p = (sy * sw + sx) * 4;
          const al = sd[p + 3] / 255;
          r += sd[p] * al; g += sd[p + 1] * al; b += sd[p + 2] * al; a += sd[p + 3];
          n++;
          if (keepLines && sd[p + 3] >= 128) {
            const l = sd[p] * 0.299 + sd[p + 1] * 0.587 + sd[p + 2] * 0.114;
            if (l < minL) { minL = l; mr = sd[p]; mg = sd[p + 1]; mb = sd[p + 2]; }
          }
        }
      }
      const cov = a / (255 * n) || 0;
      let ar = cov > 0 ? r / (n * cov) : 0;
      let ag = cov > 0 ? g / (n * cov) : 0;
      let ab = cov > 0 ? b / (n * cov) : 0;

      if (keepLines && minL < 1e9) {
        const avgL = ar * 0.299 + ag * 0.587 + ab * 0.114;
        // 40 段より暗いものが混じっていたら線とみなす。それ未満はただの
        // 階調のゆらぎなので平均のまま。
        const t = Math.min(1, Math.max(0, (avgL - minL - 40) / 80)) * 0.5;
        ar += (mr - ar) * t; ag += (mg - ag) * t; ab += (mb - ab) * t;
      }

      const dp = (y * w + x) * 4;
      od[dp] = ar;
      od[dp + 1] = ag;
      od[dp + 2] = ab;
      od[dp + 3] = a / n;
    }
  }
  return out;
}

/** method: 'nearest' | 'line' | 'smooth' */
export function resizeImage(src, w, h, method) {
  const tw = Math.max(1, Math.round(w));
  const th = Math.max(1, Math.round(h));
  if (tw === src.width && th === src.height) {
    return new ImageData(new Uint8ClampedArray(src.data), src.width, src.height);
  }
  if (method === 'nearest') return resizeNearest(src, tw, th);
  // 片方でも拡大なら補間。縮小はモアレの出ない範囲平均で。
  if (tw > src.width || th > src.height) return resizeSmoothUp(src, tw, th);
  return resizeArea(src, tw, th, method === 'line');
}

// ---------------------------------------------------------------------------
// 下ごしらえ（明るさ / コントラスト / ガンマ / エッジ強調 / 輪郭線）
// ---------------------------------------------------------------------------
const EDGE_AMOUNT = [0, 0.4, 0.85, 1.5];   // なし / 弱 / 中 / 強

function luma(d, p) {
  return d[p] * 0.299 + d[p + 1] * 0.587 + d[p + 2] * 0.114;
}

/** アンシャープ気味のエッジ強調。3x3 ラプラシアンを amount 倍して足す。 */
function sharpen(img, amount) {
  const { width: w, height: h, data } = img;
  const src = new Float32Array(data.length);
  src.set(data);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = Math.min(h - 1, Math.max(0, y + dy));
          for (let dx = -1; dx <= 1; dx++) {
            const xx = Math.min(w - 1, Math.max(0, x + dx));
            sum += src[(yy * w + xx) * 4 + c];
          }
        }
        const blur = sum / 9;
        data[p + c] = Math.min(255, Math.max(0, src[p + c] + (src[p + c] - blur) * amount));
      }
    }
  }
}

/**
 * 輪郭線を足す。主線のない絵（写真や塗りだけの絵）をうごメモに落とすと
 * 形が読めなくなりがちなので、Sobel の強さに応じて暗くする。
 */
function addOutline(img, strength) {
  const { width: w, height: h, data } = img;
  const lum = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) lum[i] = luma(data, i * 4);

  const at = (x, y) => lum[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const gx = at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1)
               - at(x + 1, y - 1) - 2 * at(x + 1, y) - at(x + 1, y + 1);
      const gy = at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1)
               - at(x - 1, y + 1) - 2 * at(x, y + 1) - at(x + 1, y + 1);
      const e = Math.min(1, Math.sqrt(gx * gx + gy * gy) / 320);
      if (e <= 0.02) continue;
      const k = 1 - e * strength;
      const p = (y * w + x) * 4;
      data[p] *= k; data[p + 1] *= k; data[p + 2] *= k;
    }
  }
}

/** 明るさ・コントラスト・ガンマ・エッジ強調・輪郭線をこの順で適用（破壊的）。 */
export function adjust(img, { brightness = 0, contrast = 0, gamma = 1, edge = 0, outline = 0 }) {
  const d = img.data;
  const c = contrast / 100;
  const k = c >= 0 ? 1 / Math.max(0.02, 1 - c) : 1 + c;   // ±100 で潰れ切らない程度
  const invG = 1 / Math.max(0.05, gamma);

  if (brightness || contrast || gamma !== 1) {
    const lut = new Uint8ClampedArray(256);
    for (let v = 0; v < 256; v++) {
      let t = v / 255;
      t = (t - 0.5) * k + 0.5;
      t += brightness / 255;
      t = Math.pow(Math.min(1, Math.max(0, t)), invG);
      lut[v] = t * 255;
    }
    for (let i = 0; i < d.length; i += 4) {
      d[i] = lut[d[i]]; d[i + 1] = lut[d[i + 1]]; d[i + 2] = lut[d[i + 2]];
    }
  }

  const amount = EDGE_AMOUNT[Math.min(EDGE_AMOUNT.length - 1, Math.max(0, edge | 0))];
  if (amount > 0) sharpen(img, amount);
  if (outline > 0) addOutline(img, outline);
  return img;
}

// ---------------------------------------------------------------------------
// パターンディザ本体
// ---------------------------------------------------------------------------
/**
 * 「紙の色・インクの色・ブラシ」の組を 1 つの刷り色とみなした候補表を作る。
 * ブラシの density だけインクが乗るので、離れて見たときの色は紙とインクを
 * density で混ぜた色になる。ベタ塗り（紙だけ）も候補に入れておかないと
 * 平らな面が刷れない。
 *
 * 色の組はどちらを紙にするかで 2 通りあるが、明るいほうを紙・暗いほうを
 * インクに固定する。両方入れると同じ濃さの候補が別の点配置で 2 つできて、
 * 階調の途中で点の位置が飛ぶ（＝ざらつく）。うごメモの網は薄い側から濃い側
 * まで揃っているので、片方向で足りる。
 */
export function buildCandidates(colors, brushes) {
  const cands = [];
  const push = (a, b, pattern) => {
    const t = pattern ? pattern.density : 0;
    cands.push({
      a, b, pattern,
      brushId: pattern ? pattern.id : null,
      eff: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t],
    });
  };
  const lum = (c) => c[0] * 0.299 + c[1] * 0.587 + c[2] * 0.114;

  for (const c of colors) push(c, c, null);
  for (let i = 0; i < colors.length; i++) {
    for (let j = i + 1; j < colors.length; j++) {
      const light = lum(colors[i]) >= lum(colors[j]) ? colors[i] : colors[j];
      const dark = light === colors[i] ? colors[j] : colors[i];
      for (const p of brushes) push(light, dark, p);
    }
  }
  return cands;
}

const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

/**
 * 画像をパターンディザにかける。opts:
 *   candidates   buildCandidates() の結果
 *   tileScale    パターンを何倍に引き伸ばすか（1 以上の整数）
 *   amount       0..1。網の効き。下げるほどベタ塗り（網なし）の候補が勝つ
 *   errorMix     0..1。刷り色と狙いの色のズレを隣に配る量（0 でベタなトーン分け）
 *   alphaThreshold  これ未満の α は透明として落とす
 *   keepAlpha    false なら透明部分を paper で埋める
 *   paper        [r,g,b]
 *   edgeDither   半透明のふちを網にする
 * 返り値: { image, usage }  usage は brushId -> 使われたピクセル数。
 */
export function ditherToPatterns(img, opts) {
  const {
    candidates, tileScale = 1, amount = 1, errorMix = 0,
    alphaThreshold = 128, keepAlpha = true, paper = [255, 255, 255], edgeDither = false,
  } = opts;

  const w = img.width;
  const h = img.height;
  const src = img.data;
  const out = new ImageData(w, h);
  const od = out.data;
  const scale = Math.max(1, tileScale | 0);

  // 候補の刷り色を輝度 + 色差 (YCbCr) に直しておく。RGB の距離だと、暗い灰色
  // に「黒地に赤の穴」のような候補が G/B チャンネルの近さだけで勝ってしまい、
  // 無彩色の階調に赤や青の点が紛れ込む。色差を重く見ると、灰色には灰色の
  // 網、色のついた面にはその色の網が選ばれる。
  const n = candidates.length;
  const eff = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const [r, g, b] = candidates[i].eff;
    const yy = r * 0.299 + g * 0.587 + b * 0.114;
    eff[i * 3] = yy;
    eff[i * 3 + 1] = (b - yy) * 0.564;
    eff[i * 3 + 2] = (r - yy) * 0.713;
  }
  const CHROMA = 2.5;

  // 網の効き。1 未満だと網ありの候補に重りがつく。重りは色の距離そのもの
  // （輝度 0..255 と同じものさし）に足すので、「ベタ塗りよりこれだけ近く
  // ないと網は使わない」という読みかたになる。0 なら網なし＝ただの減色。
  const isPattern = new Uint8Array(n);
  for (let i = 0; i < n; i++) isPattern[i] = candidates[i].pattern ? 1 : 0;
  const bias = amount >= 1 ? 0 : amount <= 0 ? Infinity : (1 - amount) * 64;

  // 色 -> 候補番号のキャッシュ。1 チャンネル 64 段まで落として引く。
  // 誤差拡散が乗ると 0..255 をはみ出すので、そのときは素直に総当たりする。
  const cache = new Int16Array(1 << 18).fill(-1);
  const pick = (r, g, b) => {
    const inRange = r >= 0 && r <= 255 && g >= 0 && g <= 255 && b >= 0 && b <= 255;
    let key = -1;
    if (inRange) {
      key = ((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2);
      const hit = cache[key];
      if (hit >= 0) return hit;
    }
    const yy = r * 0.299 + g * 0.587 + b * 0.114;
    const cb = (b - yy) * 0.564;
    const cr = (r - yy) * 0.713;
    let best = 0, bestD = Infinity;
    for (let i = 0; i < n; i++) {
      const dy = yy - eff[i * 3], dcb = cb - eff[i * 3 + 1], dcr = cr - eff[i * 3 + 2];
      let d = dy * dy + CHROMA * (dcb * dcb + dcr * dcr);
      if (bias && isPattern[i]) { const t = Math.sqrt(d) + bias; d = t * t; }
      if (d < bestD) { bestD = d; best = i; }
    }
    if (key >= 0) cache[key] = best;
    return best;
  };

  // 誤差拡散は float で溜める必要があるので、RGB だけ作業用にコピーする。
  const buf = new Float32Array(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    const p = i * 4;
    const a = src[p + 3] / 255;
    // 透明なところは紙の色として扱う。そうしないと下に残ったゴミ色に
    // 引っぱられて、ふちに変な網が出る。
    buf[i * 3] = src[p] * a + paper[0] * (1 - a);
    buf[i * 3 + 1] = src[p + 1] * a + paper[1] * (1 - a);
    buf[i * 3 + 2] = src[p + 2] * a + paper[2] * (1 - a);
  }

  const spread = (i, er, eg, eb, f) => {
    buf[i * 3] += er * f; buf[i * 3 + 1] += eg * f; buf[i * 3 + 2] += eb * f;
  };

  const usage = new Map();

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const p = i * 4;

      // α をどうするか先に決める（網にするか、しきい値で切るか）
      const alpha = src[p + 3];
      let opaque;
      if (!keepAlpha) opaque = true;
      else if (edgeDither) opaque = alpha > (BAYER4[(y & 3) * 4 + (x & 3)] + 0.5) * 16;
      else opaque = alpha >= alphaThreshold;

      const r = buf[i * 3], g = buf[i * 3 + 1], b = buf[i * 3 + 2];
      const ci = pick(r, g, b);
      const cand = candidates[ci];

      if (opaque) {
        const col = cand.pattern && maskAt(cand.pattern, x, y, scale) ? cand.b : cand.a;
        od[p] = col[0]; od[p + 1] = col[1]; od[p + 2] = col[2]; od[p + 3] = 255;
        if (cand.brushId) usage.set(cand.brushId, (usage.get(cand.brushId) || 0) + 1);
      } else {
        od[p] = od[p + 1] = od[p + 2] = od[p + 3] = 0;
      }

      if (errorMix > 0) {
        // 配るのは「刷り色の平均」とのズレ。実際に置いた 1 ピクセルの色との
        // 差を配ると、網の目そのものが誤差として暴れてしまう。
        const er = (r - cand.eff[0]) * errorMix;
        const eg = (g - cand.eff[1]) * errorMix;
        const eb = (b - cand.eff[2]) * errorMix;
        if (x + 1 < w) spread(i + 1, er, eg, eb, 7 / 16);
        if (y + 1 < h) {
          if (x > 0) spread(i + w - 1, er, eg, eb, 3 / 16);
          spread(i + w, er, eg, eb, 5 / 16);
          if (x + 1 < w) spread(i + w + 1, er, eg, eb, 1 / 16);
        }
      }
    }
  }

  return { image: out, usage };
}
