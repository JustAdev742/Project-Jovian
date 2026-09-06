#!/bin/sh
# Keep the diagnostics dashboard reachable: the path-allowlist proxy, and a tunnel in front of it.
# Idempotent — cron runs this every 5 minutes and it exits immediately when both are already up.
#
# The proxy is what makes the tunnel safe to have at all: it forwards only the read-only admin views
# and 404s everything else, so publishing it does not publish the game API. See diag-proxy.mjs.
cd /home/admin_home/nova-backend || exit 0

if ! pgrep -f "diag-proxy.mjs" >/dev/null 2>&1; then
  setsid nohup node diag-proxy.mjs >> diag-proxy.log 2>&1 < /dev/null &
  sleep 2
fi

if ! pgrep -f "cloudflared tunnel --url http://127.0.0.1:3560" >/dev/null 2>&1; then
  : > diag-tunnel.log
  setsid nohup /home/admin_home/bin/cloudflared tunnel --url http://127.0.0.1:3560 \
      --edge-ip-version 6 --no-autoupdate >> diag-tunnel.log 2>&1 < /dev/null &
  # The URL is issued by Cloudflare at connect time and CHANGES on every restart, so it has to be
  # re-read rather than remembered.
  i=0
  while [ $i -lt 20 ]; do
    sleep 2
    U=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' diag-tunnel.log 2>/dev/null | head -1)
    [ -n "$U" ] && { echo "$U" > diag-public-url.txt; break; }
    i=$((i+1))
  done
fi
