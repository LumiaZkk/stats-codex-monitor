#!/bin/bash
# Run this in the user's Terminal. Never paste the key into a shell command.
set +x
set -eu
umask 077
unset OPENAI_ADMIN_KEY OPENAI_API_KEY CONTROL_PLANE_API_KEY
if [ "$#" -lt 3 ] || [ "$#" -gt 4 ]; then
  printf 'Usage: launch.command <node24> <verified-tunnel-client> <approved-scope.json> [system|cloudflare_doh]\n' >&2
  exit 2
fi
NODE="$1"
CLIENT="$2"
SCOPE="$3"
RESOLVER="${4:-system}"
case "$RESOLVER" in system|cloudflare_doh) ;; *) printf 'Unsupported callback resolver\n' >&2; exit 2;; esac
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
trap 'unset CONTROL_PLANE_API_KEY' EXIT
printf 'Paste the 1-day Tunnels Read + Use runtime key here (hidden), then press Enter: ' > /dev/tty
IFS= read -r -s CONTROL_PLANE_API_KEY < /dev/tty
printf '\n' > /dev/tty
export CONTROL_PLANE_API_KEY
"$NODE" "$SCRIPT_DIR/runner.mts" "$CLIENT" "$SCOPE" "$RESOLVER"
