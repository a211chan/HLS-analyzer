/*
 * HLS Analyzer — 描画層（ISOLATED world / 全フレーム / document_idle）
 *
 * Service Worker から届いたメトリクスを Shadow DOM の小窓に描画し、
 * エクスポート用に履歴を保持する。
 *
 * 全フレームで動かしているのは、フルスクリーン対策のため。
 *   - 通常時   : トップフレームが全フレームぶんを集約して表示する
 *   - 全画面時 : フルスクリーンになった要素を含むフレームだけが表示する
 *     （position: fixed の要素はトップレイヤーの下に潜るので、フルスクリーン要素の
 *       配下に小窓を appendChild し直す必要がある。相手が iframe だと親からは
 *       重ねられないため、その iframe 自身に描かせる）
 */
(() => {
  'use strict';

  const CHANNEL = 'hls-analyzer';
  const IS_TOP = window.top === window;
  /** これだけ更新が途絶えたストリームは表示から落とす */
  const STALE_MS = 6000;
  const RENDER_MS = 500;

  let cfg = structuredClone(HLA_CONFIG.DEFAULTS);

  /** 現在値。フレーム単位。 key = frameId */
  const store = new Map();
  /** 履歴。フレーム単位。 key = frameId */
  const history = new Map();

  let collapsed = false;
  let pos = null; // ドラッグで動かした位置 {left, top}
  let hud = null;
  let body = null;
  let hostEl = null;
  let menuEl = null;
  let ticking = null;

  // ------------------------------------------------------------- 受信

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.__hlaChannel !== CHANNEL || msg.type !== 'stats') return;

    const now = Date.now();
    const host = msg.host || 'frame';
    // 再生中の <video> のうち、いちばん主たるもの1つを代表として扱う。
    // 1フレームに複数のHLS再生がある構成は稀で、あっても網羅より読みやすさを取る。
    const player = pickPlayer(msg.players);

    store.set(msg.frameId, { net: msg.net, player, host, at: now });
    record(msg.frameId, host, msg.net, player, now);

    if (!ticking) ticking = setInterval(render, RENDER_MS);
  });

  function pickPlayer(players) {
    if (!players || !players.length) return null;
    const playing = players.filter((p) => p.state === 'playing' || p.state === 'stalled');
    const pool = playing.length ? playing : players;
    // 解像度がいちばん大きいものを主たるプレーヤーとみなす
    return pool.slice().sort((a, b) => (b.w ?? 0) * (b.h ?? 0) - (a.w ?? 0) * (a.h ?? 0))[0];
  }

  /** 1サンプルを履歴に積む */
  function record(frameId, host, net, player, now) {
    let h = history.get(frameId);
    if (!h) {
      h = { meta: { host }, samples: [] };
      history.set(frameId, h);
    }
    h.samples.push({
      t: now,
      state: player?.state ?? null,
      w: player?.w ?? null,
      h: player?.h ?? null,
      fps: player?.fps ?? null,
      bufferSec: player?.bufferSec ?? null,
      latencySec: player?.latencySec ?? null,
      stalls: player?.stalls ?? null,
      stallSec: player?.stallSec ?? null,
      stallDelta: player?.stallDelta ?? null,
      droppedPct: player?.droppedPct ?? null,
      live: net.live,
      variantIndex: net.variantIndex,
      variantCount: net.variantCount,
      variantBps: net.variantBps,
      variantRes: net.variantRes,
      codecs: net.codecs,
      switches: net.switches,
      downloadBps: net.downloadBps,
      segBytes: net.segBytes,
      segMs: net.segMs,
      segDur: net.segDur,
      targetDur: net.targetDur,
      headroom: net.headroom,
      plReloadSec: net.plReloadSec,
      errors: net.errors,
    });

    const cutoff = now - cfg.historyMinutes * 60000;
    while (h.samples.length && h.samples[0].t < cutoff) h.samples.shift();
  }

  // ------------------------------------------------------------- 設定

  HLA_CONFIG.load().then((c) => {
    cfg = c;
    if (hud) applyState();
    render();
  });

  chrome.storage.local.get(['collapsed', 'pos']).then((v) => {
    collapsed = v.collapsed === true;
    pos = v.pos || null;
    if (hud) applyState();
  });

  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== 'local') return;
    if (changes.collapsed) collapsed = changes.collapsed.newValue === true;
    if (changes.pos) pos = changes.pos.newValue || null;
    if (HLA_CONFIG.KEYS.some((k) => k in changes)) cfg = await HLA_CONFIG.load();
    if (hud) applyState();
    render();
  });

  document.addEventListener('fullscreenchange', () => render());

  // ------------------------------------------------------------- 表示判定

  function fullscreenEl() {
    return document.fullscreenElement || null;
  }

  function shouldShow() {
    if (!cfg.enabled) return false;

    const fs = fullscreenEl();
    // <video> や <iframe> は子要素を描画しないので、その上には重ねられない。
    // iframe が全画面なら、その iframe 自身のオーバーレイが担当する。
    if (fs && (fs.tagName === 'VIDEO' || fs.tagName === 'IFRAME')) return false;
    // 子フレームは全画面のときだけ出る（通常時はトップの小窓と二重になる）
    if (!IS_TOP && !fs) return false;

    return live().length > 0;
  }

  function live() {
    const now = Date.now();
    for (const [k, v] of store) if (now - v.at > STALE_MS) store.delete(k);
    return [...store.entries()];
  }

  // ------------------------------------------------------------- DOM 構築

  function build() {
    hostEl = document.createElement('div');
    hostEl.setAttribute('data-hla', '');
    // ページのCSSが html > div などで我々のホストを掴んで transform を掛けると
    // 子の position: fixed が壊れる。インラインの !important で封じる。
    hostEl.style.cssText = 'all: initial !important;';

    // open にしておくと DevTools のコンソールから
    // document.querySelector('[data-hla]').shadowRoot で中身を触れる。
    const root = hostEl.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = HLA_STYLE;

    hud = document.createElement('div');
    hud.className = 'hud';
    hud.innerHTML = `
      <header>
        <span class="title">HLS Analyzer</span>
        <span class="alarm" hidden></span>
        <button data-act="export"   title="エクスポート">⤓</button>
        <button data-act="options"  title="設定">⚙</button>
        <button data-act="collapse" title="折りたたみ">–</button>
        <button data-act="close"    title="非表示（ツールバーのアイコンで戻せます）">×</button>
      </header>
      <div class="menu" hidden>
        <button data-act="csv">CSV で保存</button>
        <button data-act="json">JSON で保存</button>
        <button data-act="clear">履歴をクリア</button>
        <div class="menu-note"></div>
      </div>
      <div class="body"></div>`;

    body = hud.querySelector('.body');
    menuEl = hud.querySelector('.menu');

    hud.addEventListener('click', onClick);
    enableDrag(hud.querySelector('header'));
    // 小窓の外をクリックしたらメニューを閉じる
    document.addEventListener('click', (e) => {
      if (!menuEl.hidden && !e.composedPath().includes(hud)) menuEl.hidden = true;
    });

    root.append(style, hud);
    applyState();
  }

  function onClick(e) {
    const act = e.target.closest?.('[data-act]')?.dataset.act;
    if (!act) return;
    if (act === 'collapse') chrome.storage.local.set({ collapsed: !collapsed });
    else if (act === 'close') chrome.storage.local.set({ enabled: false });
    else if (act === 'options') chrome.runtime.sendMessage({ __hlaChannel: CHANNEL, type: 'open-options' });
    else if (act === 'export') menuEl.hidden = !menuEl.hidden;
    else if (act === 'csv') exportFile('csv');
    else if (act === 'json') exportFile('json');
    else if (act === 'clear') {
      history.clear();
      note('履歴をクリアしました');
    }
  }

  function note(text) {
    const el = menuEl.querySelector('.menu-note');
    el.textContent = text;
    clearTimeout(note.t);
    note.t = setTimeout(() => (el.textContent = ''), 4000);
  }

  function applyState() {
    hud.classList.toggle('collapsed', collapsed);
    hud.classList.toggle('spark', !!cfg.sparkline);
    if (collapsed) menuEl.hidden = true;
    if (pos) {
      hud.style.left = clamp(pos.left, 0, Math.max(0, innerWidth - 120)) + 'px';
      hud.style.top = clamp(pos.top, 0, Math.max(0, innerHeight - 28)) + 'px';
      hud.style.right = 'auto';
    } else {
      hud.style.left = 'auto';
      hud.style.right = '12px';
      hud.style.top = '12px';
    }
  }

  function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
  }

  function enableDrag(handle) {
    let dx = 0;
    let dy = 0;

    handle.addEventListener('pointerdown', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      const r = hud.getBoundingClientRect();
      dx = e.clientX - r.left;
      dy = e.clientY - r.top;
      handle.setPointerCapture(e.pointerId);
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp, { once: true });
      e.preventDefault();
    });

    function onMove(e) {
      pos = { left: e.clientX - dx, top: e.clientY - dy };
      applyState();
    }
    function onUp(e) {
      handle.removeEventListener('pointermove', onMove);
      handle.releasePointerCapture(e.pointerId);
      if (pos) chrome.storage.local.set({ pos });
    }
  }

  // ------------------------------------------------------------- 描画

  function render() {
    const show = shouldShow();

    if (!show) {
      if (hostEl && hostEl.parentNode) hostEl.remove();
      if (!store.size && ticking) {
        clearInterval(ticking);
        ticking = null;
      }
      return;
    }

    if (!hostEl) build();

    // フルスクリーン要素があればその配下へ移す（トップレイヤーに入れるため）
    const parent = fullscreenEl() || document.documentElement;
    if (hostEl.parentNode !== parent) parent.appendChild(hostEl);

    const entries = live().sort((a, b) => a[1].host.localeCompare(b[1].host));

    let alarms = 0;
    const html = entries.map(([frameId, entry]) => {
      const r = renderStream(frameId, entry);
      alarms += r.crit;
      return r.html;
    });

    body.innerHTML = html.join('') || '<div class="empty">no active stream</div>';

    const alarm = hud.querySelector('.alarm');
    alarm.hidden = !(cfg.alerts && alarms > 0);
    alarm.textContent = alarms > 0 ? `⚠ ${alarms}` : '';
  }

  function renderStream(frameId, entry) {
    const { net, player, host } = entry;
    const samples = history.get(frameId)?.samples ?? [];
    const state = player?.state ?? (net.errors ? 'error' : 'idle');

    const bufferLv = level('bufferSec', player?.bufferSec);
    const headroomLv = level('headroom', net.headroom);
    const droppedLv = level('droppedPct', player?.droppedPct);
    const latencyLv = level('latencySec', player?.latencySec);
    const stallLv = level('stall', player?.stallDelta);
    const errorLv = level('errors', deltaOf(samples, 'errors'));
    const crit = [bufferLv, headroomLv, droppedLv, latencyLv, stallLv, errorLv].filter((l) => l === 'crit').length;

    const mode = net.live === true ? 'LIVE' : net.live === false ? 'VOD' : '';
    const variant =
      net.variantIndex != null && net.variantCount
        ? `${net.variantIndex + 1}/${net.variantCount}` + (net.variantBps ? ` · ${bps(net.variantBps)}` : '')
        : net.variantBps
          ? bps(net.variantBps)
          : null;

    const items = [
      { key: 'variant', label: 'variant', value: variant },
      { key: 'resolution', label: '解像度', value: player?.w && player?.h ? `${player.w}×${player.h}` : null },
      { key: 'fps', label: 'fps', value: player?.fps != null ? fmtFps(player.fps) : null, field: 'fps' },
      // HLS におけるジッターバッファ相当。痩せると stall する。
      { key: 'buffer', label: 'buffer', value: sec(player?.bufferSec), level: bufferLv, field: 'bufferSec' },
      // 1.0 を割るとダウンロードが再生に追いつかない。HLS の健全性はまずここ。
      { key: 'headroom', label: '余裕度', value: ratio(net.headroom), level: headroomLv, field: 'headroom' },
      { key: 'download', label: 'DL速度', value: bps(net.downloadBps), field: 'downloadBps' },
      { key: 'segment', label: 'segment', value: segLabel(net), field: 'segMs' },
      { key: 'latency', label: 'ライブ遅延', value: sec(player?.latencySec), level: latencyLv, field: 'latencySec' },
      { key: 'stall', label: 'stall', value: stallLabel(player), level: stallLv, field: 'stalls' },
      { key: 'dropped', label: 'ドロップ', value: pct(player?.droppedPct), level: droppedLv, field: 'droppedPct' },
      { key: 'switches', label: '切替', value: net.switches ? `${net.switches} 回` : null, field: 'switches' },
      { key: 'reload', label: 'PL再読込', value: net.live ? sec(net.plReloadSec) : null, field: 'plReloadSec' },
      { key: 'errors', label: 'HTTPエラー', value: net.errors ? `${net.errors} 件` : null, level: errorLv, field: 'errors' },
    ];

    return {
      crit,
      html: `<div class="pc">
        <div class="pc-head">
          <span class="src">${esc(host)}${mode ? ` · ${mode}` : ''}</span>
          <span class="state state-${esc(state)}">${esc(state)}</span>
        </div>
        ${net.variantRes || net.codecs ? headLine(net) : ''}
        ${metrics(items, samples)}
      </div>`,
    };
  }

  function headLine(net) {
    return `<div class="stream-head">
      <span class="arrow in">↓</span>
      <span class="kind">HLS</span>
      <span class="head-main">${esc(net.variantRes || '')}</span>
      <span class="codec">${cfg.fields.codec ? esc(shortCodec(net.codecs)) : ''}</span>
    </div>`;
  }

  function segLabel(net) {
    if (net.segBytes == null || net.segMs == null) return null;
    return `${bytes(net.segBytes)} / ${Math.round(net.segMs)} ms`;
  }

  function stallLabel(player) {
    if (!player || player.stalls == null) return null;
    if (!player.stalls) return '0';
    return `${player.stalls} 回 / ${player.stallSec.toFixed(1)} s`;
  }

  /**
   * 値の一覧を描く。スパークラインONなら 1列（ラベル・折れ線・値）、
   * OFFなら 2列に詰める。
   */
  function metrics(items, samples) {
    const shown = items.filter((i) => i.value != null && i.value !== '' && cfg.fields[i.key] !== false);
    if (!shown.length) return '';

    if (!cfg.sparkline) {
      const cells = shown
        .map((i) => `<div><span class="k">${esc(i.label)}</span><span class="v ${i.level || ''}">${esc(i.value)}</span></div>`)
        .join('');
      return `<div class="kv">${cells}</div>`;
    }

    const rows = shown
      .map(
        (i) =>
          `<div><span class="k">${esc(i.label)}</span>` +
          `<span class="sp">${i.field ? sparkline(samples, i.field) : ''}</span>` +
          `<span class="v ${i.level || ''}">${esc(i.value)}</span></div>`
      )
      .join('');
    return `<div class="kvs">${rows}</div>`;
  }

  // ------------------------------------------------------------- スパークライン

  const SPARK_W = 84;
  const SPARK_H = 13;

  function sparkline(samples, field) {
    const from = Date.now() - cfg.sparkSeconds * 1000;
    const pts = [];
    for (const s of samples) if (s.t >= from && s[field] != null) pts.push(s);
    if (pts.length < 2) return '';

    let min = Infinity;
    let max = -Infinity;
    for (const p of pts) {
      const v = p[field];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    // 平坦なら中央に一本引く（0除算も避ける）
    if (max === min) {
      min -= 0.5;
      max += 0.5;
    }

    const t0 = pts[0].t;
    const span = Math.max(1, pts[pts.length - 1].t - t0);
    const pad = 1;
    const d = pts
      .map((p) => {
        const x = pad + ((p.t - t0) / span) * (SPARK_W - pad * 2);
        const y = SPARK_H - pad - ((p[field] - min) / (max - min)) * (SPARK_H - pad * 2);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');

    return `<svg class="spark" width="${SPARK_W}" height="${SPARK_H}" viewBox="0 0 ${SPARK_W} ${SPARK_H}"><polyline points="${d}"/></svg>`;
  }

  /** 累積カウンタの直近1サンプルでの増分。累積のままではアラートに使えない */
  function deltaOf(samples, field) {
    for (let i = samples.length - 1; i > 0; i--) {
      const a = samples[i - 1][field];
      const b = samples[i][field];
      if (a != null && b != null) return Math.max(0, b - a);
    }
    return null;
  }

  /**
   * しきい値判定。HLS には「低いほど悪い」指標（バッファ長・余裕度）があるので、
   * thresholds の dir で向きを切り替える。
   */
  function level(metric, v) {
    if (!cfg.alerts || v == null) return '';
    const t = cfg.thresholds[metric];
    if (!t) return '';
    const below = t.dir === 'below';
    const hit = (lim) => lim != null && (below ? v <= lim : v >= lim);
    if (hit(t.crit)) return 'crit';
    if (hit(t.warn)) return 'warn';
    return '';
  }

  // ------------------------------------------------------------- エクスポート

  const COLS = [
    ['time_local', (m, s) => localStamp(s.t)],
    ['time_iso', (m, s) => new Date(s.t).toISOString()],
    ['host', (m) => m.host],
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
    ['dropped_pct', (m, s) => round(s.droppedPct, 3)],
    ['playlist_reload_sec', (m, s) => round(s.plReloadSec, 2)],
    ['http_errors', (m, s) => s.errors],
  ];

  function allRows() {
    const rows = [];
    for (const h of history.values()) for (const s of h.samples) rows.push({ meta: h.meta, s });
    rows.sort((a, b) => a.s.t - b.s.t);
    return rows;
  }

  function exportFile(kind) {
    const rows = allRows();
    if (!rows.length) {
      note('まだ履歴がありません');
      return;
    }

    let blob;
    if (kind === 'csv') {
      const lines = [COLS.map((c) => c[0]).join(',')];
      for (const { meta, s } of rows) lines.push(COLS.map((c) => csvCell(c[1](meta, s))).join(','));
      // BOM(U+FEFF) + CRLF。Excel で開いたときに文字化けせず、行も崩れない。
      blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    } else {
      const out = rows.map(({ meta, s }) => Object.fromEntries(COLS.map((c) => [c[0], c[1](meta, s) ?? null])));
      blob = new Blob([JSON.stringify(out, null, 1)], { type: 'application/json' });
    }

    download(blob, `hls-${fileStamp()}.${kind}`);
    note(`${rows.length} 行を書き出しました`);
  }

  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    (document.body || document.documentElement).appendChild(a);
    a.click();
    setTimeout(() => {
      a.remove();
      URL.revokeObjectURL(url);
    }, 2000);
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

  function fileStamp() {
    const d = new Date();
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  }

  // ------------------------------------------------------------- 整形

  function bps(v) {
    if (v == null) return null;
    if (v >= 1e6) return (v / 1e6).toFixed(2) + ' Mbps';
    if (v >= 1e3) return Math.round(v / 1e3) + ' kbps';
    return Math.round(v) + ' bps';
  }

  function bytes(v) {
    if (v == null) return null;
    if (v >= 1024 * 1024) return (v / 1024 / 1024).toFixed(2) + ' MB';
    if (v >= 1024) return Math.round(v / 1024) + ' KB';
    return v + ' B';
  }

  function sec(v) {
    if (v == null) return null;
    return (v >= 100 ? Math.round(v) : v.toFixed(1)) + ' s';
  }

  function ratio(v) {
    if (v == null) return null;
    // ローカルやキャッシュヒットだと数千倍になる。桁が暴れて読みにくいので頭打ちにする。
    // 判断に使うのは 1.0 付近であって、大きい側の精度は要らない。
    if (v >= 100) return '×99+';
    return '×' + v.toFixed(1);
  }

  function pct(v) {
    if (v == null) return null;
    return v.toFixed(2) + ' %';
  }

  function fmtFps(v) {
    return (v < 10 ? v.toFixed(1) : Math.round(v)) + ' fps';
  }

  function shortCodec(codecs) {
    if (!codecs) return '';
    // "avc1.640028,mp4a.40.2" → "avc1 / mp4a"
    return String(codecs)
      .split(',')
      .map((c) => c.trim().split('.')[0])
      .filter(Boolean)
      .join(' / ');
  }

  const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
  function esc(s) {
    return String(s ?? '').replace(/[&<>"]/g, (c) => ESCAPES[c]);
  }
})();
