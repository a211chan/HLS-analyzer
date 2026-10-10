/*
 * standalone.html 専用の chrome.* エミュレータ。
 * Service Worker の代わりに、bridge.js の sendMessage を同一ページ内の
 * overlay.js の onMessage へ折り返す。sw.js と同じく frameId を付与する。
 *
 * 拡張本体では使わない。テストのためだけのファイル。
 */
(() => {
  const msgListeners = [];
  const changeListeners = [];
  const store = Object.create(null);
  // 拡張の既定は表示OFF（アイコンか設定画面で ON にする）。検証ページでは最初から出しておく
  store.enabled = true;
  // storage.session 相当。実物と同じくメモリ上にしか無い
  const session = Object.create(null);
  // 小窓の位置。実物は storage.session にタブ単位で持つ
  let ui = null;
  const sessionListeners = [];

  window.chrome = {
    runtime: {
      sendMessage(msg) {
        // sw.js の応答が要るものは、ここで代わりに返す
        if (msg?.type === 'download') {
          console.log('[shim] download', msg.filename, msg.url.length, 'bytes (data URL)');
          return Promise.resolve({ ok: true });
        }
        if (msg?.type === 'ui-get') return Promise.resolve(ui);
        if (msg?.type === 'ui-set') {
          ui = { pos: msg.pos || null };
          return Promise.resolve();
        }

        // sw.js と同じ振る舞い: frameId を付けて折り返す
        const payload = { ...msg, frameId: 0 };
        setTimeout(() => msgListeners.forEach((fn) => fn(payload, { tab: { id: 1 }, frameId: 0 }, () => {})), 0);
        return Promise.resolve();
      },
      onMessage: { addListener: (fn) => msgListeners.push(fn) },
    },
    storage: {
      local: {
        get(keys) {
          const out = {};
          for (const k of keys == null ? Object.keys(store) : [].concat(keys)) if (k in store) out[k] = store[k];
          return Promise.resolve(out);
        },
        getKeys() {
          return Promise.resolve(Object.keys(store));
        },
        set(obj) {
          const changes = {};
          for (const [k, v] of Object.entries(obj)) {
            changes[k] = { oldValue: store[k], newValue: v };
            store[k] = v;
          }
          setTimeout(() => changeListeners.forEach((fn) => fn(changes, 'local')), 0);
          return Promise.resolve();
        },
        remove(keys) {
          const changes = {};
          for (const k of [].concat(keys)) {
            if (!(k in store)) continue;
            // 実 API と同じく newValue を持たせない
            changes[k] = { oldValue: store[k] };
            delete store[k];
          }
          setTimeout(() => changeListeners.forEach((fn) => fn(changes, 'local')), 0);
          return Promise.resolve();
        },
      },
      session: {
        get(keys) {
          const out = {};
          for (const k of [].concat(keys)) if (k in session) out[k] = session[k];
          return Promise.resolve(out);
        },
        set(obj) {
          const changes = {};
          for (const [k, v] of Object.entries(obj)) {
            changes[k] = { oldValue: session[k], newValue: v };
            session[k] = v;
          }
          setTimeout(() => sessionListeners.forEach((fn) => fn(changes)), 0);
          return Promise.resolve();
        },
        remove(keys) {
          for (const k of [].concat(keys)) delete session[k];
          return Promise.resolve();
        },
        onChanged: { addListener: (fn) => sessionListeners.push(fn) },
      },
      onChanged: { addListener: (fn) => changeListeners.push(fn) },
    },
    // 設定画面のログ保存ボタン用。実際には保存せず、呼ばれたことだけ記録する
    downloads: {
      download(opts) {
        console.log('[shim] downloads.download', opts.filename);
        return Promise.resolve(1);
      },
    },
  };
  // 検証用に中身を覗けるようにしておく
  window.__shimStore = store;
})();
