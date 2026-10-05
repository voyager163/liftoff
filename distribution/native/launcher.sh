#!/bin/sh
set -eu

# Homebrew may invoke this file through a relative or absolute launcher link.
entry=$0
case "$entry" in
  /*) ;;
  *) entry=$PWD/$entry ;;
esac
hops=0
while [ -L "$entry" ]; do
  if [ "$hops" -ge 32 ]; then
    printf '%s\n' 'Liftoff launcher link chain exceeds 32 entries.' >&2
    exit 1
  fi
  parent=$(CDPATH= cd -P -- "${entry%/*}" && pwd)
  target=$(/usr/bin/readlink "$entry")
  case "$target" in
    /*) entry=$target ;;
    *) entry=$parent/$target ;;
  esac
  hops=$((hops + 1))
done
root=$(CDPATH= cd -P -- "${entry%/*}/.." && pwd)

# Do not expose the private runtime on PATH or load ambient Node startup code.
unset NODE_OPTIONS NODE_PATH
exec "$root/runtime/node" "$root/application/dist/cli.js" "$@"
