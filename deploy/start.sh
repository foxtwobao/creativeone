#!/bin/bash
set -euo pipefail

# The published image always uses the authenticated server edition.
export PORT=4011
sh /app/runtime-config.sh

# If either process exits, stop the other; Compose owns container restarts.
pids=()
cleanup() {
    trap - EXIT INT TERM
    if ((${#pids[@]})); then kill "${pids[@]}" 2>/dev/null || true; fi
    wait || true
}
trap cleanup EXIT
trap 'exit 0' INT TERM
node --import tsx src/index.ts &
pids+=("$!")
nginx -g 'daemon off;' &
pids+=("$!")
wait -n "${pids[@]}"
