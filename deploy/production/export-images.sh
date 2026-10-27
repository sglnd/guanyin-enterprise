#!/bin/bash
set -euo pipefail

release="${GUANYIN_RELEASE:-0.7.2-enterprise.6}"
output_dir="${1:-dist/guanyin-enterprise-${release}-dual-dsh-offline-amd64}"
control_plane_image="${CONTROL_PLANE_IMAGE:-guanyin/control-plane:0.7.2-enterprise.6-amd64}"
dsh_image="${DSH_IMAGE:-bankops/guanyin-enterprise-dsh:0.2.1-rc.3-gy.ent.7-amd64}"
dsh_version="${DSH_VERSION:-0.2.1-rc.3-gy.ent.7}"
legacy_image="${LEGACY_DSH_IMAGE:-bankops/guanyin-enterprise-dsh:gy.ent.8-sync1-amd64}"
legacy_version="${LEGACY_DSH_VERSION:-0.1.5-rc.2-gy.ent.8-sync1}"
postgres_image="${POSTGRES_IMAGE:-guanyin/postgres:17.6-alpine-amd64}"
images=("$control_plane_image" "$dsh_image" "$legacy_image" "$postgres_image")

mkdir -p "$output_dir"
if [ -e "$output_dir/images.tar.gz" ]; then echo "输出目录已有镜像包，请使用新的目录：$output_dir" >&2; exit 1; fi
: > "$output_dir/image-list.txt"
architecture=""
for image in "${images[@]}"; do
  current="$(docker image inspect "$image" --format '{{.Os}}/{{.Architecture}}')"
  if [ -z "$architecture" ]; then architecture="$current"; fi
  if [ "$current" != "$architecture" ]; then echo "镜像架构不一致：$image 是 $current，其他镜像是 $architecture" >&2; exit 1; fi
  digest="$(docker image inspect "$image" --format '{{.Id}}')"
  printf '%s %s %s\n' "$image" "$current" "$digest" >> "$output_dir/image-list.txt"
done
case "$architecture" in linux/amd64|linux/arm64) ;; *) echo "不支持的平台：$architecture" >&2; exit 1;; esac
printf '%s\n' "$architecture" > "$output_dir/platform.txt"

export GY_PACKAGE_OUTPUT="$output_dir" GY_PACKAGE_RELEASE="$release" GY_PACKAGE_CP="$control_plane_image" GY_PACKAGE_DSH="$dsh_image" GY_PACKAGE_DSH_VERSION="$dsh_version" GY_PACKAGE_LEGACY="$legacy_image" GY_PACKAGE_LEGACY_VERSION="$legacy_version" GY_PACKAGE_PG="$postgres_image" GY_PACKAGE_PLATFORM="$architecture"
python3 - <<'PY'
import json, os, re
from pathlib import Path
get=lambda key: os.environ['GY_PACKAGE_'+key]
out=Path(get('OUTPUT'))
source=Path('deploy/production/kubernetes.yaml').read_text()
for pattern,value in [(r'(image:\s*)guanyin/control-plane:\S+',get('CP')),(r'(image:\s*)guanyin/postgres:\S+',get('PG')),(r'(- name: DSH_IMAGE\n\s+value: ).*',get('DSH')),(r'(- name: DSH_VERSION\n\s+value: ).*',get('DSH_VERSION'))]:
 source,n=re.subn(pattern,lambda m:m[1]+value,source)
 if not n: raise SystemExit('部署模板缺少目标：'+pattern)
extra=json.dumps([{'id':get('LEGACY_VERSION'),'label':'0.1.5-rc2','image':get('LEGACY'),'enabled':True}],separators=(',',':'))
source,n=re.subn(r'(- name: DSH_ADDITIONAL_VERSIONS\n\s+value: ).*',lambda m:m[1]+"'"+extra+"'",source)
if n!=1: raise SystemExit('部署模板的空间版本目录不唯一')
(out/'kubernetes.yaml').write_text(source)
doc=Path('docs/production-kubernetes-deployment.md').read_text()
for name,value in [('guanyin/control-plane:',get('CP')),('bankops/guanyin-enterprise-dsh:0.2.1',get('DSH')),('bankops/guanyin-enterprise-dsh:gy.ent.',get('LEGACY')),('guanyin/postgres:',get('PG'))]:
 doc=re.sub(re.escape(name)+r'[^`\s]+',lambda m:value,doc)
(out/'部署说明.md').write_text(doc)
(out/'release.json').write_text(json.dumps({'release':get('RELEASE'),'platform':get('PLATFORM'),'controlPlane':get('CP'),'database':get('PG'),'defaultSpace':{'version':get('DSH_VERSION'),'image':get('DSH')},'additionalSpaces':json.loads(extra)},ensure_ascii=False,indent=2)+'\n')
PY
cp deploy/production/import-images.sh "$output_dir/import-images.sh"
cp deploy/production/rbac-instance-manager.yaml "$output_dir/rbac-instance-manager.yaml"
cp docs/offline-audit.md "$output_dir/用户输入审计说明.md"
cp docs/offline-dual-runtime-release.md "$output_dir/版本说明.md"
cp docs/offline-license.md "$output_dir/License说明.md"
cp assets/licensing/guanyin-license-public.pem "$output_dir/guanyin-license-public.pem"
chmod 0755 "$output_dir/import-images.sh"
echo "正在导出 $architecture 的四张镜像，请稍候……"
docker save "${images[@]}" | gzip -1 > "$output_dir/images.tar.gz.tmp"
gzip -t "$output_dir/images.tar.gz.tmp"
mv "$output_dir/images.tar.gz.tmp" "$output_dir/images.tar.gz"
(cd "$output_dir" && shasum -a 256 images.tar.gz kubernetes.yaml rbac-instance-manager.yaml import-images.sh image-list.txt platform.txt release.json 部署说明.md 用户输入审计说明.md 版本说明.md License说明.md guanyin-license-public.pem > SHA256SUMS)
echo "离线交付包已生成：$output_dir"
