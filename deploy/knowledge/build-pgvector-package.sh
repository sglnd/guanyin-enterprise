#!/usr/bin/env bash
set -euo pipefail
: "${GUANYIN_RELEASE:?Set GUANYIN_RELEASE to the release identifier}"
release="$GUANYIN_RELEASE"
[[ "$release" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[a-z0-9.-]+)?$ ]] || { echo 'Invalid release identifier' >&2; exit 1; }
platform="${TARGET_PLATFORM:-linux/amd64}"
case "$platform" in linux/amd64) arch=amd64;; linux/arm64) arch=arm64;; *) echo 'TARGET_PLATFORM must be linux/amd64 or linux/arm64' >&2; exit 1;; esac
control_image="${CONTROL_PLANE_IMAGE:-guanyin/control-plane:${release}-${arch}}"
postgres_image="${POSTGRES_IMAGE:-guanyin/postgres:17.6-pgvector0.8.7-${arch}}"
output="${1:-dist/guanyin-enterprise-${release}-enterprise-upgrade-${arch}}"
notes="${RELEASE_NOTES_FILE:-docs/knowledge/enterprise-integration.md}"
[ -f "$notes" ] || { echo "Release notes missing: $notes" >&2; exit 1; }
if [ "${SKIP_BUILD:-0}" != 1 ]; then
  docker buildx build --platform "$platform" --load \
    --label "org.opencontainers.image.version=$release" --label "io.guanyin.release=$release" --label io.guanyin.edition=enterprise \
    -f control-plane/Dockerfile -t "$control_image" .
  docker buildx build --platform "$platform" --load -f deploy/postgres-pgvector/Dockerfile \
    --build-arg "BASE_IMAGE=${POSTGRES_BASE_IMAGE:-postgres:17.6-alpine}" -t "$postgres_image" .
fi
for image in "$control_image" "$postgres_image"; do
  actual="$(docker image inspect "$image" --format '{{.Os}}/{{.Architecture}}')"
  [ "$actual" = "$platform" ] || { echo "Architecture mismatch: $image ($actual)" >&2; exit 1; }
done
[ "$(docker image inspect "$control_image" --format '{{index .Config.Labels "org.opencontainers.image.version"}}')" = "$release" ] || { echo 'Control image release label mismatch' >&2; exit 1; }
[ "$(docker image inspect "$postgres_image" --format '{{index .Config.Labels "io.guanyin.pgvector.version"}}')" = '0.8.7' ] || { echo 'PostgreSQL pgvector label mismatch' >&2; exit 1; }
mkdir -p "$output/knowledge"
docker save "$control_image" "$postgres_image" | gzip -1 > "$output/images.tar.gz"
cp deploy/knowledge/pvc.yaml deploy/knowledge/control-plane.patch.yaml deploy/knowledge/single-node-control-plane.patch.yaml "$output/knowledge/"
sed "s#image: guanyin/control-plane:.*#image: $control_image#" deploy/knowledge/worker.yaml > "$output/knowledge/worker.yaml"
sed "s#image: guanyin/postgres:.*#image: $postgres_image#" deploy/knowledge/pgvector-postgres.patch.yaml > "$output/knowledge/pgvector-postgres.patch.yaml"
job_name="guanyin-knowledge-migrate-${release//./-}"
sed "s#image: guanyin/control-plane:RELEASE-amd64#image: $control_image#; s#name: guanyin-knowledge-pgvector-migrate#name: $job_name#" deploy/knowledge/migrate-job.yaml > "$output/knowledge/migrate-job.yaml"
cp deploy/production/rbac-instance-manager.yaml "$output/"
cp deploy/knowledge/import-images.sh "$output/"
cp "$notes" "$output/部署说明.md"
cp docs/knowledge/pgvector-deployment.md "$output/pgvector部署说明.md"
cp docs/knowledge/independent-database.md "$output/独立向量库评估.md"
printf 'platform=%s\ncontrol-plane=%s\npostgres=%s\n' "$platform" "$control_image" "$postgres_image" > "$output/images.txt"
printf '%s\n' "$release" > "$output/VERSION"
if [ -n "${VERIFICATION_REPORT:-}" ]; then cp "$VERIFICATION_REPORT" "$output/verification.json"; fi
python3 - "$output" "$release" "$platform" "$control_image" "$postgres_image" <<'PY'
import sys,json,pathlib,hashlib,subprocess,datetime,zoneinfo,os
out=pathlib.Path(sys.argv[1])
files=set(pathlib.Path('control-plane').glob('*.mjs'))|set(pathlib.Path('control-plane/public').rglob('*'))
files.update([pathlib.Path('control-plane/package.json'),pathlib.Path('control-plane/package-lock.json'),pathlib.Path('control-plane/Dockerfile'),pathlib.Path('deploy/postgres-pgvector/Dockerfile'),pathlib.Path('.dockerignore')])
files.update(pathlib.Path('deploy/knowledge').glob('*'));files.update(pathlib.Path('assets/branding').glob('*.png'))
manifest=''.join(hashlib.sha256(p.read_bytes()).hexdigest()+'  '+p.as_posix()+'\n' for p in sorted(files) if p.is_file())
(out/'source-sha256.txt').write_text(manifest)
images=[]
for ref in sys.argv[4:]:
 info=json.loads(subprocess.check_output(['docker','image','inspect',ref]))[0]
 images.append({'tag':ref,'id':info['Id'],'platform':info['Os']+'/'+info['Architecture'],'labels':info['Config'].get('Labels') or {}})
if (out/'verification.json').exists():
 report=json.loads((out/'verification.json').read_text())
 assert report['release']==sys.argv[2] and report['platform']==sys.argv[3], 'Verification release/platform mismatch'
 assert all(report['images'].get(i['tag'])==i['id'] for i in images), 'Verification image digest mismatch'
(out/'build-manifest.json').write_text(json.dumps({'edition':'enterprise','release':sys.argv[2],'platform':sys.argv[3],'builtAt':datetime.datetime.now(zoneinfo.ZoneInfo('Asia/Shanghai')).isoformat(),'baseCommit':subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(),'workingTreeDirty':bool(subprocess.check_output(['git','status','--porcelain'],text=True).strip()),'sourceSnapshotSHA256':hashlib.sha256(manifest.encode()).hexdigest(),'databaseLayout':'shared-platform-database','postgresBaseReference':os.environ.get('POSTGRES_BASE_IMAGE','postgres:17.6-alpine'),'pgvectorSourceSHA256':'cac0b10c360f05b2d521200105ba3697e773d4cd3731f5a915a7e37ebe0bea85','images':images},ensure_ascii=False,indent=2)+'\n')
def digest(p):
 h=hashlib.sha256()
 with p.open('rb') as f:
  for block in iter(lambda:f.read(4*1024*1024),b''):h.update(block)
 return h.hexdigest()
(out/'SHA256SUMS').write_text(''.join(digest(p)+'  '+p.relative_to(out).as_posix()+'\n' for p in sorted(out.rglob('*')) if p.is_file() and p.name!='SHA256SUMS'))
PY
(cd "$output" && shasum -a 256 -c SHA256SUMS)
COPYFILE_DISABLE=1 tar --no-xattrs -cf - -C "$(dirname "$output")" "$(basename "$output")" | gzip -1 > "${output}.tar.gz"
(cd "$(dirname "${output}.tar.gz")" && shasum -a 256 "$(basename "${output}.tar.gz")") > "${output}.tar.gz.sha256"
echo "Enterprise upgrade package: ${output}.tar.gz"
