/*
 * HLS Analyzer — 品質レポート
 *
 * 保存済みの履歴（hla:s: / hla:c:）から印刷用のHTMLを組み立てる。
 * PDF化はブラウザの印刷（「PDFに保存」）に任せるので、ライブラリもフォントも同梱しない。
 *
 * URL: report.html?s=<sessionId>,<sessionId>...
 *   複数あれば1冊にまとめる（冒頭に比較表）。分けるかどうかは設定画面が決め、
 *   分けるときはセッションごとにこのページを開く。
 *
 * 判定は設定画面のしきい値（cfg.thresholds）だけを使う。レポート専用の基準は持たない。
 *   - 連続値（バッファ長・余裕度・ドロップ率・ライブ遅延）
 *       「低いほど悪い」指標は下位5%値、「高いほど悪い」指標は上位5%値をしきい値と比べる。
 *       一瞬の落ち込みで全体を不良にしないため。超過していた時間の割合も併記する。
 *       再生開始前（最初に playing になるまで）のサンプルは除く。
 *   - 回数（stall・フリーズ・HTTPエラー）
 *       期間中の合計回数をしきい値と比べる。
 *   総合判定は、重大が1つでもあれば「不良」、警告が1つでもあれば「注意」、それ以外は「良好」。
 */
(() => {
  'use strict';

  const { merge, KEYS } = HLA_CONFIG;
  const { listSessions, loadRows, localStamp, fileStamp } = HLA_EXPORT;

  const $ = (id) => document.getElementById(id);

  /** 判定の段階 */
  const LV = { ok: 0, warn: 1, crit: 2 };
  const VERDICT = [
    { key: 'ok', label: '良好' },
    { key: 'warn', label: '注意' },
    { key: 'crit', label: '不良' },
  ];

  /** 連続値の指標。key は cfg.thresholds のキー、field はサンプルの項目 */
  const CONT = [
    { key: 'bufferSec', field: 'bufferSec', label: 'バッファ長', unit: '秒', digits: 1 },
    { key: 'headroom', field: 'headroom', label: '余裕度', unit: '倍', digits: 2 },
    { key: 'droppedPct', field: 'droppedPct', label: 'ドロップフレーム率', unit: '%', digits: 2 },
    { key: 'latencySec', field: 'latencySec', label: 'ライブ遅延', unit: '秒', digits: 1, liveOnly: true },
  ];
  /** 回数の指標。field は累積値の項目 */
  const COUNT = [
    { key: 'stall', field: 'stalls', secField: 'stallSec', label: '再生停止（stall）', unit: '回' },
    { key: 'freeze', field: 'freezes', secField: 'freezeSec', label: 'フリーズ', unit: '回' },
    { key: 'errors', field: 'errors', label: 'HTTPエラー', unit: '件' },
  ];

  // ------------------------------------------------------------ 起動

  (async () => {
    $('print').addEventListener('click', () => window.print());
    const root = $('report');
    try {
      const cfg = merge(await chrome.storage.local.get(KEYS));
      const ids = (new URLSearchParams(location.search).get('s') || '').split(',').filter(Boolean);
      const all = await listSessions();
      const picked = ids.map((id) => all.find((s) => s.id === id)).filter(Boolean).sort((a, b) => a.start - b.start);
      if (!picked.length) {
        root.innerHTML = '<p class="loading">対象のセッションが見つかりません。保存期間を過ぎて削除された可能性があります。</p>';
        return;
      }

      const sessions = [];
      for (const s of picked) sessions.push({ session: s, players: analyzeSession(await loadRows(s), cfg) });

      root.innerHTML = render(sessions, cfg);
      // 「PDFに保存」の既定のファイル名になる
      document.title = `hls-report-${fileStamp(picked[0].start)}${picked.length > 1 ? `-${picked.length}` : ''}`;
    } catch (e) {
      root.innerHTML = `<p class="loading">レポートを作れませんでした: ${esc(e && e.message)}</p>`;
    }
  })();

  // ------------------------------------------------------------ 集計

  /** セッション内をプレーヤー（フレーム）ごとに分けて集計する */
  function analyzeSession(rows, cfg) {
    const groups = new Map();
    for (const { meta, s } of rows) {
      const k = String(meta.frame ?? '');
      if (!groups.has(k)) groups.set(k, { meta, samples: [] });
      groups.get(k).samples.push(s);
    }
    const all = [...groups.values()].map((g) => analyze(g.meta, g.samples, cfg));
    // 再生していないフレーム（広告枠など）は落とす。全滅なら一番長いものだけ残す
    const played = all.filter((p) => p.playSec > 0);
    if (played.length) return played.sort((a, b) => b.playSec - a.playSec);
    return all.sort((a, b) => b.n - a.n).slice(0, 1);
  }

  function analyze(meta, samples, cfg) {
    samples.sort((a, b) => a.t - b.t);
    const n = samples.length;

    // サンプル間隔。中央値の3倍を超える間は「記録の欠け」とみなし、重みに数えない
    const gaps = [];
    for (let i = 1; i < n; i++) gaps.push(samples[i].t - samples[i - 1].t);
    const step = median(gaps) || 1000;
    const dt = samples.map((s, i) => (i === 0 ? step : Math.min(s.t - samples[i - 1].t, step * 3)) / 1000);
    const holes = gaps.filter((g) => g > step * 3).length;

    let totalSec = 0, playSec = 0, hiddenSec = 0, pausedSec = 0;
    let started = -1;
    samples.forEach((s, i) => {
      totalSec += dt[i];
      if (s.state === 'playing' || s.state === 'stalled') playSec += dt[i];
      if (s.state === 'paused' || s.state === 'ended') pausedSec += dt[i];
      if (s.visible === false) hiddenSec += dt[i];
      if (started < 0 && s.state === 'playing') started = i;
    });
    const live = samples.some((s) => s.live === true);
    const th = cfg.thresholds;

    // 連続値
    const cont = {};
    for (const m of CONT) {
      const vals = [];
      const w = [];
      if (!(m.liveOnly && !live)) {
        for (let i = Math.max(started, 0); i < n; i++) {
          const s = samples[i];
          const v = s[m.field];
          if (typeof v !== 'number' || !Number.isFinite(v)) continue;
          // 非表示のタブはブラウザが描画を間引くので、ドロップ率は当てにならない
          if (m.key === 'droppedPct' && s.visible === false) continue;
          if (m.key === 'headroom' && s.segKind === 'init') continue;
          vals.push(v);
          w.push(dt[i]);
        }
      }
      cont[m.key] = contStats(vals, w, th[m.key]);
    }

    // 回数（累積値の増分を拾う）と、そのイベント
    const events = [];
    const counts = {};
    for (const m of COUNT) {
      let total = 0, sec = 0, prev = null, prevSec = null;
      samples.forEach((s, i) => {
        const v = s[m.field];
        const vs = m.secField ? s[m.secField] : null;
        if (typeof v === 'number') {
          // 値が減ったらプレーヤーが作り直されたとみなし、その値を増分として足す
          const d = prev == null ? 0 : v >= prev ? v - prev : v;
          if (d > 0) {
            total += d;
            events.push({ t: s.t, i, kind: m.key, n: d });
          }
          prev = v;
        }
        if (typeof vs === 'number') {
          if (prevSec != null) sec += vs >= prevSec ? vs - prevSec : vs;
          prevSec = vs;
        }
      });
      counts[m.key] = { total, sec, level: levelOf(th[m.key], total) };
    }
    // stall・フリーズの継続時間: 発生から state が戻るまでの累積秒の増分
    for (const e of events) {
      if (e.kind !== 'stall' && e.kind !== 'freeze') continue;
      const f = e.kind === 'stall' ? 'stallSec' : 'freezeSec';
      const before = e.i > 0 ? samples[e.i - 1][f] : null;
      let j = e.i;
      while (j + 1 < n && samples[j + 1][f] != null && samples[j + 1][f] > samples[j][f]) j++;
      const after = samples[j][f];
      if (typeof before === 'number' && typeof after === 'number' && after >= before) e.sec = after - before;
      e.end = samples[j].t;
      e.cause = e.kind === 'stall' ? stallCause(samples, e.i) : null;
    }

    // 画質の切替
    let up = 0, down = 0;
    const variants = new Map();
    let prevV = null;
    samples.forEach((s, i) => {
      if (s.variantIndex == null) return;
      const key = s.variantIndex;
      const v = variants.get(key) || { index: key, bps: s.variantBps, res: s.variantRes, codecs: s.codecs, sec: 0 };
      v.sec += s.state === 'playing' ? dt[i] : 0;
      if (s.variantBps != null) v.bps = s.variantBps;
      if (s.variantRes) v.res = s.variantRes;
      if (s.codecs) v.codecs = s.codecs;
      variants.set(key, v);
      if (prevV && prevV.variantIndex !== s.variantIndex) {
        const a = prevV.variantBps, b = s.variantBps;
        const isUp = a != null && b != null ? b > a : s.variantIndex > prevV.variantIndex;
        isUp ? up++ : down++;
        events.push({ t: s.t, i, kind: isUp ? 'up' : 'down', from: prevV, to: s });
      }
      prevV = s;
    });
    events.sort((a, b) => a.t - b.t);

    // ビットレート（再生中の時間で重み付け）
    let bpsSum = 0, bpsW = 0, topW = 0;
    const maxBps = Math.max(0, ...samples.map((s) => s.variantBps || 0));
    samples.forEach((s, i) => {
      if (s.state !== 'playing' || s.variantBps == null) return;
      bpsSum += s.variantBps * dt[i];
      bpsW += dt[i];
      if (s.variantBps === maxBps) topW += dt[i];
    });

    const pick = (f) => samples.map((s) => s[f]).filter((v) => typeof v === 'number' && Number.isFinite(v));
    const cacheKnown = samples.filter((s) => s.cached != null);

    const levels = [
      ...CONT.filter((m) => cont[m.key].n).map((m) => cont[m.key].level),
      ...COUNT.map((m) => counts[m.key].level),
    ];
    const verdict = Math.max(LV.ok, ...levels);

    return {
      meta,
      samples,
      n,
      step,
      holes,
      start: samples[0]?.t,
      end: samples[n - 1]?.t,
      totalSec,
      playSec,
      hiddenSec,
      pausedSec,
      live,
      cont,
      counts,
      events,
      up,
      down,
      variants: [...variants.values()].sort((a, b) => (b.bps || 0) - (a.bps || 0)),
      variantCount: Math.max(0, ...samples.map((s) => s.variantCount || 0)),
      avgBps: bpsW ? bpsSum / bpsW : null,
      topRatio: bpsW ? topW / bpsW : null,
      dlMedian: median(pick('downloadBps')),
      segDur: median(pick('segDur')),
      targetDur: median(pick('targetDur')),
      reload: median(pick('plReloadSec')),
      cacheKnownRatio: n ? cacheKnown.length / n : 0,
      cacheHitRatio: cacheKnown.length ? cacheKnown.filter((s) => s.cached).length / cacheKnown.length : null,
      verdict,
    };
  }

  /** 連続値の統計と判定 */
  function contStats(vals, w, t) {
    if (!vals.length) return { n: 0, level: LV.ok };
    const sorted = [...vals].sort((a, b) => a - b);
    const below = t?.dir === 'below';
    const rep = quantile(sorted, below ? 0.05 : 0.95);
    let wAll = 0, wWarn = 0, wCrit = 0, sum = 0;
    vals.forEach((v, i) => {
      wAll += w[i];
      sum += v * w[i];
      const lv = levelOf(t, v);
      if (lv >= LV.warn) wWarn += w[i];
      if (lv >= LV.crit) wCrit += w[i];
    });
    return {
      n: vals.length,
      min: sorted[0],
      max: sorted[sorted.length - 1],
      mean: sum / wAll,
      median: quantile(sorted, 0.5),
      rep,
      below,
      warnRatio: wWarn / wAll,
      critRatio: wCrit / wAll,
      level: levelOf(t, rep),
    };
  }

  /** 小窓（overlay.js の level）と同じ比較。空欄の段階は判定しない */
  function levelOf(t, v) {
    if (!t || v == null) return LV.ok;
    const below = t.dir === 'below';
    const hit = (lim) => lim != null && (below ? v <= lim : v >= lim);
    if (hit(t.crit)) return LV.crit;
    if (hit(t.warn)) return LV.warn;
    return LV.ok;
  }

  /**
   * stall の直前30秒を見て、原因の手がかりを1つ返す。
   * 断定はしない。レポートの文面でも「推定」と書く。
   */
  function stallCause(samples, i) {
    const t0 = samples[i].t - 30000;
    let lowHead = false, slowDl = false, err = false;
    for (let j = i; j >= 0 && samples[j].t >= t0; j--) {
      const s = samples[j];
      if (typeof s.headroom === 'number' && s.headroom < 1 && s.segKind !== 'init') lowHead = true;
      if (s.downloadBps != null && s.variantBps != null && s.downloadBps < s.variantBps) slowDl = true;
      if (j > 0 && s.errors != null && samples[j - 1].errors != null && s.errors > samples[j - 1].errors) err = true;
    }
    if (err) return 'HTTPエラー';
    if (lowHead || slowDl) return '帯域不足';
    return null;
  }

  // ------------------------------------------------------------ 描画

  function render(sessions, cfg) {
    const r = cfg.report;
    const sec = r.sections;
    const players = sessions.flatMap(({ session, players }) => players.map((p) => ({ session, p })));
    const start = Math.min(...players.map((x) => x.p.start));
    const end = Math.max(...players.map((x) => x.p.end));
    const worst = Math.max(...players.map((x) => x.p.verdict));
    const multi = players.length > 1;

    let html = `
      <header class="cover">
        <h1>${esc(r.title)}</h1>
        <dl class="meta">
          <div><dt>計測期間</dt><dd>${esc(stamp(start))} 〜 ${esc(stamp(end))}</dd></div>
          <div><dt>対象</dt><dd>${esc([...new Set(sessions.map((x) => x.session.host))].join(', '))}</dd></div>
          ${r.author ? `<div><dt>作成</dt><dd>${esc(r.author)}</dd></div>` : ''}
          <div><dt>出力日時</dt><dd>${esc(stamp(Date.now()))}</dd></div>
        </dl>
        ${sec.summary ? verdictBadge(worst, multi ? '全体の判定' : '総合判定') : ''}
      </header>`;

    if (multi) html += compareTable(players);

    players.forEach(({ session, p }, i) => {
      const title = multi
        ? `${i + 1}. ${session.host}　${stamp(p.start)} 〜 ${stamp(p.end).slice(11)}${p.meta.frame ? `（フレーム ${p.meta.frame}）` : ''}`
        : null;
      html += `<article class="${multi ? 'player paged' : 'player'}">`;
      if (title) html += `<h2 class="ptitle">${esc(title)}</h2>`;
      if (sec.summary) html += summary(p, cfg, !multi);
      if (sec.kpi) html += kpi(p);
      if (sec.judgement) html += judgement(p, cfg);
      if (sec.charts) html += charts(p, cfg);
      if (sec.events) html += eventList(p);
      if (sec.stream) html += stream(p);
      if (sec.conditions) html += conditions(p, session);
      html += '</article>';
    });

    if (sec.criteria) html += criteria(cfg);
    html += `<footer class="foot">HLS Analyzer ${esc(version())} で作成。数値はブラウザ上の実測で、配信サーバー側の記録とは一致しない場合があります。</footer>`;
    return html;
  }

  function verdictBadge(lv, label) {
    const v = VERDICT[lv];
    return `<div class="verdict ${v.key}"><span class="vl">${esc(label)}</span><span class="vv">${v.label}</span></div>`;
  }

  function compareTable(players) {
    return `
      <section>
        <h2>セッション一覧</h2>
        <table class="grid">
          <thead><tr><th>#</th><th>開始</th><th>対象</th><th>再生時間</th><th>停止</th><th>平均ビットレート</th><th>HTTPエラー</th><th>判定</th></tr></thead>
          <tbody>
          ${players
            .map(
              ({ session, p }, i) => `
            <tr>
              <td>${i + 1}</td>
              <td>${esc(stamp(p.start))}</td>
              <td>${esc(session.host)}</td>
              <td>${esc(dur(p.playSec))}</td>
              <td>${p.counts.stall.total} 回 / ${fix(p.counts.stall.sec, 1)} 秒</td>
              <td>${esc(bps(p.avgBps))}</td>
              <td>${p.counts.errors.total} 件</td>
              <td><span class="tag ${VERDICT[p.verdict].key}">${VERDICT[p.verdict].label}</span></td>
            </tr>`
            )
            .join('')}
          </tbody>
        </table>
      </section>`;
  }

  /** 総合判定と所見。数値の羅列ではなく「何が起きたか → 推定される原因」の順で書く */
  function summary(p, cfg, withBadge) {
    const findings = findingsOf(p, cfg);
    const nCrit = findings.filter((f) => f.lv === LV.crit).length;
    const nWarn = findings.filter((f) => f.lv === LV.warn).length;
    let lead;
    if (p.verdict === LV.crit) {
      lead = `計測期間（再生 ${dur(p.playSec)}）のうち、${nCrit} 項目で重大値を超えており、視聴品質に影響が出ていました。`;
    } else if (p.verdict === LV.warn) {
      lead = `再生 ${dur(p.playSec)} を通じて概ね継続しましたが、${nWarn} 項目で警告値を超えました。`;
    } else {
      lead = `再生 ${dur(p.playSec)} を通じて、設定したしきい値を超える項目はなく、安定した再生品質でした。`;
    }
    const notes = [];
    if (p.down > 0) notes.push(`画質の引き下げが ${p.down} 回ありました（引き上げ ${p.up} 回）。`);
    if (p.hiddenSec > p.totalSec * 0.1) notes.push(`タブが非表示だった時間が ${pct(p.hiddenSec / p.totalSec)} あり、その間のドロップ率は集計から除いています。`);

    return `
      <section class="summary">
        <h2>総合判定と所見</h2>
        ${withBadge ? '' : verdictBadge(p.verdict, '判定')}
        <p class="lead">${esc(lead)}</p>
        ${
          findings.length
            ? `<ul class="findings">${findings
                .map((f) => `<li class="${VERDICT[f.lv].key}"><span class="tag ${VERDICT[f.lv].key}">${VERDICT[f.lv].label}</span>${esc(f.text)}</li>`)
                .join('')}</ul>`
            : ''
        }
        ${notes.length ? `<p class="note">${esc(notes.join(''))}</p>` : ''}
      </section>`;
  }

  function findingsOf(p, cfg) {
    const th = cfg.thresholds;
    const out = [];
    const c = p.cont;

    const st = p.counts.stall;
    if (st.level) {
      const causes = p.events.filter((e) => e.kind === 'stall').map((e) => e.cause);
      const bw = causes.filter((x) => x === '帯域不足').length;
      const er = causes.filter((x) => x === 'HTTPエラー').length;
      let text = `再生停止が ${st.total} 回（合計 ${fix(st.sec, 1)} 秒、再生時間の ${pct(st.sec / Math.max(p.playSec, 1))}）発生しました。`;
      if (er) text += `うち ${er} 回は直前に HTTPエラーがあり、配信サーバーまたは CDN の応答不良が原因と推定されます。`;
      if (bw) text += `うち ${bw} 回は直前に DL速度が選択中のビットレートを下回っており、回線または配信経路の帯域不足が原因と推定されます。`;
      out.push({ lv: st.level, text });
    }
    if (c.headroom.level) {
      out.push({
        lv: c.headroom.level,
        text: `余裕度（セグメント尺 ÷ DL時間）の下位5%値が ${fix(c.headroom.rep, 2)} 倍で、${lvName(c.headroom.level)}（${th.headroom[lvKey(c.headroom.level)]} 倍）以下でした。選択中のビットレートに対して取得が間に合っていない時間帯があります。`,
      });
    }
    if (c.bufferSec.level) {
      out.push({
        lv: c.bufferSec.level,
        text: `バッファ長が警告値（${th.bufferSec.warn} 秒）以下だった時間が ${pct(c.bufferSec.warnRatio)}、重大値（${th.bufferSec.crit} 秒）以下が ${pct(c.bufferSec.critRatio)} ありました（最小 ${fix(c.bufferSec.min, 1)} 秒）。停止の手前の状態です。`,
      });
    }
    const fz = p.counts.freeze;
    if (fz.level) {
      out.push({
        lv: fz.level,
        text: `バッファが残っているのに映像が止まるフリーズが ${fz.total} 回（合計 ${fix(fz.sec, 1)} 秒）ありました。ネットワークではなく、デコードや端末側の処理が原因と考えられます。`,
      });
    }
    if (c.droppedPct.level) {
      out.push({
        lv: c.droppedPct.level,
        text: `ドロップフレーム率の上位5%値が ${fix(c.droppedPct.rep, 2)}% で、${lvName(c.droppedPct.level)}（${th.droppedPct[lvKey(c.droppedPct.level)]}%）以上でした。端末の描画性能や、同時に動いている処理の負荷が疑われます。`,
      });
    }
    if (c.latencySec.level) {
      out.push({
        lv: c.latencySec.level,
        text: `ライブ遅延の上位5%値が ${fix(c.latencySec.rep, 1)} 秒で、${lvName(c.latencySec.level)}（${th.latencySec[lvKey(c.latencySec.level)]} 秒）以上でした。停止からの復帰で遅延が積み上がっていないか確認してください。`,
      });
    }
    const er = p.counts.errors;
    if (er.level) {
      out.push({
        lv: er.level,
        text: `HTTPエラーが ${er.total} 件ありました。配信サーバーや CDN のログと時刻を突き合わせてください（イベント一覧に時刻があります）。`,
      });
    }
    return out.sort((a, b) => b.lv - a.lv);
  }

  function kpi(p) {
    const st = p.counts.stall;
    const cards = [
      ['再生時間', dur(p.playSec), `記録 ${dur(p.totalSec)}`],
      ['再生停止', `${st.total} 回`, `${fix(st.sec, 1)} 秒 / 停止率 ${pct(st.sec / Math.max(p.playSec, 1))}`, st.level],
      ['平均ビットレート', bps(p.avgBps), p.topRatio != null ? `最高画質 ${pct(p.topRatio)}` : '', null],
      ['画質切替', `${p.up + p.down} 回`, `引き下げ ${p.down} / 引き上げ ${p.up}`, null],
      ['ドロップ率', p.cont.droppedPct.n ? `${fix(p.cont.droppedPct.mean, 2)}%` : '—', p.cont.droppedPct.n ? `最大 ${fix(p.cont.droppedPct.max, 2)}%` : '', p.cont.droppedPct.level],
      p.live
        ? ['ライブ遅延', p.cont.latencySec.n ? `${fix(p.cont.latencySec.median, 1)} 秒` : '—', p.cont.latencySec.n ? `上位5% ${fix(p.cont.latencySec.rep, 1)} 秒` : '', p.cont.latencySec.level]
        : ['DL速度', bps(p.dlMedian), '中央値', null],
      ['バッファ長', p.cont.bufferSec.n ? `${fix(p.cont.bufferSec.median, 1)} 秒` : '—', p.cont.bufferSec.n ? `最小 ${fix(p.cont.bufferSec.min, 1)} 秒` : '', p.cont.bufferSec.level],
      ['HTTPエラー', `${p.counts.errors.total} 件`, '', p.counts.errors.level],
    ];
    return `
      <section>
        <h2>主要指標</h2>
        <div class="kpis">
          ${cards
            .map(
              ([label, value, sub, lv]) => `
            <div class="kpi ${lv ? VERDICT[lv].key : ''}">
              <div class="kl">${esc(label)}</div>
              <div class="kv">${esc(value)}</div>
              <div class="ks">${esc(sub || '')}</div>
            </div>`
            )
            .join('')}
        </div>
      </section>`;
  }

  function judgement(p, cfg) {
    const th = cfg.thresholds;
    const rows = [];
    for (const m of CONT) {
      const c = p.cont[m.key];
      const t = th[m.key];
      if (!c.n) {
        rows.push([m.label, '—', limits(t, m.unit), '—', 'データなし', null]);
        continue;
      }
      rows.push([
        m.label,
        `${fix(c.rep, m.digits)} ${m.unit}（${c.below ? '下位' : '上位'}5%）`,
        limits(t, m.unit),
        `警告 ${pct(c.warnRatio)} / 重大 ${pct(c.critRatio)}`,
        `最小 ${fix(c.min, m.digits)} / 中央 ${fix(c.median, m.digits)} / 最大 ${fix(c.max, m.digits)}`,
        c.level,
      ]);
    }
    for (const m of COUNT) {
      const c = p.counts[m.key];
      rows.push([m.label, `${c.total} ${m.unit}（合計）`, limits(th[m.key], m.unit), '—', m.secField ? `合計 ${fix(c.sec, 1)} 秒` : '', c.level]);
    }
    return `
      <section>
        <h2>しきい値判定</h2>
        <table class="grid">
          <thead><tr><th>指標</th><th>判定に使った値</th><th>しきい値</th><th>超過時間の割合</th><th>分布</th><th>判定</th></tr></thead>
          <tbody>
          ${rows
            .map(
              ([a, b, c, d, e, lv]) => `
            <tr>
              <td>${esc(a)}</td><td>${esc(b)}</td><td>${esc(c)}</td><td>${esc(d)}</td><td class="dim">${esc(e)}</td>
              <td>${lv == null ? '—' : `<span class="tag ${VERDICT[lv].key}">${VERDICT[lv].label}</span>`}</td>
            </tr>`
            )
            .join('')}
          </tbody>
        </table>
      </section>`;
  }

  function limits(t, unit) {
    if (!t) return '—';
    const dir = t.dir === 'below' ? '以下' : '以上';
    const f = (v) => (v == null ? '判定なし' : `${v} ${unit}${dir}`);
    return `警告 ${f(t.warn)} / 重大 ${f(t.crit)}`;
  }

  // ------------------------------------------------------------ グラフ

  function charts(p, cfg) {
    const c = cfg.report.charts;
    const th = cfg.thresholds;
    const list = [];
    if (c.buffer) list.push({ title: 'バッファ長（秒）', series: [{ f: 'bufferSec', cls: 's1' }], th: th.bufferSec });
    if (c.bitrate)
      list.push({
        title: 'ビットレート（選択中）と DL速度（Mbps）',
        series: [
          { f: 'variantBps', cls: 's1', scale: 1e-6, step: true, name: '選択中ビットレート' },
          { f: 'downloadBps', cls: 's2', scale: 1e-6, name: 'DL速度' },
        ],
      });
    if (c.headroom) list.push({ title: '余裕度（倍）', series: [{ f: 'headroom', cls: 's1', skipInit: true }], th: th.headroom, cap: 10 });
    if (c.latency && p.live) list.push({ title: 'ライブ遅延（秒）', series: [{ f: 'latencySec', cls: 's1' }], th: th.latencySec });
    if (c.dropped) list.push({ title: 'ドロップフレーム率（%）', series: [{ f: 'droppedPct', cls: 's1', visibleOnly: true }], th: th.droppedPct });
    if (!list.length) return '';

    return `
      <section class="charts">
        <h2>時系列</h2>
        <p class="legend">
          <span class="lg crit"></span>重大値 <span class="lg warn"></span>警告値
          <span class="lg band"></span>再生停止 <span class="lg err"></span>HTTPエラー
        </p>
        ${list.map((ch) => chart(p, ch)).join('')}
      </section>`;
  }

  /** 1枚の折れ線。全グラフで時間軸を揃え、停止とエラーを重ねて描く */
  function chart(p, ch) {
    const W = 700, H = 130, L = 44, R = 8, T = 8, B = 20;
    const t0 = p.start, t1 = Math.max(p.end, p.start + 1);
    const x = (t) => L + ((t - t0) / (t1 - t0)) * (W - L - R);

    const lines = ch.series.map((s) => {
      const pts = p.samples.map((smp) => {
        let v = smp[s.f];
        if (typeof v !== 'number' || !Number.isFinite(v)) return null;
        if (s.skipInit && smp.segKind === 'init') return null;
        if (s.visibleOnly && smp.visible === false) return null;
        if (s.scale) v *= s.scale;
        if (ch.cap) v = Math.min(v, ch.cap);
        return [smp.t, v];
      });
      return { ...s, pts: thin(pts, W - L - R) };
    });
    const vals = lines.flatMap((l) => l.pts.filter(Boolean).map((q) => q[1]));
    if (!vals.length) return `<figure class="chart"><figcaption>${esc(ch.title)}</figcaption><p class="dim">データなし</p></figure>`;

    let ymax = Math.max(...vals);
    if (ch.th) for (const k of ['warn', 'crit']) if (ch.th[k] != null && (!ch.cap || ch.th[k] <= ch.cap)) ymax = Math.max(ymax, ch.th[k]);
    ymax = nice(ymax || 1);
    const y = (v) => T + (1 - v / ymax) * (H - T - B);

    let svg = `<svg viewBox="0 0 ${W} ${H}" class="plot" role="img" aria-label="${esc(ch.title)}">`;
    // 目盛り
    for (const v of [0, ymax / 2, ymax]) {
      svg += `<line class="gl" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/>`;
      svg += `<text class="ax" x="${L - 4}" y="${y(v) + 3}" text-anchor="end">${fmtAxis(v)}</text>`;
    }
    for (let k = 0; k <= 4; k++) {
      const t = t0 + ((t1 - t0) * k) / 4;
      svg += `<text class="ax" x="${x(t)}" y="${H - 5}" text-anchor="${k === 0 ? 'start' : k === 4 ? 'end' : 'middle'}">${esc(stamp(t).slice(11, 19))}</text>`;
    }
    // 停止区間とエラー
    for (const e of p.events) {
      if (e.kind === 'stall') {
        const xa = x(e.t), xb = Math.max(x(e.end || e.t), xa + 1.5);
        svg += `<rect class="band" x="${xa}" y="${T}" width="${xb - xa}" height="${H - T - B}"/>`;
      } else if (e.kind === 'errors') {
        svg += `<line class="err" x1="${x(e.t)}" x2="${x(e.t)}" y1="${T}" y2="${H - B}"/>`;
      }
    }
    // しきい値
    if (ch.th) {
      for (const k of ['warn', 'crit']) {
        const v = ch.th[k];
        if (v == null || v > ymax) continue;
        svg += `<line class="th ${k}" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/>`;
      }
    }
    // 系列（欠けたところで線を切る）
    for (const l of lines) {
      let d = '', pen = false;
      for (const q of l.pts) {
        if (!q) {
          pen = false;
          continue;
        }
        const px = x(q[0]).toFixed(1), py = y(q[1]).toFixed(1);
        if (!pen) d += `M${px},${py}`;
        else if (l.step) d += `H${px}V${py}`;
        else d += `L${px},${py}`;
        pen = true;
      }
      svg += `<path class="ln ${l.cls}" d="${d}"/>`;
    }
    svg += `<line class="axl" x1="${L}" x2="${L}" y1="${T}" y2="${H - B}"/></svg>`;

    const names = lines.filter((l) => l.name);
    return `
      <figure class="chart">
        <figcaption>${esc(ch.title)}${names.length ? names.map((l) => ` <span class="key ${l.cls}"></span>${esc(l.name)}`).join('') : ''}</figcaption>
        ${svg}
      </figure>`;
  }

  /** 点が描画幅より多いときは、区間ごとの最小と最大だけを残す（山と谷を消さない） */
  function thin(pts, width) {
    const target = Math.max(100, Math.floor(width));
    if (pts.length <= target * 2) return pts;
    const per = pts.length / target;
    const out = [];
    for (let b = 0; b < target; b++) {
      const seg = pts.slice(Math.floor(b * per), Math.floor((b + 1) * per));
      const ok = seg.filter(Boolean);
      if (!ok.length) {
        out.push(null);
        continue;
      }
      let lo = ok[0], hi = ok[0];
      for (const q of ok) {
        if (q[1] < lo[1]) lo = q;
        if (q[1] > hi[1]) hi = q;
      }
      out.push(...(lo[0] <= hi[0] ? [lo, hi] : [hi, lo]));
    }
    return out;
  }

  // ------------------------------------------------------------ 一覧・構成・条件

  const EVENT_LIMIT = 200;

  function eventList(p) {
    const list = p.events;
    if (!list.length) {
      return `<section><h2>イベント一覧</h2><p class="dim">停止・フリーズ・HTTPエラー・画質切替はありませんでした。</p></section>`;
    }
    const label = { stall: '再生停止', freeze: 'フリーズ', errors: 'HTTPエラー', up: '画質↑', down: '画質↓' };
    const cls = { stall: 'crit', freeze: 'warn', errors: 'crit', up: '', down: 'warn' };
    const detail = (e) => {
      if (e.kind === 'up' || e.kind === 'down') return `${bps(e.from.variantBps)}${e.from.variantRes ? ` ${e.from.variantRes}` : ''} → ${bps(e.to.variantBps)}${e.to.variantRes ? ` ${e.to.variantRes}` : ''}`;
      if (e.kind === 'errors') return `${e.n} 件`;
      return `${e.sec != null ? `${fix(e.sec, 1)} 秒` : ''}${e.cause ? `　推定原因: ${e.cause}` : ''}`;
    };
    return `
      <section>
        <h2>イベント一覧</h2>
        <table class="grid events">
          <thead><tr><th>時刻</th><th>種類</th><th>内容</th></tr></thead>
          <tbody>
          ${list
            .slice(0, EVENT_LIMIT)
            .map((e) => `<tr><td>${esc(stamp(e.t).slice(11, 19))}</td><td><span class="tag ${cls[e.kind]}">${label[e.kind]}</span></td><td>${esc(detail(e))}</td></tr>`)
            .join('')}
          </tbody>
        </table>
        ${list.length > EVENT_LIMIT ? `<p class="dim">ほか ${list.length - EVENT_LIMIT} 件は省略しました。全件は CSV で確認できます。</p>` : ''}
      </section>`;
  }

  function stream(p) {
    const total = p.variants.reduce((a, v) => a + v.sec, 0) || 1;
    return `
      <section>
        <h2>配信構成</h2>
        <dl class="kv2">
          <div><dt>種別</dt><dd>${p.live ? 'LIVE' : 'VOD'}</dd></div>
          <div><dt>バリアント数</dt><dd>${p.variantCount || '—'}</dd></div>
          <div><dt>セグメント尺</dt><dd>${p.segDur != null ? `${fix(p.segDur, 2)} 秒（中央値）` : '—'}</dd></div>
          <div><dt>TARGETDURATION</dt><dd>${p.targetDur != null ? `${p.targetDur} 秒` : '—'}</dd></div>
          ${p.live ? `<div><dt>プレイリスト再読込</dt><dd>${p.reload != null ? `${fix(p.reload, 1)} 秒（中央値）` : '—'}</dd></div>` : ''}
          <div><dt>DL速度</dt><dd>${esc(bps(p.dlMedian))}（中央値）</dd></div>
        </dl>
        ${
          p.variants.length
            ? `<table class="grid">
          <thead><tr><th>#</th><th>宣言ビットレート</th><th>解像度</th><th>コーデック</th><th>再生時間の割合</th></tr></thead>
          <tbody>
          ${p.variants
            .map(
              (v) => `<tr><td>${v.index + 1}</td><td>${esc(bps(v.bps))}</td><td>${esc(v.res || '—')}</td><td class="mono">${esc(v.codecs || '—')}</td>
              <td><span class="bar"><span style="width:${(v.sec / total) * 100}%"></span></span> ${pct(v.sec / total)}</td></tr>`
            )
            .join('')}
          </tbody>
        </table>`
            : ''
        }
      </section>`;
  }

  function conditions(p, session) {
    return `
      <section>
        <h2>計測条件</h2>
        <dl class="kv2">
          <div><dt>対象ホスト</dt><dd>${esc(session.host)}${p.meta.frame ? `（フレーム ${esc(p.meta.frame)}）` : ''}</dd></div>
          <div><dt>記録期間</dt><dd>${esc(stamp(p.start))} 〜 ${esc(stamp(p.end))}（${dur(p.totalSec)}）</dd></div>
          <div><dt>サンプル</dt><dd>${p.n} 件 / 間隔 ${fix(p.step / 1000, 1)} 秒${p.holes ? `（記録の欠け ${p.holes} 箇所）` : ''}</dd></div>
          <div><dt>一時停止・終了</dt><dd>${dur(p.pausedSec)}</dd></div>
          <div><dt>タブ非表示</dt><dd>${dur(p.hiddenSec)}（ドロップ率の集計から除外）</dd></div>
          <div><dt>キャッシュ判定</dt><dd>${p.cacheHitRatio == null ? '判定できない配信' : `判定可 ${pct(p.cacheKnownRatio)} / うちキャッシュ ${pct(p.cacheHitRatio)}`}</dd></div>
        </dl>
      </section>`;
  }

  function criteria(cfg) {
    const th = cfg.thresholds;
    const rows = [
      ['バッファ長', th.bufferSec, '秒', '下位5%値'],
      ['余裕度', th.headroom, '倍', '下位5%値'],
      ['ドロップフレーム率', th.droppedPct, '%', '上位5%値（タブ非表示中を除く）'],
      ['ライブ遅延', th.latencySec, '秒', '上位5%値（LIVEのみ）'],
      ['再生停止', th.stall, '回', '期間中の合計'],
      ['フリーズ', th.freeze, '回', '期間中の合計'],
      ['HTTPエラー', th.errors, '件', '期間中の合計'],
    ];
    return `
      <section class="criteria">
        <h2>判定基準</h2>
        <p class="dim">しきい値は HLS Analyzer の設定画面の値です。連続値は再生開始後のサンプルだけを使い、一時的な落ち込みで判定が振れないよう
          分布の端（5%点）をしきい値と比べます。重大が1つでもあれば「不良」、警告が1つでもあれば「注意」、それ以外を「良好」とします。</p>
        <table class="grid">
          <thead><tr><th>指標</th><th>比べる値</th><th>警告</th><th>重大</th></tr></thead>
          <tbody>
          ${rows
            .map(([n, t, u, how]) => {
              const dir = t.dir === 'below' ? '以下' : '以上';
              const f = (v) => (v == null ? '判定なし' : `${v} ${u}${dir}`);
              return `<tr><td>${esc(n)}</td><td>${esc(how)}</td><td>${esc(f(t.warn))}</td><td>${esc(f(t.crit))}</td></tr>`;
            })
            .join('')}
          </tbody>
        </table>
      </section>`;
  }

  // ------------------------------------------------------------ 小物

  function median(a) {
    if (!a.length) return null;
    return quantile([...a].sort((x, y) => x - y), 0.5);
  }

  /** 線形補間の分位点。sorted は昇順 */
  function quantile(sorted, q) {
    if (!sorted.length) return null;
    const pos = (sorted.length - 1) * q;
    const lo = Math.floor(pos), hi = Math.ceil(pos);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  }

  function nice(v) {
    const e = Math.pow(10, Math.floor(Math.log10(v)));
    for (const m of [1, 2, 2.5, 5, 10]) if (v <= m * e) return m * e;
    return 10 * e;
  }

  function fmtAxis(v) {
    return v >= 100 ? Math.round(v) : +v.toFixed(v >= 10 ? 0 : 1);
  }

  function lvName(lv) {
    return lv === LV.crit ? '重大値' : '警告値';
  }
  function lvKey(lv) {
    return lv === LV.crit ? 'crit' : 'warn';
  }

  function fix(v, d) {
    return typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : '—';
  }

  function pct(r) {
    if (r == null || !Number.isFinite(r)) return '—';
    const v = r * 100;
    return `${v < 10 && v > 0 ? v.toFixed(1) : Math.round(v)}%`;
  }

  function bps(v) {
    if (v == null || !Number.isFinite(v)) return '—';
    if (v >= 1e6) return `${(v / 1e6).toFixed(2)} Mbps`;
    return `${Math.round(v / 1e3)} kbps`;
  }

  function dur(sec) {
    sec = Math.round(sec || 0);
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    if (h) return `${h}時間${m}分`;
    if (m) return `${m}分${s}秒`;
    return `${s}秒`;
  }

  function stamp(t) {
    return localStamp(t).slice(0, 19);
  }

  function version() {
    try {
      return 'v' + chrome.runtime.getManifest().version;
    } catch (_) {
      return '';
    }
  }

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }
})();
