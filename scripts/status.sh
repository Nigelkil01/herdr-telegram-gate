#!/usr/bin/env bash
# Gate daemon status + diagnostics.
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -f bot.pid ] && kill -0 "$(cat bot.pid)" 2>/dev/null; then
  echo "gate daemon: RUNNING (pid $(cat bot.pid))"
else
  echo "gate daemon: not running"
fi
npm run doctor 2>&1 || true
