#!/bin/sh
# Installs Demucs (vocal separation, run locally) into its own Python environment
# outside the repo, where analysis/vocals.ts looks for it (override with DEMUCS_BIN).
# About 1-2 GB (PyTorch); the model itself (~80 MB) downloads on first use.
#
#   npm run setup:vocals
set -eu
DIR="${HOME}/.cache/editable/demucs-venv"
if ! command -v uv >/dev/null 2>&1; then
  echo "uv is required: brew install uv" >&2
  exit 1
fi
mkdir -p "$(dirname "$DIR")"
# Python 3.12: PyTorch and Demucs are built for it; newer Pythons lag.
uv venv --python 3.12 "$DIR"
uv pip install --python "$DIR/bin/python" demucs torch torchaudio soundfile
"$DIR/bin/python" -c "import demucs, torch; print('demucs ready, torch', torch.__version__)"
echo "installed: $DIR/bin/demucs"
