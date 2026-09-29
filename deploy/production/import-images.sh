#!/bin/sh
set -eu

archive="${1:-images.tar.gz}"
runtime="${CONTAINER_RUNTIME:-containerd}"

case "$runtime" in
  containerd)
    gzip -dc "$archive" | sudo ctr -n k8s.io images import -
    ;;
  docker)
    docker load -i "$archive"
    ;;
  *)
    echo "不支持的 CONTAINER_RUNTIME=$runtime，仅支持 containerd 或 docker" >&2
    exit 1
    ;;
esac

echo "镜像导入完成。请在三个 Kubernetes 节点上分别执行本脚本。"
