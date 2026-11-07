#!/bin/sh
# Rebuilds assets/sounds/ from the source recordings listed in
# assets/sounds/CREDITS.md. Usage: sh tools/make_sounds.sh <dir with sources>
set -e
SRC=${1:-.}
OUT=assets/sounds
# mono, rumble removed, loudness-normalised, silence trimmed from both ends
clean="highpass=f=90,loudnorm=I=-18:TP=-2:LRA=11,silenceremove=start_periods=1:start_threshold=-45dB,areverse,silenceremove=start_periods=1:start_threshold=-45dB,areverse"
ffmpeg -y -loglevel error -i "$SRC/mk464.mp3" -ac 1 -ar 44100 -af "$clean" -c:a libmp3lame -b:a 64k "$OUT/sob_gasps.mp3"
ffmpeg -y -loglevel error -i "$SRC/mk465.mp3" -ac 1 -ar 44100 -af "$clean" -c:a libmp3lame -b:a 64k "$OUT/sob_wail.mp3"
ffmpeg -y -loglevel error -i "$SRC/mk469.mp3" -ac 1 -ar 44100 -af "$clean,lowpass=f=5000" -c:a libmp3lame -b:a 56k "$OUT/sob_chorus.mp3"
ls -la "$OUT"
