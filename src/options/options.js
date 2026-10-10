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

  /** レポートの章。DEFAULTS.report.sections のキーと対応する */
  const REPORT_SECTIONS = {
    summary: '総合判定と所見（文章）',
    kpi: '主要指標（数値カード）',
    judgement: 'しきい値判定の表',
    charts: '時系列グラフ',
    events: 'イベント一覧（停止・フリーズ・エラー・画質切替）',
    stream: '配信構成（バリアント・コーデック・セグメント尺）',
    conditions: '計測条件（間隔・非表示時間など）',
    criteria: '判定基準（しきい値の一覧）',
  };
  const REPORT_CHARTS = {
    buffer: 'バッファ長',
    bitrate: 'ビットレートとDL速度',
    headroom: '余裕度',
    latency: 'ライブ遅延（LIVEのみ）',
    dropped: 'ドロップフレーム率',
  };

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

  function buildReport() {
    const box = (attr, labels) =>
      Object.entries(labels)
        .map(([k, l]) => `<label class="field"><input type="checkbox" ${attr}="${k}"> ${escapeHtml(l)}</label>`)
        .join('');
    $('reportSections').innerHTML = box('data-rsec', REPORT_SECTIONS);
    $('reportCharts').innerHTML = box('data-rchart', REPORT_CHARTS);
  }

  // ------------------------------------------------------------ 反映

  function paint() {
    $('intervalMs').value = cfg.intervalMs;
    $('sparkSeconds').value = cfg.sparkSeconds;
    $('historyMinutes').value = cfg.historyMinutes;
    $('persist').checked = !!cfg.persist;
    $('persistHours').value = cfg.persistHours;
    $('sparkline').checked = !!cfg.sparkline;
    $('alerts').checked = !!cfg.alerts;
    $('autoStart').checked = !!cfg.autoStart;
    $('toggleEnabled').textContent = cfg.enabled ? 'OFFにする' : 'ONにする';
    $('enabledState').textContent = cfg.enabled ? '現在: ON' : '現在: OFF';

    for (const el of document.querySelectorAll('[data-field]')) {
      el.checked = cfg.fields[el.dataset.field] !== false;
    }
    for (const el of document.querySelectorAll('[data-th]')) {
      const v = cfg.thresholds[el.dataset.th]?.[el.dataset.lv];
      el.value = v == null ? '' : v;
    }

    $('reportTitle').value = cfg.report.title;
    $('reportAuthor').value = cfg.report.author;
    for (const el of document.querySelectorAll('input[name="reportMode"]')) el.checked = el.value === cfg.report.mode;
    for (const el of document.querySelectorAll('[data-rsec]')) el.checked = cfg.report.sections[el.dataset.rsec] !== false;
    for (const el of document.querySelectorAll('[data-rchart]')) el.checked = cfg.report.charts[el.dataset.rchart] !== false;
    // グラフの章を外したら、グラフの種類は選んでも意味がない
    for (const el of document.querySelectorAll('[data-rchart]')) el.disabled = !cfg.report.sections.charts;

    // スパークラインOFFなら範囲指定は意味がない
    $('sparkSeconds').disabled = !cfg.sparkline;
    $('persistHours').disabled = !cfg.persist;
  }

  // ------------------------------------------------------------ 収集と保存

  function collect() {
    const next = structuredClone(cfg);

    next.intervalMs = clampInt($('intervalMs').value, 200, 10000, DEFAULTS.intervalMs);
    next.sparkSeconds = clampInt($('sparkSeconds').value, 10, 600, DEFAULTS.sparkSeconds);
    next.historyMinutes = clampInt($('historyMinutes').value, 1, 240, DEFAULTS.historyMinutes);
    next.persist = $('persist').checked;
    next.persistHours = clampInt($('persistHours').value, 1, 720, DEFAULTS.persistHours);
    next.sparkline = $('sparkline').checked;
    next.alerts = $('alerts').checked;
    next.autoStart = $('autoStart').checked;

    for (const el of document.querySelectorAll('[data-field]')) {
      next.fields[el.dataset.field] = el.checked;
    }
    for (const el of document.querySelectorAll('[data-th]')) {
      const raw = el.value.trim();
      const v = raw === '' ? null : Number(raw);
      next.thresholds[el.dataset.th][el.dataset.lv] = Number.isFinite(v) ? v : null;
    }
    next.report.title = $('reportTitle').value.trim() || DEFAULTS.report.title;
    next.report.author = $('reportAuthor').value.trim();
    next.report.mode = document.querySelector('input[name="reportMode"]:checked')?.value || DEFAULTS.report.mode;
    for (const el of document.querySelectorAll('[data-rsec]')) next.report.sections[el.dataset.rsec] = el.checked;
    for (const el of document.querySelectorAll('[data-rchart]')) next.report.charts[el.dataset.rchart] = el.checked;
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

  // ------------------------------------------------------------ 保存済みの履歴

  const { listSessions, loadRows, removeSessions, build, dataUrl, fileStamp, localStamp } = HLA_EXPORT;
  let sessions = [];

  async function paintSessions() {
    sessions = await listSessions();
    $('pickAll').checked = false;
    const tbody = document.querySelector('#sessions tbody');
    if (!sessions.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="desc">まだありません</td></tr>';
      return;
    }
    tbody.innerHTML = sessions
      .map(
        (s, i) => `
      <tr>
        <td><input type="checkbox" data-pick="${i}"></td>
        <td>${escapeHtml(localStamp(s.start).slice(0, 19))}</td>
        <td>${escapeHtml(localStamp(s.end).slice(0, 19))}</td>
        <td class="name">${escapeHtml(s.host)}</td>
        <td>${s.rows}</td>
        <td class="ops">
          <button data-sess="${i}" data-op="report">レポート</button>
          <button data-sess="${i}" data-op="csv">CSV</button>
          <button data-sess="${i}" data-op="json">JSON</button>
          <button data-sess="${i}" data-op="del" class="danger">削除</button>
        </td>
      </tr>`
      )
      .join('');
  }

  async function onSession(e) {
    const btn = e.target.closest('[data-sess]');
    if (!btn) return;
    const s = sessions[Number(btn.dataset.sess)];
    if (!s) return;
    const op = btn.dataset.op;
    if (op === 'report') {
      openReports([s]);
      return;
    }
    if (op === 'del') {
      await removeSessions([s]);
      await paintSessions();
      flash('削除しました');
      return;
    }
    const rows = await loadRows(s);
    if (!rows.length) {
      flash('データがありません');
      return;
    }
    const { text, mime } = build(rows, op);
    // 設定画面は拡張のページなので chrome.downloads を直接呼べる
    await chrome.downloads.download({ url: dataUrl(text, mime), filename: `hls-${fileStamp(s.start)}.${op}`, saveAs: false });
    flash(`${rows.length} 行を書き出しました`);
  }

  /*
   * レポートは拡張内のページ（src/report/report.html）として開く。
   * セッションIDだけを URL で渡し、中身は向こうで storage から読み直す。
   * 「分ける」ときはセッションごとにタブを開き、それぞれで印刷→PDF保存してもらう。
   */
  function openReports(list) {
    if (!list.length) {
      flash('セッションを選んでください');
      return;
    }
    const groups = cfg.report.mode === 'separate' ? list.map((s) => [s]) : [list];
    for (const g of groups) {
      const url = chrome.runtime.getURL('src/report/report.html') + '?s=' + g.map((s) => encodeURIComponent(s.id)).join(',');
      chrome.tabs.create({ url });
    }
  }

  function picked() {
    return [...document.querySelectorAll('#sessions tbody [data-pick]:checked')]
      .map((el) => sessions[Number(el.dataset.pick)])
      .filter(Boolean)
      // レポートの中では古い順に並べる
      .sort((a, b) => a.start - b.start);
  }

  // ------------------------------------------------------------ 起動

  (async () => {
    buildFields();
    buildThresholds();
    buildReport();
    cfg = merge(await chrome.storage.local.get(KEYS));
    paint();
    await paintSessions();

    $('toggleEnabled').addEventListener('click', async () => {
      await chrome.storage.local.set({ enabled: !cfg.enabled });
    });
    // アイコンや小窓の × で切り替わったときもボタン表示を追従させる
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes.enabled) return;
      cfg.enabled = changes.enabled.newValue === true;
      paint();
    });

    document.addEventListener('change', (e) => {
      // 履歴の選択チェックは設定ではない
      if (e.target.matches('input:not([data-pick])')) save();
    });

    $('reset').addEventListener('click', async () => {
      await chrome.storage.local.remove(KEYS.filter((k) => k !== 'enabled'));
      cfg = structuredClone(DEFAULTS);
      paint();
      flash('既定値に戻しました');
    });

    document.querySelector('#sessions').addEventListener('click', onSession);
    $('refreshSessions').addEventListener('click', paintSessions);
    $('reportSelected').addEventListener('click', () => openReports(picked()));
    $('pickAll').addEventListener('change', (e) => {
      for (const el of document.querySelectorAll('#sessions tbody [data-pick]')) el.checked = e.target.checked;
    });
    $('clearSessions').addEventListener('click', async () => {
      if (!confirm('保存済みの履歴をすべて削除しますか？')) return;
      await removeSessions(await listSessions());
      await paintSessions();
      flash('すべて削除しました');
    });
  })();
})();
