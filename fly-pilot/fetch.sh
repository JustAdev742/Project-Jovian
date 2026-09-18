#!/usr/bin/env bash
set -u
BASE="https://storage.googleapis.com/flyem-male-cns/v1.0/connectome-data/flat-connectome"
cd "$(dirname "$0")/data/raw"
get() {
  local f="$1"
  echo "[fetch] $f"
  curl -fsSL -C - --retry 5 --retry-delay 3 -o "$f" "$BASE/$f" && echo "[done] $f $(stat -c %s "$f") bytes" || echo "[FAIL] $f"
}
for f in "$@"; do get "$f"; done
