/*
 * HLS Analyzer — 設定画面
 *
 * chrome.storage.local に書くだけ。オーバーレイ側は storage.onChanged で追従し、
 * ポーリング間隔は bridge.js が MAIN world へ postMessage で流し込む。
 */
(() => {
  'use strict';

  const { DEFAULTS, KEYS, merge } = HLA_CONFIG;

  /** 表示項目のラベル。DEFAULTS.fields のキーと対応する */
  const FIELD_LABELS = {
    variant: 'variant（バリアントと宣言ビットレート）',
    codec: 'codec（コーデック）',
    resolution: '解像度（実際に再生中のもの）',
    fps: 'FPS',
    buffer: 'buffer（バッファ長）',
    headroom: '余裕度（セグメント尺 ÷ DL時間）',
    download: 'DL速度（実測スループット）',
    segment: 'segment（直近セグメントのサイズとDL時間）',
    latency: 'ライブ遅延',
    stall: 'stall（リバッファ）',
    dropped: 'ドロップフレーム率',
    switches: 'バリアント切替回数',
    errors: 'HTTPエラー件数',
    reload: 'プレイリスト再読込間隔',
  };

  /** しきい値の行定義。dir は config.js 側の仕様で、ここでは表示のみ */
  const THRESHOLDS = [
    ['bufferSec', 'buffer', '秒', 'バッファ長。痩せると stall する。HLS におけるジッターバッファ相当'],
    ['headroom', '余裕度', '倍', 'セグメント尺 ÷ ダウンロード時間。1.0 を割ると再生に追いつかず必ず stall する'],
    ['droppedPct', 'ドロップ', '%', 'デコードしたが表示を捨てたフレームの割合'],
    ['latencySec', 'ライブ遅延', '秒', 'ライブ端からの距離。LIVE のときのみ意味がある'],
    ['stall', 'stall', '回', '直近1サンプルでの stall 増分（累積値ではない）'],
    ['freeze', 'フリーズ', '回', 'バッファは足りているのにデコードが進まなかった回数の増分。タブが非表示のときは数えない'],
    ['errors', 'HTTPエラー', '件', '直近1サンプルでの HTTP エラー増分（累積値ではない）'],
  ];

  const $ = (id) => document.getElementById(id);
  const statusEl = $('status');

  let cfg = structuredClone(DEFAULTS);

  // ------------------------------------------------------------ 組み立て

  function buildFields() {
    $('fields').innerHTML = Object.keys(DEFAULTS.fields)
      .map(
        (k) =>
          `<label class="field"><input type="checkbox" data-field="${k}"> ${escapeHtml(FIELD_LABELS[k] || k)}</label>`
      )
      .join('');
  }

  function buildThresholds() {
    document.querySelector('#thresholds tbody').innerHTML = THRESHOLDS.map(([key, label, unit, desc]) => {
      // buffer と余裕度は「低いほど悪い」。向きを取り違えると意味が反転するので明示する。
      const below = DEFAULTS.thresholds[key]?.dir === 'below';
      const dirMark = `<span class="dir">${below ? '以下' : '以上'}</span>`;
      return `
      <tr>
        <td class="name">${escapeHtml(label)}${below ? '<span class="inv" title="低いほど悪い指標">↓</span>' : ''}</td>
        <td><input type="number" data-th="${key}" data-lv="warn" step="any" min="0"> <span class="unit">${escapeHtml(unit)}</span>${dirMark}</td>
        <td><input type="number" data-th="${key}" data-lv="crit" step="any" min="0"> <span class="unit">${escapeHtml(unit)}</span>${dirMark}</td>
        <td class="desc">${escapeHtml(desc)}</td>
      </tr>`;
    }).join('');
  }

  // ------------------------------------------------------------ 反映

  function paint() {
    $('intervalMs').value = cfg.intervalMs;
    $('sparkSeconds').value = cfg.sparkSeconds;
    $('historyMinutes').value = cfg.historyMinutes;
    $('sparkline').checked = !!cfg.sparkline;
    $('alerts').checked = !!cfg.alerts;

    for (const el of document.querySelectorAll('[data-field]')) {
      el.checked = cfg.fields[el.dataset.field] !== false;
    }
    for (const el of document.querySelectorAll('[data-th]')) {
      const v = cfg.thresholds[el.dataset.th]?.[el.dataset.lv];
      el.value = v == null ? '' : v;
    }

    // スパークラインOFFなら範囲指定は意味がない
    $('sparkSeconds').disabled = !cfg.sparkline;
  }

  // ------------------------------------------------------------ 収集と保存

  function collect() {
    const next = structuredClone(cfg);

    next.intervalMs = clampInt($('intervalMs').value, 200, 10000, DEFAULTS.intervalMs);
    next.sparkSeconds = clampInt($('sparkSeconds').value, 10, 600, DEFAULTS.sparkSeconds);
    next.historyMinutes = clampInt($('historyMinutes').value, 1, 240, DEFAULTS.historyMinutes);
    next.sparkline = $('sparkline').checked;
    next.alerts = $('alerts').checked;

    for (const el of document.querySelectorAll('[data-field]')) {
      next.fields[el.dataset.field] = el.checked;
    }
    for (const el of document.querySelectorAll('[data-th]')) {
      const raw = el.value.trim();
      const v = raw === '' ? null : Number(raw);
      next.thresholds[el.dataset.th][el.dataset.lv] = Number.isFinite(v) ? v : null;
    }
    return next;
  }

  function clampInt(raw, lo, hi, fallback) {
    const v = Math.round(Number(raw));
    if (!Number.isFinite(v)) return fallback;
    return Math.min(hi, Math.max(lo, v));
  }

  async function save() {
    cfg = collect();
    // enabled は小窓の × とツールバーのアイコンが持つ状態なので、ここでは書かない
    const { enabled, ...rest } = cfg;
    await chrome.storage.local.set(rest);
    paint();
    flash('保存しました');
  }

  function flash(text) {
    statusEl.textContent = text;
    statusEl.classList.add('on');
    clearTimeout(flash.t);
    flash.t = setTimeout(() => statusEl.classList.remove('on'), 1600);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  }

  // ------------------------------------------------------------ 起動

  (async () => {
    buildFields();
    buildThresholds();
    cfg = merge(await chrome.storage.local.get(KEYS));
    paint();

    document.addEventListener('change', (e) => {
      if (e.target.matches('input')) save();
    });

    $('reset').addEventListener('click', async () => {
      await chrome.storage.local.remove(KEYS.filter((k) => k !== 'enabled'));
      cfg = structuredClone(DEFAULTS);
      paint();
      flash('既定値に戻しました');
    });
  })();
})();
