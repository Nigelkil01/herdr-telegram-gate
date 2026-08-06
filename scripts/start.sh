#!/usr/bin/env bash
# Start herdr-telegram-gate daemon in background (shadow mode by default).
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -f bot.pid ] && kill -0 "$(cat bot.pid)" 2>/dev/null; then
  echo "already running (pid $(cat bot.pid))"; exit 0
fi
nohup node bot.js >> bot.log 2>&1 &
echo $! > bot.pid
echo "started (pid $(cat bot.pid))"
