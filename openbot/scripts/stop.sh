#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd -P)"
KEEP_COMPUTERS=false
for arg in "$@"; do
  case "$arg" in
    --keep-computers) KEEP_COMPUTERS=true ;;
    -h|--help) printf 'Usage: bash scripts/stop.sh [--keep-computers]\n'; exit 0 ;;
    *) printf 'Unknown argument: %s\n' "$arg" >&2; exit 1 ;;
  esac
done
setting() {
  local value
  value="$(sed -n "s/^$1=//p" "$ROOT/.env" | tail -1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/")"
  printf '%s' "${value:-$2}"
}
info() { printf '%s\n' "$1"; }
green() { printf '%s\n' "$1"; }
for name in app worker api; do
  file="$ROOT/.logs/pds-$name.pid"
  if [ -f "$file" ]; then
    kill "$(cat "$file")" 2>/dev/null || true
    rm -f "$file"
  fi
done
docker compose --env-file .env down

# Only this deployment's computers.
#
# `openbot.supervisor=true` marks every computer that any supervisor on this Docker host made, so
# filtering on that alone removed the computers of every other install on the host, including their
# signed-in browsers. Each computer also carries its deployment's `COMPUTER_NAMESPACE` in
# `openbot.namespace`, which is what the supervisor itself matches on, and a computer made before
# that label existed counts as the default namespace, `openbot` (supervisor/src/docker.ts, `ours`).
# This reads the namespace the way the supervisor does: blank is the default.
COMPUTER_NAMESPACE="$(setting COMPUTER_NAMESPACE openbot | tr -d '[:space:]')"
COMPUTER_NAMESPACE="${COMPUTER_NAMESPACE:-openbot}"
COMPUTERS="$(docker ps --filter label=openbot.supervisor=true \
  --format '{{.ID}} {{.Label "openbot.namespace"}}' 2>/dev/null \
  | COMPUTER_NAMESPACE="$COMPUTER_NAMESPACE" awk '
      { namespace = ($2 == "" ? "openbot" : $2) }
      namespace == ENVIRON["COMPUTER_NAMESPACE"] { print $1 }' || true)"
if [ -z "$COMPUTERS" ]; then
  info "  Bot computers: none running for namespace $COMPUTER_NAMESPACE"
elif [ "$KEEP_COMPUTERS" = "true" ]; then
  info "  Bot computers: left running ($(printf '%s\n' "$COMPUTERS" | wc -l | tr -d ' ')), as asked"
else
  # shellcheck disable=SC2086
  docker rm -f $COMPUTERS >/dev/null 2>&1 || true
  green "  Bot computers: removed ($(printf '%s\n' "$COMPUTERS" | wc -l | tr -d ' '))"
fi

cat <<EOF

$(green "Stopped.")

No data was deleted. PostgreSQL, each Bot's files and each Bot's browser profile are Docker
volumes, so channels, credentials and signed-in sessions are all still there next time.

Start again: bash scripts/start.sh
EOF
