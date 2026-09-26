/*
 * hls.js でローカル生成の HLS を再生する。
 * ABR の自動判定に任せず、ボタンからバリアントを固定/自動に切り替えられるようにして、
 * バリアント判別と切替カウントを検証できるようにしてある。
 */
(() => {
  const video = document.getElementById('v');
  const logEl = document.getElementById('log');
  const levelsEl = document.getElementById('levels');
  /*
   * ?src= で配信形態を切り替える（test/serve.py のモード）。
   *   noext     拡張子なし・トークン付き・octet-stream
   *   byterange 1ファイルを #EXT-X-BYTERANGE で分割
   *   fmp4      fMP4（#EXT-X-MAP の init を持つ）。make-stream.sh が作る
   */
  const MODE = new URLSearchParams(location.search).get('src');
  const SRC =
    MODE === 'noext' || MODE === 'byterange'
      ? `/hls/${MODE}/master`
      : MODE === 'fmp4'
        ? 'stream-fmp4/index.m3u8'
        : 'stream/master.m3u8';

  const log = (m) => {
    const t = new Date().toTimeString().slice(0, 8);
    logEl.textContent = `[${t}] ${m}\n` + logEl.textContent.split('\n').slice(0, 12).join('\n');
  };

  if (!window.Hls || !Hls.isSupported()) {
    log('hls.js が使えません');
    return;
  }

  const hls = new Hls({ debug: false });
  window.__hls = hls; // コンソールから触れるように
  hls.loadSource(SRC);
  hls.attachMedia(video);

  hls.on(Hls.Events.MANIFEST_PARSED, (_, data) => {
    log(`マスター解析: ${data.levels.length} バリアント`);
    levelsEl.innerHTML =
      '<button data-level="-1">自動(ABR)</button>' +
      data.levels
        .map((l, i) => `<button data-level="${i}">${l.height}p / ${Math.round(l.bitrate / 1000)}k</button>`)
        .join('');
    video.play().catch(() => log('自動再生がブロックされました。再生ボタンを押してください'));
  });

  hls.on(Hls.Events.LEVEL_SWITCHED, (_, data) => {
    const l = hls.levels[data.level];
    log(`バリアント切替 → ${l.height}p / ${Math.round(l.bitrate / 1000)}k`);
  });

  hls.on(Hls.Events.ERROR, (_, data) => log(`エラー: ${data.details}`));

  levelsEl.addEventListener('click', (e) => {
    const lv = e.target.dataset?.level;
    if (lv === undefined) return;
    hls.currentLevel = Number(lv);
    log(`手動指定: ${lv === '-1' ? '自動(ABR)' : `level ${lv}`}`);
  });

  // VOD なので終端でループさせ、検証中ずっとセグメントが流れ続けるようにする
  video.addEventListener('ended', () => {
    video.currentTime = 0;
    video.play();
    log('ループ');
  });

  video.addEventListener('waiting', () => log('stall（waiting）'));
  video.addEventListener('playing', () => log('再生中'));

  // コンテナではなく <video> 要素そのものを全画面にする素朴なプレーヤーを模す
  document.getElementById('fsVideo')?.addEventListener('click', () => video.requestFullscreen());
})();
