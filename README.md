# HLS Analyzer

視聴中のページの上に小窓（HUD）を重ね、HLS の再生品質をリアルタイム表示する Chrome 拡張。

[WebRTC Analyzer](https://github.com/a211chan/WebRTC-analyzer) から派生。小窓・エクスポート・設定画面の作りは共通で、収集層とメトリクスが HLS 用に入れ替わっている。

```
HLS ANALYZER                 ⚠ 1  ⤓ ⚙ – ×
example.com · LIVE                 playing
↓ HLS 1280x720               avc1 / mp4a
  variant   ╭──╮╭─╮      3/3 · 3.03 Mbps
  解像度                        1280×720
  fps       ────────              30 fps
  buffer    ╰─╮╭──╮                8.2 s
  余裕度    ─╮╰╯                    ×3.4
  DL速度    ╭╮╭──╮              9.8 Mbps
  segment                 1.42 MB / 1180 ms
  ライブ遅延 ───╯╰─                12.4 s
  stall                       2 回 / 1.8 s
  切替                              3 回
```

## HLS には getStats() が無い

WebRTC には `RTCPeerConnection.getStats()` という標準の統計APIがあったが、**HLS には等価なものが存在しない**。そこで3つの層から集めている。

| 層 | 手段 | 取れるもの |
|---|---|---|
| ネットワーク | `fetch` / `XMLHttpRequest` をラップ | セグメントのバイト数・完全ダウンロード時間・HTTPステータス |
| プレイリスト | `.m3u8` の中身を解析 | ビットレート階段（BANDWIDTH / RESOLUTION）、LIVE/VOD、セグメント尺、**いまどのバリアントを再生中か** |
| 再生 | `<video>` + `getVideoPlaybackQuality()` | 実解像度・FPS・バッファ長・stall・ドロップフレーム |

いずれも**プレーヤー非依存**。hls.js / video.js(VHS) / Shaka のどれでも動く。特にバリアントの判別は、プレーヤーのAPIを一切使わず「取得したセグメントURLが、どのメディアプレイリストに載っているか」の照合で行っている。

Chrome デスクトップは `<video>` のネイティブHLS再生に対応しないため、HLS は必ず JS プレーヤーが MSE 経由で再生する。つまり `fetch` / `XHR` を押さえれば取りこぼしが無い。

## インストール

1. Chrome で `chrome://extensions` を開く
2. 右上の「デベロッパーモード」を ON
3. 「パッケージ化されていない拡張機能を読み込む」→ このフォルダを選択

ツールバーのアイコンをクリックすると小窓の表示 / 非表示が切り替わる。

## 表示している値

| 表示 | 意味 | 取得元 |
|---|---|---|
| variant | 何段目のバリアントか / 宣言ビットレート | マスタープレイリストの `AVERAGE-BANDWIDTH`（無ければ `BANDWIDTH`） |
| 解像度 | **実際に画面に出ている**解像度 | `video.videoWidth × videoHeight` |
| fps | デコードされたフレームレート | `getVideoPlaybackQuality().totalVideoFrames` の差分 |
| buffer | 先読みできている秒数 | `video.buffered` の該当レンジ終端 − `currentTime` |
| **余裕度** | **セグメント尺 ÷ ダウンロード時間** | 下記参照 |
| DL速度 | 直近5セグメントの実測スループット | バイト数 ÷ ダウンロード時間 |
| segment | 直近セグメントのサイズとダウンロード時間 | fetch / XHR の実測 |
| ライブ遅延 | ライブ端からの距離 | `seekable.end − currentTime`（**LIVE のときだけ**） |
| stall | リバッファの回数と累積時間 | `waiting` → `playing` の間隔 |
| ドロップ | 表示を捨てたフレームの割合 | `droppedVideoFrames` の差分 |
| 切替 | バリアント切替の累積回数 | セグメントURLとプレイリストの照合 |
| PL再読込 | プレイリストの再読込間隔 | 取得時刻の差分（LIVE のみ） |
| HTTPエラー | 4xx/5xx と通信失敗の累積 | fetch / XHR のステータス |

### 余裕度がいちばん効く

```
余裕度 = セグメントの尺(秒) ÷ そのセグメントのダウンロードにかかった時間(秒)
```

**1.0 を割ると、ダウンロードが再生に追いつかない。** バッファを食い潰していずれ必ず stall する。逆に言えば、まだ stall していなくてもこの値が 1 に近づいていれば破綻は時間の問題で、**stall より先に出る予兆**になる。HLS の健全性を1つの数字で見るならこれ。

ローカルやキャッシュヒットでは数千倍になるので、表示は `×99+` で頭打ちにしている（判断に使うのは 1.0 付近で、大きい側の精度は要らない）。

### 「解像度」と「variant」がずれることがある

バリアント切替の直後、**ネットワークは新しいバリアントを取得しているのに、画面にはまだバッファ済みの古い映像が出ている**ことがある。この2つが違う値を指すのは異常ではなく、切替が進行中であることを示している。

## しきい値

WebRTC と違い、HLS には**低いほど悪い指標**がある。設定画面では `↓` を付けて「以下」で判定していることを示す。

| 項目 | 向き | warn | crit |
|---|---|---|---|
| buffer | ↓ 低いほど悪い | 5 秒以下 | 2 秒以下 |
| 余裕度 | ↓ 低いほど悪い | 2.0 以下 | 1.0 以下 |
| ドロップ | 高いほど悪い | 1 % | 5 % |
| ライブ遅延 | 高いほど悪い | 30 秒 | 60 秒 |
| stall（直近1サンプルの増分） | 高いほど悪い | 1 回 | 2 回 |
| HTTPエラー（同上） | 高いほど悪い | 1 件 | 1 件 |

stall と HTTPエラーは累積値ではなく**増分**で判定する。累積のままだと一度増えたきり永久に警告が出続けるため。

## エクスポート

`⤓` から CSV / JSON を書き出す。1行 = 1サンプルで27項目。CSV は **BOM 付き UTF-8 + CRLF**、`time_local` 列にローカル時刻が入るので Excel でそのまま開ける。

履歴はメモリ上にのみ持つ。ページを離れると消えるので、**書き出しは再生中に行うこと**。既定の保持時間は30分。

## 構成

```
manifest.json
src/inject/patch.js          MAIN world / 全フレーム / document_start
                             fetch・XHR の差替、m3u8 解析、<video> 追跡
src/content/bridge.js        ISOLATED / 全フレーム / document_start
                             上り: メトリクスを Service Worker へ中継
                             下り: 更新間隔を MAIN world へ postMessage
src/bg/sw.js                 Service Worker
src/content/overlay.js       HUD 描画・履歴保持・スパークライン・エクスポート
src/content/overlay-style.js Shadow DOM に注入する HUD のスタイル
src/common/config.js         設定の既定値とマージ処理
src/options/                 設定画面
test/                        検証用ページ（後述）
```

アーキテクチャ（MAIN world 注入 → bridge → Service Worker → 小窓、フルスクリーン時の再配置、設定の伝搬）は WebRTC Analyzer と共通。設計の経緯はそちらの README と履歴を参照。

### ポーリングの再開条件

セグメント取得のたびに集計タイマーを起こしているが、それだけでは足りない。**VOD を全部バッファし終えると新規の取得が起きなくなり**、その状態で hls.js がレベル切替でメディアを一瞬デタッチすると `readyState` が 0 に落ちて「監視対象なし」と判定され、タイマーが止まったまま復帰しなくなる（検証中に実際に踏んだ）。

そこで `play` / `playing` / `waiting` / `loadedmetadata` / `loadeddata` / `seeking` を **document のキャプチャ段階**で拾って再開させている。メディア系イベントはバブリングしないが、キャプチャなら拾えるので、ポーリングを増やさずに済む。

なお `.m3u8` を一度も踏んでいないページではこの再開を行わない。`<all_urls>` に注入される以上、非HLSページのコストはゼロにしておく必要がある。

## 検証

### テスト用HLSの生成

素材ファイル不要。ffmpeg が合成パターンから3段のビットレート階段を作る。

```bash
./test/make-stream.sh 48
```

720p/3000k・480p/1500k・360p/650k の VOD が `test/stream/` に生成される（git管理外）。

### サーバの起動

```bash
python3 test/serve.py
```

`python3 -m http.server` ではなく `test/serve.py` を使うこと。ブラウザが JS をキャッシュして書き換えが反映されない事故を防ぐため、常に `Cache-Control: no-store` を返す。

| URL | 用途 |
|---|---|
| http://localhost:8732/test/loopback.html | 拡張を読み込んだ状態で開く。右上に小窓が出れば成功 |
| http://localhost:8732/test/standalone.html | 拡張なしで収集と描画だけを検証（`test/shim.js` が chrome.* を代替） |
| http://localhost:8732/test/options-preview.html | 拡張なしで設定画面を検証 |

バリアントのボタンで切替を起こせる。`window.__hls` から hls.js のインスタンスを直接触れる。

```js
__hls.currentLevel = 0
```

### 実ネットワークでの確認

ローカルはダウンロードが速すぎて余裕度が数千倍になり、判断材料にならない。DevTools の Network throttling で帯域を絞ると、余裕度が 1.0 に近づいて stall に至る過程を再現できる。

### デバッグの入口

| 見る場所 | 対象 |
|---|---|
| ページの DevTools コンソール | `patch.js`（MAIN world） |
| DevTools > Sources > Content scripts | `bridge.js` / `overlay.js` |
| `chrome://extensions` の「Service Worker」リンク | `sw.js` |

HUD の中身はコンソールから触れる（Shadow Root は `open`）。

```js
document.querySelector('[data-hla]').shadowRoot.querySelector('.hud')
```

## 既知の制限

- **URL の拡張子で判別している**。`.m3u8` / `.ts` / `.m4s` / `.mp4` などを見ているため、拡張子を持たない署名付きURLや、クエリでセグメントを出し分けるCDNでは取りこぼす（[#1](https://github.com/a211chan/HLS-analyzer/issues/1)）
- **1フレームに複数のHLS再生があると、いちばん大きい `<video>` を代表として表示する**。ネットワーク側の集計はフレーム単位なので、複数ストリームが混ざる
- **履歴はページを離れると消える**
- **`<video>` 要素そのものがフルスクリーンの場合は重ねられない**。video は子要素を描画しないため
- **Safari のネイティブHLS再生には使えない**。取得がブラウザ内部で行われ JS から見えない。Chrome デスクトップでは該当しない
- **LL-HLS の部分セグメント（`#EXT-X-PART`）は未対応**。余裕度の分母がセグメント尺のままになり、ライブ遅延の精度も出ない（[#2](https://github.com/a211chan/HLS-analyzer/issues/2)）
