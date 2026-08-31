#!/usr/bin/env bash
# Boots the Go engine, the runtime server, and the web app together for local dev.
set -uo pipefail
cd "$(dirname "$0")/.."

# Job control (-m) puts each background job in its own process group, keyed
# by its PID. That lets cleanup below kill `go run`'s child binary and any
# npm-run grandchildren too, not just the direct child bash forked.
set -m

pids=()
cleanup() {
  echo
  echo "Stopping..."
  for pid in "${pids[@]}"; do
    kill -TERM -- "-$pid" 2>/dev/null
  done
}
trap cleanup EXIT INT TERM

make run &
pids+=($!)

npm run server -w apps/runtime &
pids+=($!)

npm run dev -w apps/web &
pids+=($!)

wait
