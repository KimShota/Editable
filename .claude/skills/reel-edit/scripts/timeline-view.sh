#!/usr/bin/env bash
# Usage: timeline-view.sh <video> <startSec> <endSec> [outDir]
#
# A filmstrip (6 frames spread evenly across the window) + a waveform for
# that same window — the fast way to eyeball a cut boundary, the first/
# last couple seconds, or a mid-point in a RENDERED video without
# scrubbing the whole thing by hand. Used by reel-edit's self-check step
# (see SKILL.md) — never as a substitute for actually watching the final
# output before handing it to the user.
set -euo pipefail

VIDEO="${1:?usage: timeline-view.sh <video> <startSec> <endSec> [outDir]}"
START="${2:?usage: timeline-view.sh <video> <startSec> <endSec> [outDir]}"
END="${3:?usage: timeline-view.sh <video> <startSec> <endSec> [outDir]}"
OUT="${4:-/tmp/timeline-view}"

if [ ! -f "$VIDEO" ]; then
  echo "error: no such file: $VIDEO" >&2
  exit 1
fi

mkdir -p "$OUT"
DUR=$(node -e "const d=($END)-($START); if(!(d>0)) throw new Error('end must be after start'); console.log(d.toFixed(3))")
STAMP=$(date +%s%N)
STEM="$OUT/$(basename "${VIDEO%.*}")-${START}-${END}-${STAMP}"

ffmpeg -y -ss "$START" -i "$VIDEO" -t "$DUR" -vf "fps=6,scale=240:-1,tile=6x1" -frames:v 1 \
  "${STEM}-filmstrip.jpg" -hide_banner -loglevel error

ffmpeg -y -ss "$START" -i "$VIDEO" -t "$DUR" -filter_complex "showwavespic=s=960x160:colors=0x3b82f6" \
  "${STEM}-waveform.png" -hide_banner -loglevel error

echo "${STEM}-filmstrip.jpg"
echo "${STEM}-waveform.png"
