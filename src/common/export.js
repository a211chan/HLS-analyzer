/*
 * HLS Analyzer — 書き出しの単一の出どころ
 *
 * 小窓（overlay.js）と設定画面（options.js）の両方が、同じ列定義で CSV / JSON を
 * 組み立てる。列がずれると「小窓から出したログ」と「設定画面から出したログ」が
 * 別物になってしまうので、定義はここ1か所だけに置く。
 *
 * コンテンツスクリプトは ES Modules を使えないので globalThis 経由で渡す。
 * 同一フレームに2回読み込まれうるため、先頭でガードする。
 */
(() => {
  if (globalThis.HLA_EXPORT) return;

  /** [列名, (meta, sample) => 値] */
  const COLS = [
    ['time_local', (m, s) => localStamp(s.t)],
    ['time_iso', (m, s) => new Date(s.t).toISOString()],
    ['host', (m) => m.host],
    ['frame', (m) => m.frame],
    ['mode', (m, s) => (s.live === true ? 'LIVE' : s.live === false ? 'VOD' : '')],
    ['state', (m, s) => s.state],
    ['width', (m, s) => s.w],
    ['height', (m, s) => s.h],
    ['fps', (m, s) => round(s.fps, 1)],
    ['variant_index', (m, s) => (s.variantIndex != null ? s.variantIndex + 1 : null)],
    ['variant_count', (m, s) => s.variantCount],
    ['variant_bps', (m, s) => s.variantBps],
    ['variant_resolution', (m, s) => s.variantRes],
    ['codecs', (m, s) => s.codecs],
    ['variant_switches', (m, s) => s.switches],
    ['buffer_sec', (m, s) => round(s.bufferSec, 2)],
    ['headroom', (m, s) => round(s.headroom, 2)],
    ['download_bps', (m, s) => round(s.downloadBps, 0)],
    ['segment_bytes', (m, s) => s.segBytes],
    ['segment_download_ms', (m, s) => round(s.segMs, 0)],
    ['segment_duration_sec', (m, s) => round(s.segDur, 3)],
    ['target_duration_sec', (m, s) => s.targetDur],
    ['live_latency_sec', (m, s) => round(s.latencySec, 2)],
    ['stall_count', (m, s) => s.stalls],
    ['stall_total_sec', (m, s) => round(s.stallSec, 2)],
    ['freeze_count', (m, s) => s.freezes],
    ['freeze_total_sec', (m, s) => round(s.freezeSec, 2)],
    ['visible', (m, s) => (s.visible == null ? '' : s.visible ? 'true' : 'false')],
    ['dropped_pct', (m, s) => round(s.droppedPct, 3)],
    // 空欄は「判定できなかった」。false（実ダウンロード）と区別すること。
    ['from_cache', (m, s) => (s.cached == null ? '' : s.cached ? 'true' : 'false')],
    // 2回目以降のURL。キャッシュを判定できない配信ではこちらが手がかりになる。
    ['segment_repeat', (m, s) => (s.repeat == null ? '' : s.repeat ? 'true' : 'false')],
    ['playlist_reload_sec', (m, s) => round(s.plReloadSec, 2)],
    ['http_errors', (m, s) => s.errors],
  ];

  /** {meta, samples} の集まりを、時刻順に並べた1行ずつの配列へ均す */
  function rows(streams) {
    const out = [];
    for (const h of streams) {
      if (!h || !Array.isArray(h.samples)) continue;
      for (const s of h.samples) out.push({ meta: h.meta || {}, s });
    }
    out.sort((a, b) => a.s.t - b.s.t);
    return out;
  }

  /** 行を CSV / JSON の本文にする。戻り値はそのまま Blob / data: URL に渡せる */
  function build(list, kind) {
    if (kind === 'csv') {
      const lines = [COLS.map((c) => c[0]).join(',')];
      for (const { meta, s } of list) lines.push(COLS.map((c) => csvCell(c[1](meta, s))).join(','));
      // BOM(U+FEFF) + CRLF。Excel で開いたときに文字化けせず、行も崩れない。
      return { text: '﻿' + lines.join('\r\n'), mime: 'text/csv;charset=utf-8' };
    }
    const out = list.map(({ meta, s }) => Object.fromEntries(COLS.map((c) => [c[0], c[1](meta, s) ?? null])));
    return { text: JSON.stringify(out, null, 1), mime: 'application/json' };
  }

  function csvCell(v) {
    if (v == null) return '';
    const s = String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  function round(v, digits) {
    return typeof v === 'number' && Number.isFinite(v) ? +v.toFixed(digits) : null;
  }

  function pad(n, w = 2) {
    return String(n).padStart(w, '0');
  }

  /** Excel がそのまま日時として解釈できる形式 */
  function localStamp(t) {
    const d = new Date(t);
    return (
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
      `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
    );
  }

  /** ファイル名に使う時刻。sw.js 側の検証正規表現と形を合わせてある */
  function fileStamp(t = Date.now()) {
    const d = new Date(t);
    return (
      `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
      `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
    );
  }

  globalThis.HLA_EXPORT = { COLS, rows, build, fileStamp, localStamp };
})();
