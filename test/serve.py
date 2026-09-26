#!/usr/bin/env python3
"""検証ページ用の静的サーバ。

python3 -m http.server だとブラウザが JS をキャッシュし、書き換えたはずの
コードが反映されずに嵌まる。常に no-store を返してそれを防ぐ。

test/stream/ の VOD を、配信形態を変えて出し直すモードも持つ（#1 の検証用）。

    /hls/noext/master      拡張子なしURL。セグメントは ?token= 付き・application/octet-stream
    /hls/byterange/master  バリアントごとに1ファイル（all.ts）を #EXT-X-BYTERANGE で分割

    python3 test/serve.py [port]
"""
import re
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STREAM = ROOT / "test" / "stream"
M3U8 = "application/vnd.apple.mpegurl"


def segments(variant):
    """バリアントの (尺, セグメントファイル) を順に返す"""
    out, dur = [], None
    for line in (STREAM / variant / "index.m3u8").read_text().splitlines():
        if line.startswith("#EXTINF"):
            dur = line
        elif line and not line.startswith("#"):
            out.append((dur, STREAM / variant / line))
    return out


def media_header():
    return ["#EXTM3U", "#EXT-X-VERSION:4", "#EXT-X-TARGETDURATION:4",
            "#EXT-X-MEDIA-SEQUENCE:0", "#EXT-X-PLAYLIST-TYPE:VOD"]


class NoCacheHandler(SimpleHTTPRequestHandler):
    def do_GET(self):
        m = re.match(r"^/hls/(noext|byterange)/(.*?)(\?.*)?$", self.path)
        if m:
            return self.hls(m.group(1), m.group(2))
        return super().do_GET()

    # ------------------------------------------------------------ 配信モード

    def hls(self, mode, rest):
        if rest == "master":
            text = (STREAM / "master.m3u8").read_text()
            # "v0/index.m3u8" → "v0/index"（拡張子を外す）
            text = re.sub(r"(v\d+)/index\.m3u8", r"\1/index", text)
            return self.send(text.encode(), M3U8)

        m = re.match(r"^(v\d+)/(index|seg(\d+)|all)$", rest)
        if not m:
            return self.send_error(404)
        variant, what = m.group(1), m.group(2)
        segs = segments(variant)

        if what == "index":
            lines = media_header()
            if mode == "noext":
                for i, (dur, _) in enumerate(segs):
                    lines += [dur, f"seg{i:03d}?token=t{i}"]
            else:
                for dur, f in segs:
                    lines += [dur, f"#EXT-X-BYTERANGE:{f.stat().st_size}", "all"]
            lines.append("#EXT-X-ENDLIST")
            return self.send(("\n".join(lines) + "\n").encode(), M3U8)

        if what == "all":
            body = b"".join(f.read_bytes() for _, f in segs)
            return self.send(body, "video/mp2t", ranged=True)

        i = int(m.group(3))
        if i >= len(segs):
            return self.send_error(404)
        # CDN にありがちな汎用型。Content-Type では判別できない状態を作る
        return self.send(segs[i][1].read_bytes(), "application/octet-stream")

    def send(self, body, ctype, ranged=False):
        rng = self.headers.get("Range") if ranged else None
        m = re.match(r"bytes=(\d+)-(\d*)$", rng or "")
        if m:
            start = int(m.group(1))
            end = int(m.group(2)) if m.group(2) else len(body) - 1
            part = body[start:end + 1]
            self.send_response(206)
            self.send_header("Content-Range", f"bytes {start}-{end}/{len(body)}")
            body = part
        else:
            self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        if ranged:
            self.send_header("Accept-Ranges", "bytes")
        self.end_headers()
        self.wfile.write(body)

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
