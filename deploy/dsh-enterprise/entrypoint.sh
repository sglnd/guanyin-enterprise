#!/bin/sh
set -eu

seed_home=/opt/dsh-seed
runtime_home=${DSH_HOME:-/data/dsh}
seed_marker="$seed_home/.bankops-release"
runtime_marker="$runtime_home/.bankops-release"

# Enterprise v5 restores the Guanyin UI policy and renders the full-color logo after deriving from the
# community image. Migrate that image-managed Web profile explicitly while
# preserving sessions, workspace files, home data,
# credentials and every other file stored on the existing PVCs.
if [ -f "$runtime_home/profiles/web/package.json" ] \
  && [ -f "$runtime_marker" ] \
  && grep -qx 'dsh=0.1.5-rc.2' "$runtime_marker" \
  && grep -qx 'dsh=0.1.5-rc.2' "$seed_marker" \
  && grep -qx 'profile=guanyin-enterprise-v5' "$seed_marker"; then
  if grep -Eqx 'profile=(official-core|guanyin-plugins|guanyin-plugins-v2|guanyin-plugins-v3|guanyin-plugins-v4|guanyin-plugins-v5|guanyin-plugins-v6|guanyin-plugins-v7|guanyin-plugins-v8|guanyin-plugins-v9|guanyin-plugins-v10|guanyin-plugins-v11|guanyin-plugins-v12|guanyin-plugins-v13|guanyin-plugins-v14|guanyin-plugins-v15|guanyin-plugins-v16|guanyin-enterprise-v1|guanyin-enterprise-v2|guanyin-enterprise-v3|guanyin-enterprise-v4)' "$runtime_marker"; then
    cp -R "$seed_home/profiles/web/." "$runtime_home/profiles/web/"
    cp "$seed_marker" "$runtime_marker"
  fi
fi

exec dsh-core-entrypoint "$@"
