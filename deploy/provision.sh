#!/usr/bin/env bash
#
# One-shot provisioning for a fresh Ubuntu 24.04 box.
#
#   ssh root@<ip> 'bash -s' < deploy/provision.sh
#
# Idempotent: safe to re-run after a failure. Installs system dependencies,
# builds whisper.cpp, downloads both models, and creates the deploy user —
# but does NOT clone the repo or start the app (see deploy/README.md).
set -euo pipefail

APP_USER="${APP_USER:-editable}"
APP_DIR="${APP_DIR:-/opt/editable}"
NODE_MAJOR=24

log() { printf '\n=== %s\n' "$*"; }

# Ubuntu 24.04 ("noble") renamed a batch of libraries for the 64-bit time_t
# transition (libasound2 -> libasound2t64 and friends). Remotion's own
# dependency list predates that, so try the t64 name first and fall back —
# rather than hardcoding either and breaking on the other release.
apt_install_either() {
  for pkg in "$@"; do
    if apt-cache show "${pkg}t64" >/dev/null 2>&1; then
      DEBIAN_FRONTEND=noninteractive apt-get install -y "${pkg}t64"
    else
      DEBIAN_FRONTEND=noninteractive apt-get install -y "$pkg"
    fi
  done
}

log "System packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get upgrade -y
apt-get install -y \
  curl git ca-certificates gnupg ufw unattended-upgrades \
  build-essential cmake pkg-config \
  ffmpeg \
  python3 python3-pil \
  fonts-dejavu-core fonts-liberation

log "Chromium runtime libraries (for Remotion's headless render)"
apt_install_either \
  libnss3 libdbus-1-3 libatk1.0-0 libasound2 libxrandr2 libxkbcommon0 \
  libxfixes3 libxcomposite1 libxdamage1 libatk-bridge2.0-0 \
  libpango-1.0-0 libcairo2 libcups2 libgbm1

log "Node ${NODE_MAJOR}"
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v)" != v${NODE_MAJOR}* ]]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
fi
node -v

log "whisper.cpp (apt has no whisper-cli — it must be built)"
if ! command -v whisper-cli >/dev/null 2>&1; then
  rm -rf /usr/local/src/whisper.cpp
  git clone --depth 1 https://github.com/ggml-org/whisper.cpp /usr/local/src/whisper.cpp
  cmake -S /usr/local/src/whisper.cpp -B /usr/local/src/whisper.cpp/build -DCMAKE_BUILD_TYPE=Release
  cmake --build /usr/local/src/whisper.cpp/build -j"$(nproc)" --config Release
  ln -sf /usr/local/src/whisper.cpp/build/bin/whisper-cli /usr/local/bin/whisper-cli
fi
whisper-cli --help >/dev/null 2>&1 && echo "whisper-cli OK"

log "Swap (guards against an esbuild/Chromium spike on an 8GB box)"
if [[ ! -f /swapfile ]]; then
  fallocate -l 4G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

log "Deploy user + app directory"
if ! id -u "$APP_USER" >/dev/null 2>&1; then
  adduser --system --group --home "$APP_DIR" --shell /bin/bash "$APP_USER"
fi
mkdir -p "$APP_DIR"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

log "Models (gitignored — they are downloaded, never cloned)"
sudo -u "$APP_USER" mkdir -p "$APP_DIR/models"
if [[ ! -f "$APP_DIR/models/ggml-base.en.bin" ]]; then
  sudo -u "$APP_USER" curl -fL -o "$APP_DIR/models/ggml-base.en.bin" \
    https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin
fi
# NOT optional on Linux, despite what README.md says: matte.swift's Apple
# Vision fallback does not exist here, so a missing model means every
# talking-head job fails at intake.
if [[ ! -f "$APP_DIR/models/rvm_mobilenetv3_fp32.onnx" ]]; then
  sudo -u "$APP_USER" curl -fL -o "$APP_DIR/models/rvm_mobilenetv3_fp32.onnx" \
    https://github.com/PeterL1n/RobustVideoMatting/releases/download/v1.0.0/rvm_mobilenetv3_fp32.onnx
fi

log "Caddy (TLS terminator — no default request body cap, unlike nginx)"
if ! command -v caddy >/dev/null 2>&1; then
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
    | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  apt-get update
  apt-get install -y caddy
fi

log "Firewall"
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

log "Unattended security upgrades"
dpkg-reconfigure -f noninteractive unattended-upgrades

cat <<EOF

Provisioning complete.

  node        $(node -v)
  ffmpeg      $(ffmpeg -version | head -1 | cut -d' ' -f3)
  whisper-cli $(command -v whisper-cli)
  models      $(ls -1 "$APP_DIR/models" | tr '\n' ' ')

Next: deploy/README.md, "Deploy the app".
EOF
