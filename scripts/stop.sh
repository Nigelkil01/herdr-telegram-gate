#!/usr/bin/env bash
# Stop the gate daemon.
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -f bot.pid ]; then
  kill "$(cat bot.pid)" 2>/dev/null && echo "stopped (pid $(cat bot.pid))" || echo "not running"
  rm -f bot.pid
else
  echo "not running"
fi
