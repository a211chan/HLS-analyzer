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

  /** 直近のセグメント取得。{t, url, bytes, ms, status, dur, cached, repeat} */
  const segments = [];
  /*
   * 一度取得したセグメントURL。VOD を巡回監視する構成では同じURLを何度も踏み、
   * 2回目以降はまず確実にキャッシュから返る。Timing-Allow-Origin が無い配信では
   * Resource Timing でキャッシュを判定できないため、この事実を補助に使う。
   * LIVE ではURLが再出現しないので、この判定は何も変えない。
   */
  const seenSegments = new Set();
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

  function recordSegment(url, bytes, ms, status, t0) {
    if (status >= 400 || status === 0) httpErrors++;
    const abs = absolute(url);
    /*
     * cached は undefined（未判定）で積む。Resource Timing のエントリは本文を
     * 読み終えた直後にはまだ登録されていないことがあり、この場で引くと取り逃す。
     * 集計時に解決し、それでも分からなければ諦めて null（不明）にする。
     */
    const repeat = seenSegments.has(abs);
    seenSegments.add(abs);
    if (seenSegments.size > 500) seenSegments.delete(seenSegments.values().next().value);
    segments.push({ t: Date.now(), url: abs, bytes, ms, status, t0, dur: segDurationOf(abs), cached: undefined, repeat });
    if (segments.length > 60) segments.shift();
    detectVariant(abs);
    start();
  }

  /** そのセグメント自身の #EXTINF。どのプレイリストに載っていたかを横断で探す */
  function segDurationOf(segUrl) {
    for (const pl of mediaPlaylists.values()) {
      const d = pl.segUrls.get(segUrl);
      if (d != null) return d;
    }
    return null;
  }

  /*
   * キャッシュから返ったか。VOD を巡回監視する構成では同じセグメントを繰り返し
   * 取得するため、キャッシュヒットを実測に混ぜると DL速度も余裕度も桁が狂う。
   *
   * transferSize が 0 でも「キャッシュ」とは限らない。Timing-Allow-Origin の無い
   * クロスオリジンでは全サイズが 0 に潰れるため、本文サイズが取れている場合だけを
   * キャッシュと判定する。判別できないときは null（不明）を返し、除外はしない。
   */
  function fromCache(url, t0) {
    try {
      // 同じURLを何度も取りに行くので、この取得より後に始まったエントリに絞る。
      // 絞らないと最初のネットワーク取得のエントリを読み続け、キャッシュを
      // 取り逃した上に「キャッシュではない」と誤って断定してしまう。
      // エントリは時系列順に並ぶ。この取得に対応するのは t0 以降の「最初」の1本。
      // 最後の1本を取ると、後続の取得の結果を今回の判定に使ってしまう。
      const e = performance.getEntriesByName(url, 'resource').find((x) => x.startTime >= t0 - 1);
      if (!e) return null; // まだ登録されていない / バッファが満杯
      if (e.encodedBodySize === 0) return null; // TAO 無しでサイズが非公開
      return e.transferSize === 0;
    } catch (_) {
      return null;
    }
  }

  /** 未判定のセグメントを解決する。一定時間で諦めて「不明」に固定する */
  function resolveCache(now) {
    for (const s of segments) {
      if (s.cached !== undefined) continue;
      const v = fromCache(s.url, s.t0);
      if (v !== null) s.cached = v;
      else if (now - s.t > 5000) s.cached = null;
    }
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
    /*
     * URL → そのセグメント自身の尺。以前は Set で「載っているか」しか持たず、
     * 余裕度の計算にはプレイリスト末尾の #EXTINF を流用していた。尺が不揃いな
     * 配信では、測ったセグメントと尺の出どころが別物になり数字が破綻する。
     * #EXTINF は直後の URI 行に係るので、その対応をそのまま記録する。
     */
    const segUrls = new Map();
    let targetDuration = null;
    /** 直前の #EXTINF。URI 行に係ったら消費する */
    let pending = null;
    /** 消費した最後の尺。プレイリスト単位の代表値・フォールバックとして残す */
    let lastDur = null;

    for (const raw of lines) {
      const l = raw.trim();
      if (l.startsWith('#EXT-X-TARGETDURATION')) {
        targetDuration = num(l.split(':')[1]);
      } else if (l.startsWith('#EXTINF')) {
        pending = num(l.slice(l.indexOf(':') + 1).split(',')[0]);
      } else if (l && !l.startsWith('#')) {
        try {
          segUrls.set(new URL(l, url).href, pending);
        } catch (_) {}
        if (pending != null) lastDur = pending;
        // #EXTINF を伴わない URI 行が続いても直前の尺を使い回さない
        pending = null;
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
          recordSegment(url, 0, performance.now() - t0, 0, t0);
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
      recordSegment(url, bytes, performance.now() - t0, status, t0);
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
          recordSegment(url, e.loaded || byteLengthOf(this), ms, this.status, t0);
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
        st = {
          id: 'v' + ++videoSeq,
          stalls: 0, stallMs: 0, stallAt: 0, prev: null, prevStalls: 0,
          // レンダリング停止（フリーズ）。stall とは別物なので分けて数える
          freezes: 0, freezeSec: 0, frozen: false, prevFreezes: 0,
        };
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
    // 裏タブや画面消灯ではブラウザが描画自体を止める。可視でないフレーム停止は
    // 異常ではないので、これを条件に入れないと誤検知だらけになる。
    const visible = document.visibilityState === 'visible';

    let fps = null;
    let droppedPct = null;
    let frozen = false;
    if (q && prev && dt > 0) {
      const dTotal = q.totalVideoFrames - prev.total;
      const dDropped = q.droppedVideoFrames - prev.dropped;
      if (dTotal >= 0) fps = dTotal / dt;
      if (dTotal > 0 && dDropped >= 0) droppedPct = (dDropped / dTotal) * 100;

      /*
       * バッファが潤沢だとリバッファは起きず waiting も発火しないが、それでも
       * デコードフレームが1枚も進まないことがある。再生時計だけ進んで絵が止まる
       * この状態は、視聴者にとってはフリーズそのものなのに従来は完全に素通りし、
       * しかも dTotal が 0 のせいで droppedPct まで欠測になっていた。
       *
       * 「再生時計が進んだこと」を条件に入れるのが肝。これが無いと、一時停止から
       * 再生に戻った直後のサンプルを必ずフリーズと誤判定する（区間の大半が停止中
       * なので時計もフレームも進まない）。真のフリーズでは時計だけは進み続ける。
       */
      const advanced = prev.time != null ? v.currentTime - prev.time : 0;
      frozen = dTotal === 0 && visible && !v.paused && !v.ended && advanced > dt * 0.2;
    }
    if (q) st.prev = { t: now, total: q.totalVideoFrames, dropped: q.droppedVideoFrames, time: v.currentTime };

    if (frozen) {
      if (!st.frozen) {
        st.frozen = true;
        st.freezes++;
      }
      st.freezeSec += dt;
    } else {
      st.frozen = false;
    }

    // stall / freeze は累積値なので、しきい値判定に使えるよう増分も出しておく
    const stallDelta = st.stalls - st.prevStalls;
    st.prevStalls = st.stalls;
    const freezeDelta = st.freezes - st.prevFreezes;
    st.prevFreezes = st.freezes;

    return {
      id: st.id,
      state: v.ended
        ? 'ended'
        : st.stallAt
          ? 'stalled'
          : frozen
            ? 'frozen'
            : v.paused
              ? 'paused'
              : 'playing',
      visible,
      freezes: st.freezes,
      freezeSec: st.freezeSec,
      freezeDelta,
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
    resolveCache(Date.now());

    // キャッシュから返ったものは回線の実力を表さないので集計から外す。
    // 未判定・不明は「除外しない」側に倒す（測れた可能性を捨てないため）。
    // 計測できたと言えるのは「キャッシュと判定されておらず」かつ「初回取得」のもの。
    // 判定不能でも再取得なら回線の実力は測れていないので外す。
    const measured = segments.filter((s) => s.bytes > 0 && s.ms > 0 && s.cached !== true && !s.repeat);
    const recent = measured.slice(-SEG_WINDOW);

    let downloadBps = null;
    if (recent.length) {
      const bytes = recent.reduce((a, s) => a + s.bytes, 0);
      const ms = recent.reduce((a, s) => a + s.ms, 0);
      if (ms > 0) downloadBps = (bytes * 8) / (ms / 1000);
    }

    const last = recent[recent.length - 1] || null;
    /*
     * 直近の取得がキャッシュだったか。3値で持つ。
     *   true  = キャッシュ / false = 実ダウンロード / null = 判定できず
     * some() で畳むと「全部不明」が false になり、判定できていないことを
     * 「キャッシュではない」と言い切ってしまうので、最新の1本をそのまま出す。
     */
    const newest = segments[segments.length - 1];
    const cached = newest ? (newest.cached ?? null) : null;
    const repeat = newest ? newest.repeat : null;
    const v = currentVariant != null ? variants[currentVariant] : null;
    const plUrl = v ? v.plUrl : null;
    const pl = plUrl ? mediaPlaylists.get(plUrl) : lastMediaPlaylist();
    // プレイリスト由来の代表値。セグメント個別の尺が取れないときだけ使う。
    const plSegDur = pl?.segDuration ?? lastSegDuration;

    // プレイリストの再読込間隔（LIVE のみ意味がある）
    // 余裕度の計算に実際に使った尺。書き出しでも同じ値が見えるようにする。
    const segDur = last?.dur ?? plSegDur;

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
       * 余裕度 = そのセグメント自身の尺 ÷ ダウンロードにかかった時間。
       * 1.0 を割るとダウンロードが再生に追いつかず、いずれ必ず stall する。
       * HLS の健全性を1つの数字で見るならこれ。
       *
       * 尺は測ったセグメント自身の #EXTINF を使う。取れないときだけプレイリスト
       * 由来の値に落とす。キャッシュ由来の計測は last に入らないので混ざらない。
       */
      headroom: headroomOf(last, plSegDur),
      /** 直近の取得がキャッシュだったか（true/false/null）。数値の読み方が変わる */
      cached,
      /** 直近の取得が2回目以降のURLだったか。キャッシュを判定できない配信での代替 */
      repeat,
      plReloadSec,
      errors: httpErrors,
    };
  }

  /** 尺 ÷ DL時間。尺は測ったセグメント自身のものを優先し、無ければプレイリスト由来 */
  function headroomOf(last, fallbackDur) {
    if (!last || !(last.ms > 0)) return null;
    const dur = last.dur ?? fallbackDur;
    return dur > 0 ? dur / (last.ms / 1000) : null;
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
