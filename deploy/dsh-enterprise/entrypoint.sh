#!/bin/sh
set -eu

seed_home=/opt/dsh-seed
runtime_home=${DSH_HOME:-/data/dsh}
seed_marker="$seed_home/.bankops-release"
runtime_marker="$runtime_home/.bankops-release"

# Enterprise v2 changes only image-managed Web profile code. Migrate that
# profile explicitly while preserving sessions, workspace files, home data,
# credentials and every other file stored on the existing PVCs.
if [ -f "$runtime_home/profiles/web/package.json" ] \
  && [ -f "$runtime_marker" ] \
  && grep -qx 'dsh=0.1.5-rc.2' "$runtime_marker" \
  && grep -qx 'dsh=0.1.5-rc.2' "$seed_marker" \
  && grep -qx 'profile=guanyin-enterprise-v2' "$seed_marker"; then
  if grep -Eqx 'profile=(official-core|guanyin-plugins|guanyin-plugins-v2|guanyin-plugins-v3|guanyin-plugins-v4|guanyin-plugins-v5|guanyin-plugins-v6|guanyin-plugins-v7|guanyin-plugins-v8|guanyin-plugins-v9|guanyin-plugins-v10|guanyin-plugins-v11|guanyin-plugins-v12|guanyin-plugins-v13|guanyin-enterprise-v1)' "$runtime_marker"; then
    cp -R "$seed_home/profiles/web/." "$runtime_home/profiles/web/"
    cp "$seed_marker" "$runtime_marker"
  fi
fi

exec dsh-core-entrypoint "$@"
