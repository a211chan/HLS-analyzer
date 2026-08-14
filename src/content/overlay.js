/*
 * WebRTC Analyzer — 描画層（ISOLATED world / 全フレーム / document_idle）
 *
 * Service Worker から届いたメトリクスを Shadow DOM の小窓に描画する。
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

  const CHANNEL = 'webrtc-analyzer';
  const IS_TOP = window.top === window;
  /** これだけ更新が途絶えたPCは表示から落とす */
  const STALE_MS = 5000;
  const RENDER_MS = 500;

  /** @type {Map<string, {pc: object, host: string, at: number}>} */
  const store = new Map();

  let enabled = true;
  let collapsed = false;
  let pos = null; // {left, top} — ドラッグで動かした位置
  let hud = null;
  let body = null;
  let hostEl = null;
  let ticking = null;

  // ------------------------------------------------------------- 受信

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.__wraChannel !== CHANNEL || msg.type !== 'stats') return;

    const now = Date.now();
    const label = msg.host || 'frame';
    for (const pc of msg.pcs) {
      store.set(`${msg.frameId}|${pc.id}`, { pc, host: label, at: now });
    }
    if (!ticking) ticking = setInterval(render, RENDER_MS);
  });

  chrome.storage.local.get(['enabled', 'collapsed', 'pos']).then((v) => {
    enabled = v.enabled !== false;
    collapsed = v.collapsed === true;
    pos = v.pos || null;
    if (hud) applyState();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.enabled) enabled = changes.enabled.newValue !== false;
    if (changes.collapsed) collapsed = changes.collapsed.newValue === true;
    if (changes.pos) pos = changes.pos.newValue || null;
    if (hud) applyState();
    render();
  });

  document.addEventListener('fullscreenchange', () => render());

  // ------------------------------------------------------------- 表示判定

  function fullscreenEl() {
    return document.fullscreenElement || null;
  }

  function shouldShow() {
    if (!enabled) return false;

    const fs = fullscreenEl();
    // <video> や <iframe> は子要素を描画しないので、その上には重ねられない
    if (fs && (fs.tagName === 'VIDEO' || fs.tagName === 'IFRAME')) {
      // iframe が全画面なら、その iframe 自身のオーバーレイが担当する
      return false;
    }
    if (IS_TOP) {
      // 自フレーム内の要素が全画面 or 全画面でない → トップが担当
    } else if (!fs) {
      // 子フレームは全画面のときだけ出る（通常時はトップの小窓と二重になる）
      return false;
    }

    return live().length > 0;
  }

  function live() {
    const now = Date.now();
    for (const [k, v] of store) if (now - v.at > STALE_MS) store.delete(k);
    return [...store.values()];
  }

  // ------------------------------------------------------------- DOM 構築

  function build() {
    hostEl = document.createElement('div');
    hostEl.setAttribute('data-wra', '');
    // ページのCSSが html > div などで我々のホストを掴んで transform を掛けると
    // 子の position: fixed が壊れる。インラインの !important で封じる。
    hostEl.style.cssText = 'all: initial !important;';

    // open にしておくと DevTools のコンソールから
    // document.querySelector('[data-wra]').shadowRoot で中身を触れる。
    // closed にしてもページ側はホスト要素ごと消せるので、防御としては大差ない。
    const root = hostEl.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = WRA_STYLE;

    hud = document.createElement('div');
    hud.className = 'hud';
    hud.innerHTML = `
      <header>
        <span class="title">WebRTC Analyzer</span>
        <button data-act="collapse" title="折りたたみ">–</button>
        <button data-act="close" title="非表示（ツールバーのアイコンで戻せます）">×</button>
      </header>
      <div class="body"></div>`;
    body = hud.querySelector('.body');

    hud.querySelector('[data-act="collapse"]').addEventListener('click', () => {
      chrome.storage.local.set({ collapsed: !collapsed });
    });
    hud.querySelector('[data-act="close"]').addEventListener('click', () => {
      chrome.storage.local.set({ enabled: false });
    });
    enableDrag(hud.querySelector('header'));

    root.append(style, hud);
    applyState();
  }

  function applyState() {
    hud.classList.toggle('collapsed', collapsed);
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

    const entries = live().sort((a, b) => a.host.localeCompare(b.host) || a.pc.id.localeCompare(b.pc.id));
    body.innerHTML = entries.map(renderPc).join('') || '<div class="empty">no active connection</div>';
  }

  function renderPc(entry) {
    const pc = entry.pc;
    const state = String(pc.state || 'unknown');

    const conn = kv([
      ['route', pc.route ? pc.route + (pc.protocol ? ` (${pc.protocol})` : '') : null],
      ['rtt', ms(pc.rttMs)],
      ['avail↑', bps(pc.availOutBps)],
      ['avail↓', bps(pc.availInBps)],
    ]);

    const streams = [...pc.inbound.map(renderIn), ...pc.outbound.map(renderOut)].join('');

    return `<div class="pc">
      <div class="pc-head">
        <span class="src">${esc(entry.host)} · ${esc(pc.id)}</span>
        <span class="state state-${esc(state)}">${esc(state)}</span>
      </div>
      ${conn}
      ${streams}
    </div>`;
  }

  function renderIn(s) {
    return `<div class="stream">
      ${streamHead('↓', 'in', s)}
      ${kv([
        ['bitrate', bps(s.bps)],
        ['jitter', ms(s.jitterMs)],
        ['loss', pct(s.lossPct)],
        ['buffer', ms(s.jbMs)],
        ['freeze', s.freezes != null ? String(s.freezes) : null],
      ])}
    </div>`;
  }

  function renderOut(s) {
    const downscaled = s.srcW && s.w && s.srcW !== s.w;
    return `<div class="stream">
      ${streamHead('↑', 'out', s)}
      ${kv([
        ['bitrate', bps(s.bps)],
        ['target', bps(s.targetBps)],
        ['rtt', ms(s.rttMs)],
        ['jitter', ms(s.jitterMs)],
        ['loss', pct(s.lossPct)],
        // 送信品質が落ちた原因。ここが cpu / bandwidth なら送信側がボトルネック
        ['limit', s.limit, true],
        ['src', downscaled ? `${s.srcW}×${s.srcH}` : null, true],
      ])}
    </div>`;
  }

  function streamHead(arrow, dir, s) {
    const res = s.w && s.h ? `${s.w}×${s.h}` : null;
    const f = s.fps != null ? `${s.fps < 10 ? s.fps.toFixed(1) : Math.round(s.fps)}fps` : null;
    // 音声には解像度もFPSも無い。ビットレートは下の kv に出るので見出しは空でよい。
    const main = [res, f].filter(Boolean).join(' ');
    const kind = s.rid ? `${s.kind}·${s.rid}` : s.kind;
    return `<div class="stream-head">
      <span class="arrow ${dir}">${arrow}</span>
      <span class="kind">${esc(kind)}</span>
      <span class="head-main">${esc(main)}</span>
      <span class="codec">${esc(codec(s.codec))}</span>
    </div>`;
  }

  function kv(pairs) {
    const cells = pairs
      .filter(([, v]) => v != null && v !== '')
      .map(([k, v, warn]) => `<div><span class="k">${esc(k)}</span><span class="v${warn ? ' warn' : ''}">${esc(v)}</span></div>`)
      .join('');
    return cells ? `<div class="kv">${cells}</div>` : '';
  }

  // ------------------------------------------------------------- 整形

  function bps(v) {
    if (v == null) return null;
    if (v >= 1e6) return (v / 1e6).toFixed(2) + ' Mbps';
    if (v >= 1e3) return Math.round(v / 1e3) + ' kbps';
    return Math.round(v) + ' bps';
  }

  function ms(v) {
    if (v == null) return null;
    return (v >= 100 ? Math.round(v) : v.toFixed(1)) + ' ms';
  }

  function pct(v) {
    if (v == null) return null;
    return v.toFixed(2) + ' %';
  }

  function codec(mime) {
    return mime ? String(mime).replace(/^(video|audio)\//, '') : '';
  }

  const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
  function esc(s) {
    return String(s ?? '').replace(/[&<>"]/g, (c) => ESCAPES[c]);
  }
})();
