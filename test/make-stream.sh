#!/usr/bin/env bash
# 検証用の HLS を ffmpeg でローカル生成する。
#
# 3段のビットレート階段を作るので、ABR の切替とバリアント判別まで検証できる。
# 映像は合成パターン + タイムコードなので素材ファイルが要らない。
#
#   ./test/make-stream.sh [秒数]
set -euo pipefail

DUR="${1:-60}"
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$HERE/stream"

command -v ffmpeg >/dev/null || { echo "ffmpeg が見つかりません"; exit 1; }

rm -rf "$OUT"
mkdir -p "$OUT"

echo "HLS を生成中... (${DUR}秒 / 3バリアント)"

# testsrc2 は動きが多くビットレートが素直に出る。フレーム番号も焼き込む。
ffmpeg -hide_banner -loglevel error \
  -f lavfi -i "testsrc2=size=1280x720:rate=30,drawtext=text='%{n}':fontsize=72:fontcolor=white:x=40:y=40" \
  -f lavfi -i "sine=frequency=440:sample_rate=48000" \
  -t "$DUR" \
  -filter_complex "[0:v]split=3[v1][v2][v3]; \
                   [v1]scale=1280:720[v1out]; \
                   [v2]scale=854:480[v2out]; \
                   [v3]scale=640:360[v3out]" \
  -map "[v1out]" -c:v:0 libx264 -b:v:0 2800k -maxrate:v:0 3000k -bufsize:v:0 4200k \
  -map "[v2out]" -c:v:1 libx264 -b:v:1 1400k -maxrate:v:1 1500k -bufsize:v:1 2100k \
  -map "[v3out]" -c:v:2 libx264 -b:v:2  600k -maxrate:v:2  650k -bufsize:v:2  900k \
  -map 1:a -map 1:a -map 1:a -c:a aac -b:a 128k -ac 2 \
  -x264-params "keyint=60:min-keyint=60:scenecut=0" \
  -preset veryfast -g 60 -sc_threshold 0 \
  -f hls -hls_time 4 -hls_playlist_type vod -hls_list_size 0 \
  -hls_segment_filename "$OUT/v%v/seg%03d.ts" \
  -master_pl_name "master.m3u8" \
  -var_stream_map "v:0,a:0 v:1,a:1 v:2,a:2" \
  "$OUT/v%v/index.m3u8"

echo
echo "生成しました: $OUT"
find "$OUT" -name '*.m3u8' | sort | sed "s|$HERE/|  test/|"
echo "  セグメント $(find "$OUT" -name '*.ts' | wc -l | tr -d ' ') 個 / 合計 $(du -sh "$OUT" | cut -f1)"
