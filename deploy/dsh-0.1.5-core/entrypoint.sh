#!/bin/sh
set -eu

seed_home=/opt/dsh-seed
runtime_home=${DSH_HOME:-/data/dsh}
seed_marker="$seed_home/.bankops-release"
runtime_marker="$runtime_home/.bankops-release"

mkdir -p "$runtime_home" /workspace /home/node

if [ ! -f "$runtime_home/profiles/web/package.json" ]; then
  cp -R "$seed_home/." "$runtime_home/"
elif [ ! -f "$runtime_marker" ]; then
  echo "ERROR: $runtime_home contains an unmanaged or legacy DSH profile." >&2
  echo "Use a new Guanyin PVC or run an explicit profile migration first." >&2
  exit 78
fi

if [ -f "$runtime_marker" ] \
  && grep -qx 'dsh=0.1.5-rc.2' "$runtime_marker" \
  && grep -qx 'profile=guanyin-plugins-v5' "$seed_marker"; then
  if grep -Eqx 'profile=(official-core|guanyin-plugins|guanyin-plugins-v2|guanyin-plugins-v3|guanyin-plugins-v4)' "$runtime_marker"; then
    # Upgrade only the managed Web profile. Sessions, workspace files and all
    # other persisted runtime state remain untouched.
    cp -R "$seed_home/profiles/web/." "$runtime_home/profiles/web/"
    cp "$seed_marker" "$runtime_marker"
  fi
fi

if ! cmp -s "$seed_marker" "$runtime_marker"; then
  echo "ERROR: persisted profile release does not match this image." >&2
  echo "Guanyin must provision a new versioned workspace instead of merging profiles." >&2
  exit 78
fi

if [ "${GUANYIN_WEB_PROXY:-1}" = "1" ]; then
  node /opt/dsh-runtime/web-proxy.mjs &
fi

if [ "${1:-}" = "dsh" ] && [ -n "${DSH_TRUSTED_HOSTS:-}" ]; then
  old_ifs=$IFS
  IFS=,
  for trusted_host in $DSH_TRUSTED_HOSTS; do
    [ -z "$trusted_host" ] || set -- "$@" --trusted-host "$trusted_host"
  done
  IFS=$old_ifs
fi

if [ "${1:-}" = "dsh" ] && [ "${2:-}" = "--profile" ] && [ "${3:-}" = "web" ]; then
  : > /tmp/dsh-web.log
  "$@" 2>&1 | while IFS= read -r line; do
    echo "$line"
    case "$line" in
      *'dsh web: '*'?token='*)
        token=${line##*'?token='}
        printf '%s' "$token" > /tmp/dsh-web-token
        ;;
    esac
  done
  exit ${PIPESTATUS:-0}
fi
exec "$@"
