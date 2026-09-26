# Chrome ウェブストア 提出メモ

## 基本情報
- 名前: HLS Analyzer
- カテゴリ: デベロッパーツール
- 言語: 日本語
- プライバシーポリシー URL: https://github.com/a211chan/HLS-analyzer/blob/main/PRIVACY.md
- パッケージ: `./scripts/package.sh` → `dist/hls-analyzer-<version>.zip`

## 詳細説明（案）
視聴中のページで再生されている HLS（HTTP Live Streaming）の品質を、ページ上の小窓にリアルタイム表示します。hls.js / video.js / Shaka Player などプレーヤーを問わず、拡張子のない署名付きURL・バイトレンジ配信・fMP4 でも動作します。
- 再生中のバリアント（何段目か・宣言ビットレート）と実際の表示解像度
- バッファ長、ダウンロード余裕度（セグメント尺 ÷ ダウンロード時間。stall の予兆）、実測スループット
- stall（リバッファ）とフリーズ（バッファがあるのに映像が止まる）を区別して検出
- ドロップフレーム率、ライブ遅延、プレイリスト再読込間隔、HTTP エラー
- しきい値を超えた項目を色で警告
- 小窓を Picture-in-Picture の別ウィンドウに表示（動画を全画面にしても確認可能）
- 計測履歴をブラウザ内に保存し、設定画面から CSV/JSON で書き出し（配信停止後・タブを閉じた後も可）
データは一切外部へ送信しません。

HLS および HTTP Live Streaming は Apple Inc. の商標です。本拡張は Apple とは無関係の非公式ツールです。

## 単一用途（Single purpose）
Web ページ上で再生されている HLS ストリームの再生品質を、そのページ上に可視化すること。

