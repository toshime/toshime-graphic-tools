// うごメモ (うごくメモ帳 / Flipnote Studio DSi) のパターンブラシ 8 種。
//
// うごメモのペンは「色」と「網」の組み合わせで描く。ベタ塗りのほかに濃さの
// 違う網が 6 つと、よこ線・たて線があり、2 色しか置けない画面でも中間調を
// 出せる。ここではそれを小さなタイルマスクとして持つ: 1 = インク、0 = 紙。
//
// ドット配置は実機から起こされた素材（うごメモ風トーンの見本画像と、実機の
// パターンを抽出した PS ブラシ）をピクセル単位で読み取ったもの。
//   1  3x3 に 1 点            1/9  ≈ 11%
//   2  2x2 に 1 点            1/4  =  25%
//   3  4x4 に 6 点            6/16 = 37.5%
//   横 1 行おき               1/2
//   縦 1 列おき               1/2
//   4  市松                   1/2
//   5  2x2 に 3 点            3/4  =  75%
//   6  3x3 に白が 1 点        8/9  ≈ 89%
// 2 → 3 → 4 → 5 はインクの位置が入れ子（2 の点はすべて 3 にも 4 にも 5 にも
// ある）になっていて、濃さが隣に切り替わっても点の位置が飛ばない。

const RAW = [
  { id: 'p1', name: '1', tile: ['#..', '...', '...'] },
  { id: 'p2', name: '2', tile: ['#.', '..'] },
  { id: 'p3', name: '3', tile: ['#.#.', '...#', '#.#.', '.#..'] },
  { id: 'hline', name: '横', tile: ['#', '.'] },
  { id: 'vline', name: '縦', tile: ['#.'] },
  { id: 'p4', name: '4', tile: ['#.', '.#'] },
  { id: 'p5', name: '5', tile: ['#.', '##'] },
  { id: 'p6', name: '6', tile: ['###', '.##', '###'] },
];

/** 文字列タイル -> { bits, w, h, density } */
function compile(def) {
  const h = def.tile.length;
  const w = def.tile[0].length;
  const bits = new Uint8Array(w * h);
  let on = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = def.tile[y][x] === '#' ? 1 : 0;
      bits[y * w + x] = v;
      on += v;
    }
  }
  return { ...def, bits, w, h, density: on / (w * h) };
}

export const PATTERNS = RAW.map(compile);
export const PATTERN_BY_ID = new Map(PATTERNS.map((p) => [p.id, p]));

/** 濃さの階段になっている 6 つ（線を除く）。 */
export const DOT_BRUSHES = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'];
/**
 * 候補表に入れる順。横・縦・4 は同じ濃さなので、狙いの色が同じなら先に
 * 入れたものが必ず勝つ。市松（4）は 2 → 3 → 4 → 5 の入れ子に入っているので
 * こちらを線より先にして、階調の途中で点の位置が飛ばないようにする。線は
 * 4 をオフにしたときだけ出番がくる。
 */
export const LADDER_ORDER = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'hline', 'vline'];
/** 初期状態は 8 種すべてオン。 */
export const DEFAULT_BRUSHES = PATTERNS.map((p) => p.id);

/**
 * タイルを scale 倍に引き伸ばしたうえでの (x, y) のマスク値。
 * scale は 1 以上の整数で、1 マスが scale x scale ピクセルになる。
 */
export function maskAt(pattern, x, y, scale) {
  const tx = ((x / scale) | 0) % pattern.w;
  const ty = ((y / scale) | 0) % pattern.h;
  return pattern.bits[ty * pattern.w + tx];
}
