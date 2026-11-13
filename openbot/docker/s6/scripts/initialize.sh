#!/bin/sh
# Initialize the schema when this container owns the local PostgreSQL database.
set -eu
[ "${EMBEDDED_POSTGRES:-off}" = "on" ] || exit 0
cd /app/server
export HOME=/home/apiuser
exec s6-setuidgid apiuser /usr/local/bin/bun scripts/initialize.ts
