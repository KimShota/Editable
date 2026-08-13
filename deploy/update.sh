#!/usr/bin/env bash
#
# Pull main and redeploy — but only when there's something new AND nothing is
# mid-flight. Run by editable-deploy.timer every few minutes; safe to run by
# hand at any time.
#
# Why the in-flight check isn't optional: `npm ci` deletes node_modules before
# reinstalling it, and a running build/render is a child process reading out of
# exactly that directory (tsx, the Remotion CLI, onnxruntime-node's prebuilt
# .node). Deploying under a live job doesn't just restart it early — it pulls
# the interpreter out from under a process that's minutes into writing job
# artifacts. So a busy box is a reason to come back later, not to push through.
#
# Doing nothing is the overwhelmingly common outcome: no new commits, exit 0,
# silent. The log only gets interesting when a deploy actually runs.

set -euo pipefail

APP_DIR=${APP_DIR:-/opt/editable}
APP_USER=${APP_USER:-editable}
SERVICE=${SERVICE:-editable}
BRANCH=${BRANCH:-main}
LOCK=${LOCK:-/run/editable-deploy.lock}

# A job whose status file hasn't been touched in this long is treated as
# abandoned rather than active. Without it, one process killed mid-build leaves
# a status file reading "building" forever and every future deploy defers to a
# job that will never finish. Renders rewrite their status on each progress
# chunk and builds on each completed stage, so a genuinely live job refreshes
# far more often than this; the window only has to outlast the slowest single
# stage.
STALE_AFTER_MIN=${STALE_AFTER_MIN:-180}

# Skip the in-flight check. For "I know the box is idle and I want this now".
FORCE=${FORCE:-0}

log() { printf '%s\n' "$*"; }

# Unprivileged for everything touching the repo: this script runs as root (it
# needs systemctl), but git/npm must not leave root-owned files in a tree the
# service reads as `editable`. runuser sets HOME, so npm's cache stays put.
as_app() { runuser -u "$APP_USER" -- "$@"; }
in_app() {
  runuser -u "$APP_USER" -- env PATH=/usr/local/bin:/usr/bin:/bin \
    bash -c "cd '$APP_DIR' && $1"
}

# One deploy at a time. systemd already won't run two copies of the oneshot
# unit concurrently, but this script is also meant to be run by hand, and a
# manual run racing a timer tick through `npm ci` is exactly the corruption
# this whole file exists to prevent.
exec 9>"$LOCK"
if ! flock -n 9; then
  log "another deploy holds $LOCK — leaving this cycle to it"
  exit 0
fi

# --- Is there anything to deploy? ------------------------------------------
# Cheapest check first, and the one that's true ~always. Note this fetches into
# FETCH_HEAD without moving the working tree, so bailing out here is free.

current=$(as_app git -C "$APP_DIR" rev-parse HEAD)
as_app git -C "$APP_DIR" fetch -q --depth 1 origin "$BRANCH"
target=$(as_app git -C "$APP_DIR" rev-parse FETCH_HEAD)

if [[ "$current" == "$target" ]]; then
  exit 0
fi

subject=$(as_app git -C "$APP_DIR" log -1 --format=%s FETCH_HEAD)
log "new $BRANCH: ${current:0:7} -> ${target:0:7}  ($subject)"

# --- Is it safe to deploy right now? ---------------------------------------

# Ground truth, and immune to the stale-status-file problem below: the pipeline
# parent process is alive for the entire duration of a build or render, with
# ffmpeg/whisper-cli/Chromium underneath it.
pipeline_procs() {
  pgrep -u "$APP_USER" -f 'src/backend/pipeline/run\.ts' 2>/dev/null || true
}

# Catches what pgrep can't: a job the API has accepted and written as
# "building" but which is still parked in pipelineQueue's in-memory waiter list
# with no process yet. Restarting would drop it with no record anywhere that it
# was ever queued — the browser would poll a status file that stops advancing.
active_jobs() {
  local now cutoff f mtime
  now=$(date +%s)
  cutoff=$((STALE_AFTER_MIN * 60))
  shopt -s nullglob
  for f in "$APP_DIR"/artifacts/*/build-status.json "$APP_DIR"/artifacts/*/render-status.json; do
    grep -q '"status": *"\(building\|rendering\)"' "$f" 2>/dev/null || continue
    mtime=$(stat -c %Y "$f" 2>/dev/null) || continue
    (( now - mtime > cutoff )) && continue
    printf '%s\n' "${f#"$APP_DIR"/artifacts/}"
  done
}

if [[ "$FORCE" != "1" ]]; then
  procs=$(pipeline_procs)
  jobs=$(active_jobs)
  if [[ -n "$procs" || -n "$jobs" ]]; then
    log "deferring — work in flight (retrying next cycle):"
    [[ -n "$procs" ]] && log "  pipeline pids: $(tr '\n' ' ' <<<"$procs")"
    [[ -n "$jobs" ]] && while read -r j; do log "  active: $j"; done <<<"$jobs"
    exit 0
  fi
fi

# --- Deploy ----------------------------------------------------------------
# Past this point a failure leaves the box in a partly-updated state, so say
# how to get back rather than making someone reconstruct it from the runbook.

rollback() {
  log ""
  log "DEPLOY FAILED — service NOT restarted, still serving the previous build."
  log "To return to ${current:0:7}:"
  log "  sudo -u $APP_USER -H bash -c 'cd $APP_DIR \\"
  log "    && git checkout -q -B $BRANCH $current && npm ci && npm run app:build'"
  log "  systemctl restart $SERVICE"
}
trap rollback ERR

log "checking out ${target:0:7}"
as_app git -C "$APP_DIR" checkout -q -B "$BRANCH" FETCH_HEAD

log "npm ci"
in_app "npm ci"

# No-op when there's nothing new (it tracks applied files in
# schema_migrations). Ahead of the build for the usual reason: shipping code
# that expects a table the database doesn't have is the failure this ordering
# prevents.
log "npm run db:migrate"
in_app "npm run db:migrate"

log "npm run app:build"
in_app "npm run app:build"

trap - ERR

log "restarting $SERVICE"
systemctl restart "$SERVICE"

# `systemctl restart` returns once systemd has forked the process, which is not
# the same as Next having bound the port. Give it a moment before declaring the
# deploy good, so a service that starts and immediately dies gets reported as a
# failure here instead of being discovered by a user.
sleep 5
if systemctl is-active --quiet "$SERVICE"; then
  log "deployed ${target:0:7} ✔"
else
  log "$SERVICE is NOT active after restart — journalctl -u $SERVICE -n 50"
  exit 1
fi
