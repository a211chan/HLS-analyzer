/*
 * HLS Analyzer — 収集層（MAIN world / 全フレーム / document_start）
 *
 * HLS には WebRTC の getStats() に相当する標準APIが無い。代わりに3つの層から集める。
 *
 *   1. ネットワーク : fetch / XMLHttpRequest をラップし、.m3u8 と セグメントの
 *                     バイト数・完全ダウンロード時間・HTTPステータスを測る
 *   2. プレイリスト : .m3u8 の中身を解析し、ビットレート階段（BANDWIDTH /
 *                     RESOLUTION）と、いまどのバリアントを再生中かを特定する
 *   3. 再生         : <video> 要素から解像度・バッファ長・stall・ドロップフレームを読む
 *
 * いずれもプレーヤー非依存。hls.js / video.js(VHS) / Shaka のどれでも動く。
 * Chrome デスクトップは <video> のネイティブHLS再生に対応しないため、HLS は必ず
 * JSプレーヤーが MSE 経由で再生する。つまり fetch/XHR を押さえれば取りこぼしが無い。
 */
(() => {
  'use strict';

  const CHANNEL = 'hls-analyzer';
  /** 監視対象が無くなってからポーリングを止めるまでの猶予 */
  const IDLE_STOP_MS = 5000;
  /** スループット算出に使う直近セグメント数 */
  const SEG_WINDOW = 5;

  // ポーリング間隔は設定画面から変えられる。MAIN world からは chrome.storage を
  // 読めないので、ISOLATED world の bridge.js が postMessage で送り込んでくる。
  let intervalMs = 1000;

  if (window.__HLA_PATCHED__) return;
  window.__HLA_PATCHED__ = true;

  let timer = null;
  let idleSince = 0;

  // ---------------------------------------------------------------- 収集状態

  /** 直近のセグメント取得。{t, url, bytes, ms, status} */
  const segments = [];
  /** 直近のプレイリスト取得。再読込間隔の算出に使う */
  const playlistFetches = [];
  /** マスタープレイリストのバリアント一覧（ビットレート昇順） */
  let variants = [];
  /** メディアプレイリスト url -> {targetDuration, isLive, segUrls, segDuration, lastAt} */
  const mediaPlaylists = new Map();
  /** 現在再生中のバリアント index。判別できなければ null */
  let currentVariant = null;
  let variantSwitches = 0;
  let httpErrors = 0;
  /** 最後に観測したセグメントの尺（EXTINF 由来、秒） */
  let lastSegDuration = null;

  // ------------------------------------------------------------ URL の分類

  const SEGMENT_EXT = /\.(ts|m4s|mp4|m4v|m4a|aac|mp3|cmfv|cmfa|cmft)$/;

  function classify(rawUrl) {
    try {
      const path = new URL(rawUrl, location.href).pathname.toLowerCase();
      if (path.endsWith('.m3u8')) return 'playlist';
      if (SEGMENT_EXT.test(path)) return 'segment';
    } catch (_) {
      /* 壊れたURLは無視 */
    }
    return null;
  }

  function absolute(url) {
    try {
      return new URL(url, location.href).href;
    } catch (_) {
      return url;
    }
  }

  // ------------------------------------------------------- 記録（共通の入口）

  function recordSegment(url, bytes, ms, status) {
    if (status >= 400 || status === 0) httpErrors++;
    segments.push({ t: Date.now(), url: absolute(url), bytes, ms, status });
    if (segments.length > 60) segments.shift();
    detectVariant(absolute(url));
    start();
  }

  function recordPlaylist(url, ms, status, text) {
    if (status >= 400 || status === 0) httpErrors++;
    playlistFetches.push({ t: Date.now(), url: absolute(url) });
    if (playlistFetches.length > 40) playlistFetches.shift();
    if (text) parsePlaylist(absolute(url), text);
    start();
  }

  // ------------------------------------------------------- プレイリスト解析

  function parsePlaylist(url, text) {
    if (!text.includes('#EXTM3U')) return;
    if (text.includes('#EXT-X-STREAM-INF')) parseMaster(url, text);
    else parseMedia(url, text);
  }

  /** マスタープレイリスト → ビットレート階段 */
  function parseMaster(url, text) {
    const lines = text.split(/\r?\n/);
    const found = [];

    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].startsWith('#EXT-X-STREAM-INF')) continue;
      const attrs = parseAttrs(lines[i].slice(lines[i].indexOf(':') + 1));

      // 属性行の次に来る非コメント行が、そのバリアントのプレイリストURL
      let uri = null;
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j].trim();
        if (!l) continue;
        if (l.startsWith('#')) break;
        uri = l;
        break;
      }
      if (!uri) continue;

      found.push({
        bandwidth: num(attrs.BANDWIDTH),
        avgBandwidth: num(attrs['AVERAGE-BANDWIDTH']),
        resolution: attrs.RESOLUTION || null,
        codecs: attrs.CODECS || null,
        frameRate: num(attrs['FRAME-RATE']),
        plUrl: absolute(new URL(uri, url).href),
      });
    }

    if (found.length) {
      found.sort((a, b) => (a.bandwidth ?? 0) - (b.bandwidth ?? 0));
      variants = found;
    }
  }

  /** メディアプレイリスト → セグメント一覧・尺・LIVE/VOD */
  function parseMedia(url, text) {
    const lines = text.split(/\r?\n/);
    const segUrls = new Set();
    let targetDuration = null;
    let lastDur = null;

    for (const raw of lines) {
      const l = raw.trim();
      if (l.startsWith('#EXT-X-TARGETDURATION')) {
        targetDuration = num(l.split(':')[1]);
      } else if (l.startsWith('#EXTINF')) {
        lastDur = num(l.slice(l.indexOf(':') + 1).split(',')[0]);
      } else if (l && !l.startsWith('#')) {
        try {
          segUrls.add(new URL(l, url).href);
        } catch (_) {}
      }
    }

    mediaPlaylists.set(url, {
      targetDuration,
      // #EXT-X-ENDLIST があれば VOD、無ければ LIVE
      isLive: !text.includes('#EXT-X-ENDLIST'),
      segUrls,
      segDuration: lastDur,
      lastAt: Date.now(),
    });
    if (lastDur != null) lastSegDuration = lastDur;
  }

  /**
   * いま取得したセグメントがどのバリアントのものかを、メディアプレイリストの
   * セグメント一覧との照合で特定する。プレーヤーのAPIに一切依存しない。
   */
  function detectVariant(segUrl) {
    if (!variants.length) return;
    for (const [plUrl, pl] of mediaPlaylists) {
      if (!pl.segUrls.has(segUrl)) continue;
      const idx = variants.findIndex((v) => v.plUrl === plUrl);
      if (idx < 0) return;
      if (currentVariant != null && currentVariant !== idx) variantSwitches++;
      currentVariant = idx;
      return;
    }
  }

  function parseAttrs(s) {
    const out = {};
    // 値はクォート付き / 無しの両方がありうる
    const re = /([A-Z0-9-]+)=("([^"]*)"|[^,]*)/g;
    let m;
    while ((m = re.exec(s))) out[m[1]] = m[3] !== undefined ? m[3] : m[2];
    return out;
  }

  function num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  // ------------------------------------------------------------- fetch 差替

  const nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    window.fetch = function (input) {
      const url = typeof input === 'string' ? input : input?.url ?? String(input);
      const kind = classify(url);
      if (!kind) return nativeFetch.apply(this, arguments);

      const t0 = performance.now();
      return nativeFetch.apply(this, arguments).then(
        (res) => {
          // fetch の Promise はヘッダ到着で解決する。本文を読み切った時刻まで
          // 測らないと「ダウンロード時間」にならないので、clone を消化して計る。
          measureBody(res.clone(), kind, url, t0, res.status);
          return res;
        },
        (err) => {
          recordSegment(url, 0, performance.now() - t0, 0);
          throw err;
        }
      );
    };
  }

  async function measureBody(res, kind, url, t0, status) {
    try {
      if (kind === 'playlist') {
        const text = await res.text();
        recordPlaylist(url, performance.now() - t0, status, text);
        return;
      }
      // セグメントは中身が要らない。読み捨てながらバイト数だけ数えるので、
      // 巨大なセグメントでもメモリを抱え込まない。
      let bytes = 0;
      if (res.body) {
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
        }
      } else {
        bytes = (await res.arrayBuffer()).byteLength;
      }
      recordSegment(url, bytes, performance.now() - t0, status);
    } catch (_) {
      /* 測定に失敗してもページの再生には影響させない */
    }
  }

  // --------------------------------------------------------------- XHR 差替

  // hls.js は既定で XHR を使う。fetch だけでは取りこぼす。
  const xhrOpen = XMLHttpRequest.prototype.open;
  const xhrSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__hlaUrl = url;
    return xhrOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function () {
    const url = this.__hlaUrl;
    const kind = url ? classify(url) : null;
    if (kind) {
      const t0 = performance.now();
      // loadend は本文を受け切ってから発火するので、そのままDL時間になる
      this.addEventListener('loadend', (e) => {
        const ms = performance.now() - t0;
        if (kind === 'playlist') {
          let text = '';
          try {
            if (this.responseType === '' || this.responseType === 'text') text = this.responseText;
          } catch (_) {}
          recordPlaylist(url, ms, this.status, text);
        } else {
          recordSegment(url, e.loaded || byteLengthOf(this), ms, this.status);
        }
      });
    }
    return xhrSend.apply(this, arguments);
  };

  function byteLengthOf(xhr) {
    try {
      const r = xhr.response;
      if (r instanceof ArrayBuffer) return r.byteLength;
      if (r && typeof r.size === 'number') return r.size;
      if (typeof r === 'string') return r.length;
    } catch (_) {}
    return 0;
  }

  // ------------------------------------------------------------ <video> 追跡

  /** video要素ごとの累積状態。要素が消えたらGCされるよう WeakMap で持つ */
  const videoState = new WeakMap();
  let videoSeq = 0;

  function trackedVideos() {
    const out = [];
    for (const v of document.querySelectorAll('video')) {
      let st = videoState.get(v);
      if (!st) {
        st = { id: 'v' + ++videoSeq, stalls: 0, stallMs: 0, stallAt: 0, prev: null, prevStalls: 0 };
        videoState.set(v, st);
        attach(v, st);
      }
      out.push([v, st]);
    }
    return out;
  }

  function attach(v, st) {
    // stall（リバッファ）は HLS におけるフリーズ相当。waiting→playing の間隔を測る。
    v.addEventListener('waiting', () => {
      if (st.stallAt) return;
      st.stallAt = performance.now();
      st.stalls++;
    });
    const end = () => {
      if (!st.stallAt) return;
      st.stallMs += performance.now() - st.stallAt;
      st.stallAt = 0;
    };
    v.addEventListener('playing', end);
    v.addEventListener('pause', end);
  }

  function bufferAhead(v) {
    const b = v.buffered;
    for (let i = 0; i < b.length; i++) {
      if (v.currentTime >= b.start(i) - 0.1 && v.currentTime <= b.end(i)) return b.end(i) - v.currentTime;
    }
    return 0;
  }

  /**
   * ライブ端からの距離。seekable の終端を live edge とみなす。
   * VOD では seekable.end は単なる総尺なので、この計算は「残り時間」になってしまう。
   * 意味を持つのは LIVE のときだけなので、それ以外は null を返す。
   */
  function liveLatency(v, isLive) {
    if (isLive !== true) return null;
    const s = v.seekable;
    if (!s.length) return null;
    const d = s.end(s.length - 1) - v.currentTime;
    return Number.isFinite(d) && d >= 0 ? d : null;
  }

  function playerRow(v, st, now, isLive) {
    const q = typeof v.getVideoPlaybackQuality === 'function' ? v.getVideoPlaybackQuality() : null;
    const prev = st.prev;
    const dt = prev ? (now - prev.t) / 1000 : 0;

    let fps = null;
    let droppedPct = null;
    if (q && prev && dt > 0) {
      const dTotal = q.totalVideoFrames - prev.total;
      const dDropped = q.droppedVideoFrames - prev.dropped;
      if (dTotal >= 0) fps = dTotal / dt;
      if (dTotal > 0 && dDropped >= 0) droppedPct = (dDropped / dTotal) * 100;
    }
    if (q) st.prev = { t: now, total: q.totalVideoFrames, dropped: q.droppedVideoFrames };

    // stall は累積値なので、しきい値判定に使えるよう増分も出しておく
    const stallDelta = st.stalls - st.prevStalls;
    st.prevStalls = st.stalls;

    return {
      id: st.id,
      state: v.ended ? 'ended' : st.stallAt ? 'stalled' : v.paused ? 'paused' : 'playing',
      w: v.videoWidth || null,
      h: v.videoHeight || null,
      fps,
      // HLS におけるジッターバッファ相当。これが痩せると stall する。
      bufferSec: bufferAhead(v),
      latencySec: liveLatency(v, isLive),
      stalls: st.stalls,
      stallSec: st.stallMs / 1000,
      stallDelta,
      droppedPct,
    };
  }

  // ---------------------------------------------------------- ネットワーク集計

  function netRow() {
    const recent = segments.slice(-SEG_WINDOW).filter((s) => s.bytes > 0 && s.ms > 0);

    let downloadBps = null;
    if (recent.length) {
      const bytes = recent.reduce((a, s) => a + s.bytes, 0);
      const ms = recent.reduce((a, s) => a + s.ms, 0);
      if (ms > 0) downloadBps = (bytes * 8) / (ms / 1000);
    }

    const last = recent[recent.length - 1] || null;
    const v = currentVariant != null ? variants[currentVariant] : null;
    const plUrl = v ? v.plUrl : null;
    const pl = plUrl ? mediaPlaylists.get(plUrl) : lastMediaPlaylist();
    const segDur = pl?.segDuration ?? lastSegDuration;

    // プレイリストの再読込間隔（LIVE のみ意味がある）
    const times = playlistFetches.filter((p) => p.url === (plUrl ?? pl?.url)).map((p) => p.t);
    const plReloadSec = times.length >= 2 ? (times[times.length - 1] - times[times.length - 2]) / 1000 : null;

    return {
      live: pl ? pl.isLive : null,
      targetDur: pl?.targetDuration ?? null,
      segDur,
      variantIndex: currentVariant,
      variantCount: variants.length || null,
      variantBps: v?.avgBandwidth ?? v?.bandwidth ?? null,
      variantRes: v?.resolution ?? null,
      codecs: v?.codecs ?? null,
      switches: variantSwitches,
      downloadBps,
      segBytes: last?.bytes ?? null,
      segMs: last?.ms ?? null,
      /*
       * 余裕度 = セグメントの尺 ÷ ダウンロードにかかった時間。
       * 1.0 を割るとダウンロードが再生に追いつかず、いずれ必ず stall する。
       * HLS の健全性を1つの数字で見るならこれ。
       */
      headroom: segDur && last?.ms ? segDur / (last.ms / 1000) : null,
      plReloadSec,
      errors: httpErrors,
    };
  }

  function lastMediaPlaylist() {
    let best = null;
    for (const [url, pl] of mediaPlaylists) {
      if (!best || pl.lastAt > best.lastAt) best = { ...pl, url };
    }
    return best;
  }

  // ------------------------------------------------------------- ポーリング

  function start() {
    if (!timer) timer = setInterval(tick, intervalMs);
    idleSince = 0;
  }

  function tick() {
    const now = Date.now();
    const net = netRow();
    const players = trackedVideos()
      .filter(([v]) => v.readyState > 0 || !v.paused)
      .map(([v, st]) => playerRow(v, st, now, net.live));

    window.postMessage({ __hlaChannel: CHANNEL, type: 'stats', net, players }, '*');

    // 再生も取得も無くなったら止める（非HLSページのコストをゼロにする）
    const lastSeg = segments.length ? segments[segments.length - 1].t : 0;
    if (players.length === 0 && now - lastSeg > IDLE_STOP_MS) {
      if (!idleSince) idleSince = now;
      if (now - idleSince > IDLE_STOP_MS) {
        clearInterval(timer);
        timer = null;
        idleSince = 0;
      }
    } else {
      idleSince = 0;
    }
  }

  // --------------------------------------------------------------- 設定受信

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const d = event.data;
    if (!d || d.__hlaChannel !== CHANNEL || d.type !== 'config') return;

    const v = Number(d.intervalMs);
    // 下限を設けないとページを巻き込んで重くなる
    if (!Number.isFinite(v) || v < 200 || v === intervalMs) return;
    intervalMs = v;
    if (timer) {
      clearInterval(timer);
      timer = setInterval(tick, intervalMs);
    }
  });

  // bridge.js より先に読み込まれた場合に備えて、こちらからも設定を要求する
  window.postMessage({ __hlaChannel: CHANNEL, type: 'hello' }, '*');

  /*
   * ポーリング再開のきっかけ。
   *
   * セグメント取得は start() を呼ぶが、それだけでは足りない。VOD を全部
   * バッファし終えると新規の取得が起きなくなり、その状態で hls.js が
   * レベル切替でメディアを一瞬デタッチすると readyState が 0 に落ちて
   * 「監視対象なし」と判定され、タイマーが止まったまま復帰しなくなる。
   *
   * メディア系イベントはバブリングしないが、キャプチャ段階なら document で
   * 拾える。ポーリングを増やさずに再開できる。
   */
  for (const type of ['play', 'playing', 'waiting', 'loadedmetadata', 'loadeddata', 'seeking']) {
    document.addEventListener(type, (e) => {
      // m3u8 を一度も踏んでいないページ（ただの mp4 等）では回さない。
      // <all_urls> に注入される以上、非HLSページのコストはゼロにしておく。
      if (mediaPlaylists.size && e.target instanceof HTMLMediaElement) start();
    }, true);
  }
})();
