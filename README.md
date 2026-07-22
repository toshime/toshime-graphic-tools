# UgoSketch / うごスケッチ

画像を手描き風に揺らして、スプライトシート・連番PNG・GIFに書き出すブラウザツール。
すべての処理がブラウザ内で完結し、画像はどこにもアップロードされません。

**▶ [オンラインで開く](https://toshime.github.io/ugo-sketch/)**

## 機能

- **ゆらぎ (Warp)** — 画像全体をサイン波/パーリンノイズ等でUV歪みさせる線ブレアニメ（AllIn1 SpriteShader の HandDrawn や Line Boiler 風）
- **輪郭SDF (実験的)** — 減色した各色領域を符号付き距離場として個別に揺らし、多色でもエッジをくっきり保つ
- **ピクセルパーフェクト** — 揺れをドット単位にスナップし、ドット絵の輪郭を崩さない（拡大済みドット絵にも対応）
- **減色** — median cut + k-means、ディザ（Bayer / Floyd–Steinberg）、パレット共有
- **書き出し** — スプライトシートPNG（座標メタJSON付き）、連番PNG（ZIP）、GIF、クリップボードコピー、SNS用の整数倍アップスケール

## ローカルで動かす

ESモジュールを使うため `file://` では動きません。簡易HTTPサーバー経由で開いてください。

```bash
python3 -m http.server 8000
# → http://localhost:8000
```

macOS なら `start.command` をダブルクリックしても起動できます。

## 構成

ビルド不要・依存ライブラリなしの静的サイト。`index.html` / `style.css` / `src/*.js` のみ。
