/*
 * WebRTC Analyzer — 中継層（ISOLATED world / 全フレーム / document_start）
 *
 * MAIN world の patch.js が postMessage したメトリクスを受け取り、
 * Service Worker 経由でオーバーレイ側へ渡す。
 *
 * MAIN world から window.top.postMessage で直接親へ送る手もあるが、
 * クロスオリジンだと targetOrigin: '*' が必要になりメトリクスがページ側の
 * スクリプトから読めてしまう。SW を経由すれば拡張の世界の中で完結する。
 */
(() => {
  'use strict';

  const CHANNEL = 'webrtc-analyzer';

  window.addEventListener('message', (event) => {
    // 出所の検証。ページ側の任意のスクリプトが偽メトリクスを送れるため必須。
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.__wraChannel !== CHANNEL || data.type !== 'stats') return;
    if (!Array.isArray(data.pcs)) return;

    try {
      chrome.runtime.sendMessage({
        __wraChannel: CHANNEL,
        type: 'stats',
        pcs: data.pcs,
        // 複数フレームのPCを区別するためのラベル。about:blank / blob: では host が空になる
        host: location.host || location.protocol || 'frame',
      });
    } catch (_) {
      // 拡張の再読み込み直後は context が無効化されている。次の tick で復帰する。
    }
  });
})();
