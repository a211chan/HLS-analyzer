# プライバシーポリシー / Privacy Policy — HLS Analyzer

最終更新: 2026-10-10

## 収集・送信するデータ
HLS Analyzer は、個人情報・閲覧履歴・通信内容を含め、**いかなるデータも外部へ送信しません**。テレメトリや解析 SDK は含まれていません。

## 端末内で扱うデータ
- ページが行う `fetch` / `XMLHttpRequest` のうち HLS のプレイリスト（`.m3u8`）とセグメントについて、バイト数・ダウンロード時間・HTTP ステータスを計測します。プレイリストは再生中のバリアントを特定するためにのみ解析します。
- HLS の取得かどうかを判別するため、URL から判別できない取得についてはレスポンスの `Content-Type` ヘッダのみを確認します。HLS 以外と判定した通信の本文やその他のヘッダは読み取りません。
- `<video>` 要素から解像度・フレームレート・バッファ長・stall 回数などの数値を読み取ります。
- **セグメント／プレイリストの URL は保存しません**（署名付きトークンを含みうるため、計測用のメモリ内に留めます）。メディアの中身は保持せず、バイト数を数えながら読み捨てます。
- `chrome.storage.local` には設定値と計測履歴を保存します。履歴に含まれるのはホスト名と上記の数値のみで、セグメントの URL やページのパス・クエリは含みません。最後の記録から一定時間（既定24時間）で自動的に削除され、設定画面から即時に全削除することもできます。
- 小窓の位置は `chrome.storage.session`（メモリ上の領域）にタブ単位で保持し、ブラウザを閉じると消去されます。
- エクスポートはユーザーが明示的に操作した場合にのみ、`chrome.downloads` で端末内に保存します。
- 品質レポート（PDF）は、拡張機能内のページとして端末内で組み立てます。PDF への変換はブラウザの印刷機能で行い、外部のサービスやライブラリは使用しません。レポートに含まれるのは、上記の計測履歴（ホスト名と数値）と、ユーザーが設定画面で入力した題名・作成者のみです。
- 小窓からレポートを開く場合、そのページの計測履歴を `chrome.storage.session`（メモリ上の領域）に一時的に置き、レポートのタブが読み込んだ時点で削除します。この受け渡しはページの DOM を経由しないため、閲覧中のサイトから内容を読み取ることはできません。

## 第三者提供
データを第三者へ提供・販売・譲渡することはありません。

---

HLS Analyzer does not collect or transmit any data off the device. To tell HLS requests apart, only the `Content-Type` response header is checked for requests whose URL is not recognizable; bodies and other headers of non-HLS requests are never read. Byte counts, timings and HTTP status of HLS playlist/segment requests, and playback numbers from `<video>`, are used only to render the on-page overlay. Segment and playlist URLs are never stored, and media content is discarded as it is counted. Settings and measurement history (host name and numbers only, auto-deleted after 24 hours by default) are stored in `chrome.storage.local`; overlay position is kept in memory-only `chrome.storage.session`. Quality reports (PDF) are built locally as an extension page and converted with the browser's own print function; they contain only the measurement history above plus the title/author the user enters in settings. When a report is opened from the overlay, the history is passed through memory-only `chrome.storage.session` (never through the page DOM) and deleted as soon as the report tab reads it. No data is sold or shared with third parties.

連絡先 / Contact: https://github.com/a211chan/HLS-analyzer/issues
