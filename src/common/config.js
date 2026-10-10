/*
 * HLS Analyzer — 設定の単一の出どころ
 *
 * コンテンツスクリプト（bridge / overlay）と設定画面の両方から読む。
 * コンテンツスクリプトは ES Modules を使えないので globalThis 経由で渡す。
 * 同一フレームに2回注入されうる（bridge 用と overlay 用のエントリ）ため、
 * 先頭でガードして二重定義を避ける。
 */
(() => {
  if (globalThis.HLA_CONFIG) return;

  const DEFAULTS = {
    /** 小窓の表示ON/OFF。ツールバーのアイコンが切り替える */
    enabled: true,
    /** 集計と描画の間隔(ms)。patch.js へ postMessage で伝える */
    intervalMs: 1000,
    /** スパークライン（折れ線）を出すか */
    sparkline: true,
    /** スパークラインが遡る秒数 */
    sparkSeconds: 60,
    /** エクスポート用に履歴を保持する分数 */
    historyMinutes: 30,
    /** 履歴を chrome.storage.local に書き出し、ページを離れても残すか */
    persist: true,
    /** 書き出した履歴を残す時間。最後の書き込みからこれだけ経つと消す */
    persistHours: 24,
    /** しきい値による色分けを行うか */
    alerts: true,

    /** 表示項目。false にすると小窓から消える */
    fields: {
      variant: true,
      codec: true,
      resolution: true,
      fps: true,
      buffer: true,
      headroom: true,
      download: true,
      segment: true,
      latency: true,
      stall: true,
      freeze: true,
      dropped: true,
      switches: true,
      errors: true,
      reload: true,
    },

    /*
     * しきい値。
     *
     * WebRTC と違い、HLS には「低いほど悪い」指標がある（バッファ長・余裕度）。
     * dir: 'below' がその向きを表す。dir は仕様なので設定画面からは変更できない。
     */
    thresholds: {
      /** バッファ長(秒)。痩せると stall する。ジッターバッファ相当 */
      bufferSec: { dir: 'below', warn: 5, crit: 2 },
      /** セグメント尺 ÷ DL時間。1.0 を割ると再生に追いつかない */
      headroom: { dir: 'below', warn: 2, crit: 1 },
      /** ドロップフレーム率(%) */
      droppedPct: { dir: 'above', warn: 1, crit: 5 },
      /** ライブ端からの遅延(秒) */
      latencySec: { dir: 'above', warn: 30, crit: 60 },
      /** 直近1サンプルでの stall 増分(回) */
      stall: { dir: 'above', warn: 1, crit: 2 },
      /** 直近1サンプルでのフリーズ増分(回)。バッファがあるのに絵が止まった回数 */
      freeze: { dir: 'above', warn: 1, crit: 2 },
      /** 直近1サンプルでの HTTP エラー増分(件) */
      errors: { dir: 'above', warn: 1, crit: 1 },
    },

    /*
     * 品質レポート（印刷用HTML → ブラウザの「PDFに保存」）。
     * 判定は上の thresholds をそのまま使う。レポート専用のしきい値は持たない。
     */
    report: {
      /** 表紙に出す題名 */
      title: 'HLS 再生品質レポート',
      /** 作成者・提出先など。空なら出さない */
      author: '',
      /** 複数セッションを選んだとき: 'combined' = 1冊にまとめる / 'separate' = セッションごとに別タブ */
      mode: 'combined',
      /** 出す章。false にすると章ごと省く */
      sections: {
        summary: true,
        kpi: true,
        judgement: true,
        charts: true,
        events: true,
        stream: true,
        conditions: true,
        criteria: true,
      },
      /** 時系列グラフの種類 */
      charts: {
        buffer: true,
        bitrate: true,
        headroom: true,
        latency: true,
        dropped: true,
      },
    },
  };

  const KEYS = Object.keys(DEFAULTS);

  /** 保存済みの値を既定値に重ねる。入れ子（fields / thresholds / report）は項目単位でマージする */
  function merge(stored) {
    const out = structuredClone(DEFAULTS);
    if (!stored) return out;

    for (const k of KEYS) {
      if (k === 'fields' || k === 'thresholds' || k === 'report') continue;
      if (stored[k] != null) out[k] = stored[k];
    }
    if (stored.fields) {
      for (const [k, v] of Object.entries(stored.fields)) {
        if (k in out.fields) out.fields[k] = v === true;
      }
    }
    if (stored.thresholds) {
      for (const [k, v] of Object.entries(stored.thresholds)) {
        if (!out.thresholds[k] || !v) continue;
        // dir は保存値で上書きさせない
        if ('warn' in v) out.thresholds[k].warn = v.warn;
        if ('crit' in v) out.thresholds[k].crit = v.crit;
      }
    }
    const r = stored.report;
    if (r && typeof r === 'object') {
      if (typeof r.title === 'string') out.report.title = r.title;
      if (typeof r.author === 'string') out.report.author = r.author;
      if (r.mode === 'combined' || r.mode === 'separate') out.report.mode = r.mode;
      for (const g of ['sections', 'charts']) {
        if (!r[g]) continue;
        for (const [k, v] of Object.entries(r[g])) {
          if (k in out.report[g]) out.report[g][k] = v === true;
        }
      }
    }
    return out;
  }

  async function load() {
    try {
      return merge(await chrome.storage.local.get(KEYS));
    } catch (_) {
      return structuredClone(DEFAULTS);
    }
  }

  globalThis.HLA_CONFIG = { DEFAULTS, KEYS, merge, load };
})();
