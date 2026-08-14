/*
 * WebRTC Analyzer — HUD のスタイル
 *
 * コンテンツスクリプトは ES Modules を使えない。manifest の js: [...] に列挙した
 * ファイルは同一スコープを共有するので、グローバル変数で overlay.js へ渡す。
 * Shadow DOM 内に注入されるため、ページ側のCSSとは完全に隔離される。
 */
var WRA_STYLE = `
:host { all: initial; }

.hud {
  position: fixed;
  z-index: 2147483647;
  top: 12px;
  right: 12px;
  min-width: 232px;
  max-width: 340px;
  box-sizing: border-box;
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  font-size: 11px;
  line-height: 1.45;
  font-variant-numeric: tabular-nums;
  color: #e8eaed;
  background: rgba(18, 20, 24, 0.86);
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 8px;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(6px);
  overflow: hidden;
  user-select: none;
}

.hud.collapsed .body { display: none; }

header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 8px;
  background: rgba(255, 255, 255, 0.06);
  cursor: move;
  touch-action: none;
}

header .title {
  flex: 1;
  font-weight: 600;
  letter-spacing: 0.02em;
  font-size: 10px;
  color: #b9bec6;
  text-transform: uppercase;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

header button {
  all: unset;
  cursor: pointer;
  width: 16px;
  height: 16px;
  border-radius: 3px;
  text-align: center;
  line-height: 16px;
  font-size: 12px;
  color: #b9bec6;
}
header button:hover { background: rgba(255, 255, 255, 0.14); color: #fff; }

.body { padding: 6px 8px 8px; max-height: 70vh; overflow-y: auto; }

.pc + .pc { margin-top: 8px; border-top: 1px solid rgba(255, 255, 255, 0.1); padding-top: 7px; }

.pc-head {
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin-bottom: 3px;
  font-size: 10px;
  color: #9aa1ab;
}
.pc-head .src { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pc-head .state { font-weight: 600; }
.state-connected  { color: #6ee7a0; }
.state-connecting { color: #f5c451; }
.state-failed,
.state-disconnected,
.state-closed     { color: #f2857b; }

.stream { margin-top: 4px; }

.stream-head {
  display: flex;
  align-items: baseline;
  gap: 5px;
  color: #cfd4da;
}
.stream-head .arrow { font-weight: 700; color: #7fb2ff; width: 9px; }
.stream-head .arrow.out { color: #ffb37f; }
.stream-head .kind { color: #9aa1ab; width: 36px; }
.stream-head .head-main { font-weight: 600; }
.stream-head .codec { margin-left: auto; color: #757d88; font-size: 10px; }

.kv {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0 8px;
  padding-left: 14px;
}
.kv div { display: flex; gap: 4px; white-space: nowrap; }
.kv .k { color: #838b96; }
.kv .v { color: #e8eaed; margin-left: auto; }
.kv .v.warn { color: #ffb37f; }

.empty { color: #838b96; padding: 2px 0; }
`;
