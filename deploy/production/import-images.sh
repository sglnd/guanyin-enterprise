#!/bin/sh
set -eu

archive="${1:-}"
if [ -z "$archive" ]; then
  echo '用法：sh import-images.sh control-plane.tar.gz 或 dsh.tar.gz' >&2
  exit 1
fi
runtime="${CONTAINER_RUNTIME:-containerd}"
gzip -t "$archive"
case "$runtime" in
  containerd)
    image_tar=$(mktemp "${TMPDIR:-/tmp}/guanyin-enterprise-image.XXXXXX")
    trap 'rm -f "$image_tar"' EXIT HUP INT TERM
    gzip -dc "$archive" > "$image_tar"
    sudo ctr -n k8s.io images import --platform linux/amd64 "$image_tar"
    ;;
  docker)
    docker load -i "$archive"
    ;;
  *) echo "不支持的运行时：$runtime" >&2; exit 1 ;;
esac
echo '镜像导入完成。请在所有可能运行管理平台及工作空间的节点上分别导入两张镜像。'
