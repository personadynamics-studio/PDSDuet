#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd -P)"
LOGS="$ROOT/.logs"
mkdir -p "$LOGS"

setting() {
  local value
  value="$(sed -n "s/^$1=//p" "$ROOT/.env" | tail -1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/")"
  printf '%s' "${value:-$2}"
}

services=(postgres agent-computer agent-langgraph)
if [ "$(setting OPENBOT_ONE_COMPUTER_EACH true)" = true ]; then services+=(supervisor); fi
if [ "$(setting BOT_PROVIDER openai)" != anthropic ]; then services+=(agent-bot); fi
docker compose --env-file .env up -d --build "${services[@]}"
docker compose --env-file .env run --rm --build migrate
bun run --cwd app build

for name in api app worker; do
  if [ -f "$LOGS/pds-$name.pid" ]; then
    kill "$(cat "$LOGS/pds-$name.pid")" 2>/dev/null || true
    rm -f "$LOGS/pds-$name.pid"
  fi
done
(cd server && exec bun --env-file=../.env src/production-entry.ts) >>"$LOGS/server.log" 2>&1 &
printf '%s\n' "$!" > "$LOGS/pds-api.pid"
(cd app && exec bun --env-file=../.env serve.ts) >>"$LOGS/app.log" 2>&1 &
printf '%s\n' "$!" > "$LOGS/pds-app.pid"
bun --env-file=.env worker/src/index.ts >>"$LOGS/worker.log" 2>&1 &
printf '%s\n' "$!" > "$LOGS/pds-worker.pid"
printf 'OpenBot started. Logs: %s\n' "$LOGS"
