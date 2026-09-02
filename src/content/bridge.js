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

    // patch.js の出力だけを信用することはできない。同じ world にページ本体の
    // スクリプトが同居しており、event.source === window は偽装できてしまう。
    // ここで形を作り直し、以降の層には既知の形しか流さない。
    const net = netRow(data.net);
    if (!net) return;

    try {
      chrome.runtime.sendMessage({
        __hlaChannel: CHANNEL,
        type: 'stats',
        net,
        players: playerRows(data.players),
        // 複数フレームを区別するためのラベル。about:blank / blob: では host が空になる
        host: (location.host || location.protocol || 'frame').slice(0, MAX_STR),
      });
    } catch (_) {
      // 拡張の再読み込み直後は context が無効化されている。次の tick で復帰する。
    }
  });

  // --------------------------------------------------------------- 検証

  /*
   * ページ側は同じ world から偽のメトリクスを postMessage できる。素通しすると、
   *   - 想定外の型が描画層の整形関数に流れ込み、小窓が止まる
   *   - 長大な文字列を小窓に出せる（codecs / variantRes はそのまま表示される）
   *   - players を大量に送りつけて描画層を膨らませられる
   * が成立する。信用するのではなく、既知のフィールドだけを写し取って作り直す。
   */

  const MAX_PLAYERS = 8;
  const MAX_STR = 64;

  function str(v, max = MAX_STR) {
    return typeof v === 'string' && v ? v.slice(0, max) : null;
  }

  function num(v) {
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  }

  function bool(v) {
    return typeof v === 'boolean' ? v : null;
  }

  function netRow(n) {
    if (!n || typeof n !== 'object') return null;
    return {
      live: bool(n.live),
      targetDur: num(n.targetDur),
      segDur: num(n.segDur),
      variantIndex: num(n.variantIndex),
      variantCount: num(n.variantCount),
      variantBps: num(n.variantBps),
      variantRes: str(n.variantRes, 24),
      codecs: str(n.codecs, 64),
      switches: num(n.switches),
      cached: bool(n.cached),
      repeat: bool(n.repeat),
      downloadBps: num(n.downloadBps),
      segBytes: num(n.segBytes),
      segMs: num(n.segMs),
      headroom: num(n.headroom),
      plReloadSec: num(n.plReloadSec),
      errors: num(n.errors),
    };
  }

  function playerRows(list) {
    return list.slice(0, MAX_PLAYERS).map(playerRow).filter(Boolean);
  }

  function playerRow(p) {
    if (!p || typeof p !== 'object') return null;
    const id = str(p.id, 32);
    if (!id) return null;

    return {
      id,
      state: str(p.state, 16) || 'unknown',
      w: num(p.w),
      h: num(p.h),
      fps: num(p.fps),
      bufferSec: num(p.bufferSec),
      latencySec: num(p.latencySec),
      stalls: num(p.stalls),
      stallSec: num(p.stallSec),
      stallDelta: num(p.stallDelta),
      freezes: num(p.freezes),
      freezeSec: num(p.freezeSec),
      freezeDelta: num(p.freezeDelta),
      visible: bool(p.visible),
      droppedPct: num(p.droppedPct),
    };
  }

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
