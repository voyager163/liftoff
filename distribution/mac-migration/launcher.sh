#!/bin/sh
set -eu
script=$0
count=0
while [ -L "$script" ]; do
  count=$((count + 1))
  [ "$count" -le 32 ] || { printf '%s\n' 'Migration launcher link limit exceeded.' >&2; exit 1; }
  directory=$(CDPATH='' cd -- "$(/usr/bin/dirname -- "$script")" && pwd -P)
  target=$(/usr/bin/readlink -- "$script")
  case "$target" in /*) script=$target ;; *) script=$directory/$target ;; esac
done
root=$(CDPATH='' cd -- "$(/usr/bin/dirname -- "$script")/.." && pwd -P)
unset NODE_OPTIONS NODE_PATH
export DO_NOT_TRACK=1 LIFTOFF_TELEMETRY=0
exec "$root/core/runtime/node" "$root/core/application/dist/cli/mac-migration.js" "$@"
