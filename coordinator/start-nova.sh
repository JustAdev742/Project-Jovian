#!/usr/bin/env bash
if pgrep -f "nova-backend/run-nova.sh" >/dev/null 2>&1; then exit 0; fi
setsid "$HOME/nova-backend/run-nova.sh" >/dev/null 2>&1 </dev/null &
