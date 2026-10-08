#!/bin/sh
# Starts the app as the unprivileged "node" user. Only the next few lines run as root: they make
# sure the persistent disk folder belongs to that user (a freshly attached disk may belong to root).
set -eu

if [ "$(id -u)" = "0" ]; then
  if [ -n "${DATA_DIR:-}" ] && [ -d "$DATA_DIR" ]; then
    # only when needed, never through symbolic links
    if [ "$(stat -c %u "$DATA_DIR")" != "$(id -u node)" ]; then
      chown -R -h node:node "$DATA_DIR"
    fi
  fi
  exec setpriv --reuid=node --regid=node --init-groups -- "$@"
fi

exec "$@"
