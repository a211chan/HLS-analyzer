#!/usr/bin/env python3
"""検証ページ用の静的サーバ。

python3 -m http.server だとブラウザが JS をキャッシュし、書き換えたはずの
コードが反映されずに嵌まる。常に no-store を返してそれを防ぐ。

    python3 test/serve.py [port]
"""
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, fmt, *args):
        pass  # アクセスログは不要


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8732
    handler = partial(NoCacheHandler, directory=str(ROOT))
    print(f"http://localhost:{port}/test/loopback.html")
    print(f"http://localhost:{port}/test/standalone.html")
    print(f"http://localhost:{port}/test/options-preview.html")
    ThreadingHTTPServer(("127.0.0.1", port), handler).serve_forever()