## 権限の正当化
- **storage**: 表示設定・しきい値と計測履歴を保存するため（chrome.storage.local）。小窓の位置はタブ単位で chrome.storage.session に一時保存し、ブラウザ終了時に消える。
- **unlimitedStorage**: 長時間の計測履歴を chrome.storage.local に保存し、後から書き出せるようにするため（既定の容量上限を超えることがあるため）。データは端末内にのみ保存し、送信しない。
- **downloads**: ユーザーが小窓または設定画面で書き出しを操作したときに、計測履歴を CSV / JSON ファイルとして保存するため。自動でダウンロードすることはない。ページ側に書き出し内容を渡さないため、ページ DOM 経由ではなくこの API を使う。
- **ホスト権限 (http://*/*, https://*/*) / コンテンツスクリプト**: HLS を配信するサイトは特定できず（配信サービス・社内ポータル・独自プレーヤー等、iframe 埋め込みを含む）、任意のページで再生品質を計測・表示する必要があるため。取得した値は端末内での表示とエクスポートにのみ使用し、外部へは一切送信しない。
- **MAIN world スクリプト (patch.js)**: プレーヤーが行うプレイリスト／セグメントの取得（fetch / XMLHttpRequest）を計測し、`<video>` の再生状態を読むには、ページのコンテキストで実行する必要があるため。リクエストの内容は変更しない。URL で判別できない取得は、レスポンスの Content-Type ヘッダだけを見て HLS かどうかを判定し、HLS 以外の通信の本文は読まない。
- **リモートコード**: 使用しない（すべてのコードをパッケージに同梱）。

## データ使用の申告
「収集するデータ」はすべて未チェック。3 つの開示事項（販売しない / 無関係な用途に使わない / 信用判断に使わない）にチェック。

## 画像素材（store/images/）
- screenshot-1-overlay.png / screenshot-2-options.png（1280x800）
- promo-small-440x280.png（小プロモーションタイル）
- promo-marquee-1400x560.png（マーキープロモーションタイル）
- アイコン 128x128（icons/icon128.png を使用）

## 提出前の確認
- [ ] `manifest.json` の version を上げた
- [ ] `./scripts/package.sh` の zip を「パッケージ化されていない拡張機能」として読み込み直し、test/loopback.html で小窓・⧉・⤓ が動く
- [ ] リポジトリを public にする（プライバシーポリシー URL が外から見える必要がある）

## 提出手順（v0.6.0）
1. `main` に最新が入っていることを確認（プライバシーポリシー URL が main を指すため）
2. `./scripts/package.sh` → `dist/hls-analyzer-0.6.0.zip`
3. https://chrome.google.com/webstore/devconsole で「新しいアイテム」→ zip をアップロード
4. 「ストアの掲載情報」に上の詳細説明・カテゴリ・言語・画像を入力
5. 「プライバシーへの取り組み」に単一用途・権限の正当化・データ使用の申告を入力
6. 「配布」で公開範囲（公開 / 限定公開）を選び、審査に提出

## 審査担当者向けテスト手順（ダッシュボードの「テスト手順」欄に貼る）

ログインやアカウントは不要です。公開されている hls.js のデモページで確認できます。

```
No login or account is required.

1. Install the extension and open this public hls.js demo page:
   https://hlsjs.video-dev.org/demo/?src=https%3A%2F%2Ftest-streams.mux.dev%2Fx36xhzz%2Fx36xhzz.m3u8
2. Start playback if it does not start automatically.
   Within a few seconds a small "HLS ANALYZER" overlay appears at the top right of the page,
   showing variant, resolution, fps, buffer, headroom, download speed, stall, etc.
3. Click the toolbar icon to hide / show the overlay.
4. Click "⤓" in the overlay and choose "CSV で保存" (Save as CSV) to download the measured history.
5. Click "⚙" to open the options page. Reload the demo page once, then reopen the options page:
   the previous session is listed under "保存済みの履歴" (Saved history) and can be exported or deleted.
6. (Optional) Click "⧉" to move the overlay into a Picture-in-Picture window.

The overlay only appears on pages that play HLS. No data is sent anywhere.
```

## 提出前の自己確認手順

リポジトリの検証ページを使う。**提出する zip を展開したものを読み込むこと**（作業ツリーではなく、実際に出すファイルで確かめる）。

1. 準備
   ```bash
   ./test/make-stream.sh 48
   ./scripts/package.sh
   rm -rf /tmp/hla-check && mkdir /tmp/hla-check && unzip -q dist/hls-analyzer-*.zip -d /tmp/hla-check
   python3 test/serve.py
   ```
2. `chrome://extensions` → デベロッパーモード ON →「パッケージ化されていない拡張機能を読み込む」で `/tmp/hla-check` を選ぶ（開発版を読み込んでいれば先に無効化）
3. 次を順に確認する

| # | 開くページ / 操作 | 期待する結果 |
|---|---|---|
| 1 | http://localhost:8732/test/loopback.html | 右上に小窓。variant・解像度・buffer・余裕度・DL速度が出る |
| 2 | バリアントのボタンを押す | 「切替」が増え、variant 表示が追随する |
| 3 | `?src=noext` を付けて開く | 1 と同じ項目が出る（拡張子なしURLでも DL速度・余裕度が空欄にならない） |
| 4 | `?src=byterange` | 同上 |
| 5 | `?src=fmp4` | 余裕度・DL速度が出る（init で桁が狂わない） |
| 6 | ツールバーのアイコン | 小窓の表示 / 非表示 |
| 7 | `⤓` → CSV で保存 | ダウンロードされ、Excel で文字化けしない。`segment_kind` 列がある |
| 8 | `⧉` → 「video を直接全画面」 | 別ウィンドウの小窓が全画面の上に見える。⧉ をもう一度押すと戻る |
| 9 | ページをリロード → `⚙` | 「保存済みの履歴」に前のセッションがあり、CSV / JSON / 削除ができる |
| 10 | 2つのタブで開き、片方の小窓をドラッグ | もう片方の小窓は動かない |
| 11 | 公開デモ（上の審査用 URL） | 審査担当者と同じ手順で小窓が出る |
| 12 | HLS 以外のページ（例: https://example.com） | 小窓は出ない。コンソールにエラーが出ない |
