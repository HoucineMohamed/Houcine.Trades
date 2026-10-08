#!/bin/sh
# Starts the app as the unprivileged "node" user. Only the next few lines run as root: they make
# sure the persistent disk folder belongs to that user (a freshly attached disk may belong to root).
set -eu

if [ "$(id -u)" = "0" ]; then
  if [ -n "${DATA_DIR:-}" ] && [ -d "$DATA_DIR" ]; then
    # never hand a system folder (or the code) to the app user, whatever DATA_DIR was set to
    case "$(realpath "$DATA_DIR")" in
      / | /var | /home | /app | /app/* | /bin | /bin/* | /boot | /boot/* | /dev | /dev/* | /etc | /etc/* | /lib | /lib/* | /lib64 | /lib64/* | /proc | /proc/* | /root | /root/* | /run | /run/* | /sbin | /sbin/* | /sys | /sys/* | /usr | /usr/* | /tmp)
        echo '{"level":"error","service":"entrypoint","event":"entrypoint.bad_data_dir"}' >&2
        exit 78
        ;;
    esac
    # only when needed, never through symbolic links
    if [ "$(stat -c %u "$DATA_DIR")" != "$(id -u node)" ]; then
      chown -R -h node:node "$DATA_DIR"
    fi
  fi
  exec setpriv --reuid=node --regid=node --init-groups -- "$@"
fi

exec "$@"
