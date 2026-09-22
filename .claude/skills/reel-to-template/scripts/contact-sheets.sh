#!/usr/bin/env bash
# Usage: contact-sheets.sh <draftId>
#
# Builds cheap-to-review evidence for the reel-to-template skill's
# analysis step, from authoring/<draftId>/source.mp4 — run AFTER
# `npm run author -- --draft <draftId> --only analyze`.
#
# Writes to authoring/<draftId>/evidence/:
#   contact-*.jpg   5x4 grids of frames sampled at 2fps (10s of source per
#                    sheet) — denser and grid-packed for fast visual
#                    scanning, independent of analyze.ts's own per-shot/
#                    dense frame sampling (authoring/<draftId>/frames/),
#                    which is what synthesize/the agent studies frame-by-
#                    frame for exact layout measurement.
#   waveform.png     Full-clip waveform — cutting rhythm, silence gaps.
#   spectrogram.png  Full-clip spectrogram — music presence/BPM feel, SFX
#                     hits, voice-only stretches, without listening.
set -euo pipefail

DRAFT_ID="${1:?usage: contact-sheets.sh <draftId>}"
DIR="authoring/$DRAFT_ID"
SRC="$DIR/source.mp4"
OUT="$DIR/evidence"

if [ ! -f "$SRC" ]; then
  echo "error: no $SRC — run \`npm run author -- --url <link> --only ingest\` (or --draft $DRAFT_ID --only ingest) first" >&2
  exit 1
fi

mkdir -p "$OUT"

ffmpeg -y -i "$SRC" -vf "fps=2,scale=360:-1,tile=5x4" \
  "$OUT/contact-%03d.jpg" -hide_banner -loglevel error

ffmpeg -y -i "$SRC" -filter_complex "showwavespic=s=1280x240:colors=0x3b82f6" \
  "$OUT/waveform.png" -hide_banner -loglevel error

ffmpeg -y -i "$SRC" -lavfi "showspectrumpic=s=1280x480" \
  "$OUT/spectrogram.png" -hide_banner -loglevel error

echo "wrote evidence to $OUT:"
ls "$OUT"
