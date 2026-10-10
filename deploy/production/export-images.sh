#!/bin/sh
set -eu

release="${GUANYIN_RELEASE:-0.7.2-enterprise.3}"
output_dir="${1:-dist/guanyin-enterprise-${release}-offline-amd64}"
control_plane_image="${CONTROL_PLANE_IMAGE:-guanyin/control-plane:0.7.2-enterprise.2-amd64}"
dsh_image="${DSH_IMAGE:-bankops/guanyin-enterprise-dsh:0.1.5-rc.2-gy.ent.5-amd64}"
postgres_image="${POSTGRES_IMAGE:-guanyin/postgres:17.6-alpine-amd64}"
images="$control_plane_image $dsh_image $postgres_image"

mkdir -p "$output_dir"
: > "$output_dir/image-list.txt"
architecture=""
for image in $images; do
  docker image inspect "$image" >/dev/null
  current="$(docker image inspect "$image" --format '{{.Os}}/{{.Architecture}}')"
  if [ -z "$architecture" ]; then architecture="$current"; fi
  if [ "$current" != "$architecture" ]; then
    echo "镜像架构不一致：$image 是 $current，其他镜像是 $architecture" >&2
    exit 1
  fi
  digest="$(docker image inspect "$image" --format '{{.Id}}')"
  printf '%s %s %s\n' "$image" "$current" "$digest" >> "$output_dir/image-list.txt"
done

printf '%s\n' "$architecture" > "$output_dir/platform.txt"
echo "正在导出 $architecture 镜像，文件较大，请稍候……"
docker save $images | gzip -1 > "$output_dir/images.tar.gz"
cp deploy/production/kubernetes.yaml "$output_dir/kubernetes.yaml"
sed "s#guanyin/control-plane:0.7.2-enterprise.2-amd64#$control_plane_image#g; s#bankops/guanyin-enterprise-dsh:0.1.5-rc.2-gy.ent.5-amd64#$dsh_image#g; s#guanyin/postgres:17.6-alpine-amd64#$postgres_image#g" \
  "$output_dir/kubernetes.yaml" > "$output_dir/kubernetes.yaml.tmp"
mv "$output_dir/kubernetes.yaml.tmp" "$output_dir/kubernetes.yaml"
cp deploy/production/import-images.sh "$output_dir/import-images.sh"
cp deploy/production/rbac-instance-manager.yaml "$output_dir/rbac-instance-manager.yaml"
cp docs/production-kubernetes-deployment.md "$output_dir/部署说明.md"
sed "s#guanyin/control-plane:0.7.2-enterprise.2-amd64#$control_plane_image#g; s#bankops/guanyin-enterprise-dsh:0.1.5-rc.2-gy.ent.5-amd64#$dsh_image#g; s#guanyin/postgres:17.6-alpine-amd64#$postgres_image#g" \
  "$output_dir/部署说明.md" > "$output_dir/部署说明.md.tmp"
mv "$output_dir/部署说明.md.tmp" "$output_dir/部署说明.md"
chmod 0755 "$output_dir/import-images.sh"
(cd "$output_dir" && shasum -a 256 images.tar.gz kubernetes.yaml rbac-instance-manager.yaml import-images.sh image-list.txt platform.txt 部署说明.md > SHA256SUMS)
echo "离线交付包已生成：$output_dir"
