# プライバシーポリシー / Privacy Policy — HLS Analyzer

最終更新: 2026-09-26

## 収集・送信するデータ
HLS Analyzer は、個人情報・閲覧履歴・通信内容を含め、**いかなるデータも外部へ送信しません**。テレメトリや解析 SDK は含まれていません。

## 端末内で扱うデータ
- ページが行う `fetch` / `XMLHttpRequest` のうち HLS のプレイリスト（`.m3u8`）とセグメントについて、バイト数・ダウンロード時間・HTTP ステータスを計測します。プレイリストは再生中のバリアントを特定するためにのみ解析します。
- `<video>` 要素から解像度・フレームレート・バッファ長・stall 回数などの数値を読み取ります。
- **セグメント／プレイリストの URL は保存しません**（署名付きトークンを含みうるため、計測用のメモリ内に留めます）。メディアの中身は保持せず、バイト数を数えながら読み捨てます。
- `chrome.storage.local` には設定値のみを保存します。
- 計測ログと小窓の位置は `chrome.storage.session`（メモリ上の領域）にタブ単位で保持します。ログにはページのタイトルと URL（クエリ文字列を除く）が付きます。ブラウザを閉じると消去され、ディスクには書き込みません。
- エクスポートはユーザーが明示的に操作した場合にのみ、`chrome.downloads` で端末内に保存します。

## 第三者提供
データを第三者へ提供・販売・譲渡することはありません。

---

HLS Analyzer does not collect or transmit any data off the device. Byte counts, timings and HTTP status of HLS playlist/segment requests, and playback numbers from `<video>`, are used only to render the on-page overlay. Segment and playlist URLs are never stored, and media content is discarded as it is counted. Only settings are stored in `chrome.storage.local`; measurement logs (with page title and URL without query string) and overlay position are kept in memory-only `chrome.storage.session` and are cleared when the browser closes. No data is sold or shared with third parties.

連絡先 / Contact: https://github.com/a211chan/HLS-analyzer/issues
