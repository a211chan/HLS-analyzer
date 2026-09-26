/*
 * HLS Analyzer — 書き出しの単一の出どころ
 *
 * 小窓（overlay.js）と設定画面（options.js）の両方が、同じ列定義で CSV / JSON を
 * 組み立てる。列がずれると「小窓から出したログ」と「設定画面から出したログ」が
 * 別物になってしまうので、定義はここ1か所だけに置く。
 *
 * 履歴の永続化（chrome.storage.local への書き出しと読み戻し）もここに置く。
 *
 * 保存形式（キーはすべて "hla:" で始まる。設定のキーとは衝突しない）
 *   hla:s:<sid>      セッションの概要 { id, host, start, end, rows, chunks }
 *   hla:c:<sid>:<n>  n 番目の書き出し分 { metas: {k: meta}, rows: [[k, sample], ...] }
 *
 * 書き出しのたびに概要と新しいチャンクを足すだけで、既存のキーは読み直さない。
 * 1ページ = 1セッションで、キーはタブごとに分かれるので、タブ間の競合も起きない。
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
    // 直近の取得が init（#EXT-X-MAP）だったか。init は余裕度・DL速度の計算に使わない
    ['segment_kind', (m, s) => s.segKind],
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

  /** UTF-8 の文字列を data: URL にする。chrome.downloads は data: を受け付ける */
  function dataUrl(text, mime) {
    const bytes = new TextEncoder().encode(text);
    let bin = '';
    // 一度に渡すと引数が多すぎて RangeError になるので分割して詰める
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return `data:${mime};base64,${btoa(bin)}`;
  }

  // ------------------------------------------------------------ 永続化

  const SESSION = 'hla:s:';
  const CHUNK = 'hla:c:';

  function newSessionId() {
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  /** 1回ぶんの書き出し。概要とチャンクを同時に set する */
  function writeChunk(session, metas, rows) {
    const n = session.chunks++;
    session.rows += rows.length;
    session.end = Date.now();
    return chrome.storage.local.set({
      [SESSION + session.id]: { ...session },
      [CHUNK + session.id + ':' + n]: { metas, rows },
    });
  }

  async function allKeys() {
    if (chrome.storage.local.getKeys) return chrome.storage.local.getKeys();
    return Object.keys(await chrome.storage.local.get(null));
  }

  /** 保存済みセッションの概要一覧（新しい順） */
  async function listSessions() {
    const keys = (await allKeys()).filter((k) => k.startsWith(SESSION));
    if (!keys.length) return [];
    const got = await chrome.storage.local.get(keys);
    return Object.values(got)
      .filter((v) => v && typeof v.id === 'string')
      .sort((a, b) => b.start - a.start);
  }

  /** セッションの全サンプルを { meta, s } の時刻順で返す（build にそのまま渡せる） */
  async function loadRows(session) {
    const keys = [];
    for (let i = 0; i < session.chunks; i++) keys.push(CHUNK + session.id + ':' + i);
    const got = await chrome.storage.local.get(keys);
    const out = [];
    for (const k of keys) {
      const c = got[k];
      if (!c || !Array.isArray(c.rows)) continue;
      for (const [mk, s] of c.rows) if (c.metas[mk]) out.push({ meta: c.metas[mk], s });
    }
    out.sort((a, b) => a.s.t - b.s.t);
    return out;
  }

  async function removeSessions(sessions) {
    const keys = [];
    for (const s of sessions) {
      keys.push(SESSION + s.id);
      for (let i = 0; i < s.chunks; i++) keys.push(CHUNK + s.id + ':' + i);
    }
    // 概要を書き損ねたチャンクが残らないよう、同じ接頭辞のキーも拾って消す
    const ids = new Set(sessions.map((s) => s.id));
    for (const k of await allKeys()) {
      if (k.startsWith(CHUNK) && ids.has(k.slice(CHUNK.length).split(':')[0])) keys.push(k);
    }
    if (keys.length) await chrome.storage.local.remove([...new Set(keys)]);
  }

  /** 最後の書き込みから hours 時間を過ぎたセッションを消す */
  async function prune(hours) {
    const cutoff = Date.now() - hours * 3600000;
    const old = (await listSessions()).filter((s) => s.end < cutoff);
    if (old.length) await removeSessions(old);
  }

  globalThis.HLA_EXPORT = {
    COLS,
    rows,
    build,
    dataUrl,
    fileStamp,
    localStamp,
    newSessionId,
    writeChunk,
    listSessions,
    loadRows,
    removeSessions,
    prune,
  };
})();
