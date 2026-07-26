# UgoSketch / うごスケッチ

ドット絵・イラスト向けのブラウザツール集。すべての処理がブラウザ内で完結し、画像はどこにもアップロードされません。
ページ右上のボタンでツールを行き来できます。

| ツール | できること | |
|---|---|---|
| **UgoSketch** | 画像を手描き風に揺らして、スプライトシート・連番PNG・GIFに書き出す | [開く](https://toshime.github.io/ugo-sketch/) |
| **KiriSketch** | スプライトシートなど分離した絵をバラして、個別のPNGに切り出す | [開く](https://toshime.github.io/ugo-sketch/kirisketch.html) |

## UgoSketch

- **ゆらぎ (Warp)** — 画像全体をサイン波/パーリンノイズ等でUV歪みさせる線ブレアニメ（AllIn1 SpriteShader の HandDrawn や Line Boiler 風）
- **輪郭SDF (実験的)** — 減色した各色領域を符号付き距離場として個別に揺らし、多色でもエッジをくっきり保つ
- **ピクセルパーフェクト** — 揺れをドット単位にスナップし、ドット絵の輪郭を崩さない（拡大済みドット絵にも対応）
- **減色** — median cut + k-means、ディザ（Bayer / Floyd–Steinberg）、パレット共有
- **書き出し** — スプライトシートPNG（座標メタJSON付き）、連番PNG（ZIP）、GIF、クリップボードコピー、SNS用の整数倍アップスケール

書き出したファイルは `元のファイル名_ugosketch.gif` のように、読み込んだ画像の名前がそのまま入ります。

## KiriSketch

- **自動検出** — 背景から浮いている塊を連結成分でひとつずつ探して切り出す。背景は透明／指定色を自動判定（スポイトあり）
- **結合距離** — 少し離れた部品どうしを1枚にまとめる。目や手足が分かれているキャラ向け
- **グリッド** — 列×行、またはセルサイズ(px)で等間隔に分割。開始位置・間隔の指定、空セルのスキップ、セルごとのトリミング
- **仕上げ** — 余白の追加、整数倍の拡大、すべて同じサイズに揃える（中央寄せ）、背景色の透明化
- **書き出し** — プレビューやサムネイルで要らない1枚を外してから、個別PNG／まとめてZIP（座標メタJSON付き）

書き出し名は `元のファイル名_01.png`、ZIPは `元のファイル名_kirisketch.zip`。

## ローカルで動かす

ESモジュールを使うため `file://` では動きません。簡易HTTPサーバー経由で開いてください。

```bash
python3 -m http.server 8000
# → http://localhost:8000
```

macOS なら `start.command` をダブルクリックしても起動できます。

## 構成

ビルド不要・依存ライブラリなしの静的サイト。

```
index.html        UgoSketch
kirisketch.html   KiriSketch
style.css         共通スタイル
kiri.css          KiriSketch 固有のスタイル
src/*.js          UgoSketch のパイプライン・書き出し
src/kiri/*.js     KiriSketch の領域検出・UI
```
