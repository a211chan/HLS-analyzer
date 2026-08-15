/*
 * HLS Analyzer — 中継層（ISOLATED world / 全フレーム / document_start）
 *
 * 双方向の橋渡しをする。
 *   上り: MAIN world の patch.js が postMessage したメトリクス → Service Worker
 *   下り: chrome.storage の設定（ポーリング間隔）→ MAIN world の patch.js
 *
 * MAIN world から window.top.postMessage で直接親へ送る手もあるが、
 * クロスオリジンだと targetOrigin: '*' が必要になりメトリクスがページ側の
 * スクリプトから読めてしまう。SW を経由すれば拡張の世界の中で完結する。
 */
(() => {
  'use strict';

  const CHANNEL = 'hls-analyzer';

  window.addEventListener('message', (event) => {
    // 出所の検証。ページ側の任意のスクリプトが偽メトリクスを送れるため必須。
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.__hlaChannel !== CHANNEL) return;

    // patch.js が先に立ち上がっていた場合の設定要求
    if (data.type === 'hello') {
      pushConfig();
      return;
    }

    if (data.type !== 'stats' || !Array.isArray(data.players) || !data.net) return;

    try {
      chrome.runtime.sendMessage({
        __hlaChannel: CHANNEL,
        type: 'stats',
        net: data.net,
        players: data.players,
        // 複数フレームを区別するためのラベル。about:blank / blob: では host が空になる
        host: location.host || location.protocol || 'frame',
      });
    } catch (_) {
      // 拡張の再読み込み直後は context が無効化されている。次の tick で復帰する。
    }
  });

  /** MAIN world はストレージを読めないので、こちらから送り込む */
  function pushConfig() {
    chrome.storage.local
      .get('intervalMs')
      .then(({ intervalMs }) => {
        window.postMessage(
          { __hlaChannel: CHANNEL, type: 'config', intervalMs: intervalMs ?? 1000 },
          '*'
        );
      })
      .catch(() => {});
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.intervalMs) pushConfig();
  });

  // bridge が先に立ち上がっていた場合に備えて、こちらからも一度送る
  pushConfig();
})();
