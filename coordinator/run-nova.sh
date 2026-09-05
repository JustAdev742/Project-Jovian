#!/usr/bin/env bash
# Nova backend supervisor.
#
# Started by start-nova.sh, which cron runs every minute and which does nothing if this script is
# already running (`pgrep -f nova-backend/run-nova.sh`). Keep the path and name — that guard depends
# on both.
#
# WHY THE BACKOFF (added 2026-09-05). The backend now treats a failed HTTP bind as fatal and exits 1,
# instead of the old behaviour of logging the error and carrying on with no HTTP surface at all — a
# live process that looked healthy from outside while holding the SQLite database open. That is the
# right call, but with an unconditional 3-second restart it turns a genuinely stuck port into a hot
# loop: 20 starts a minute, each appending its banner to a log that had already reached 12 MB.
#
# So: a backend that dies QUICKLY is treated as failing, and the wait grows 3 → 6 → 12 → 24 → 48 → 60.
# One that ran long enough to have served traffic resets the wait to 3 seconds, because that is an
# ordinary crash and should be recovered from promptly. The distinction is what stops a permanent
# fault from being retried at the same rate as a transient one.
set -u

cd "$HOME/nova-backend" || exit 1
export PATH="$HOME/.local/bin:$PATH"

LOG="$HOME/nova-backend/nova.log"
MIN_HEALTHY_SECONDS=30     # ran at least this long → treat the exit as a one-off
BACKOFF_MIN=3
BACKOFF_MAX=60
MAX_LOG_BYTES=$((50 * 1024 * 1024))

backoff=$BACKOFF_MIN

# Keep nova.log bounded. It is the only record of what the backend did, so it is rotated rather than
# truncated — one generation back is enough to cover the run before the one that went wrong.
rotate_log_if_huge() {
  local size
  size=$(stat -c%s "$LOG" 2>/dev/null || echo 0)
  if [ "$size" -gt "$MAX_LOG_BYTES" ]; then
    mv -f "$LOG" "$LOG.1" 2>/dev/null || true
    echo "[run-nova] $(date -Is) rotated nova.log at ${size} bytes" >> "$LOG"
  fi
}

while true; do
  rotate_log_if_huge

  echo "[run-nova] $(date -Is) starting backend" >> "$LOG"
  started=$(date +%s)
  node_modules/.bin/tsx src/index.ts >> "$LOG" 2>&1
  code=$?
  ran=$(( $(date +%s) - started ))

  if [ "$ran" -ge "$MIN_HEALTHY_SECONDS" ]; then
    backoff=$BACKOFF_MIN
  else
    # Died fast. Something is wrong that restarting immediately will not fix — most likely the port
    # is held, which is now a deliberate exit(1) rather than a silent headless process.
    backoff=$(( backoff * 2 ))
    [ "$backoff" -gt "$BACKOFF_MAX" ] && backoff=$BACKOFF_MAX
  fi

  echo "[run-nova] $(date -Is) backend exited ${code} after ${ran}s, restart in ${backoff}s" >> "$LOG"
  sleep "$backoff"
done
