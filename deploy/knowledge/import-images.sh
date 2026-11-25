#!/usr/bin/env sh
set -eu
package_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$package_dir"
if command -v sha256sum >/dev/null 2>&1; then sha256sum -c SHA256SUMS; else shasum -a 256 -c SHA256SUMS; fi
gzip -t images.tar.gz
case "${CONTAINER_RUNTIME:-containerd}" in
  containerd)
    image_tar=$(mktemp "${TMPDIR:-/tmp}/guanyin-knowledge-images.XXXXXX")
    trap 'rm -f "$image_tar"' EXIT HUP INT TERM
    gzip -dc images.tar.gz > "$image_tar"
    platform=$(sed -n 's/^platform=//p' images.txt)
    sudo ctr -n k8s.io images import --platform "$platform" "$image_tar"
    ;;
  docker) docker load -i images.tar.gz ;;
  *) echo 'CONTAINER_RUNTIME must be containerd or docker' >&2; exit 1 ;;
esac
echo '镜像已导入；请在所有可能调度控制台、Worker、PostgreSQL 和迁移 Job 的节点导入，或推送内网镜像仓库。此脚本不会部署或修改集群。'
