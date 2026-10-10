#!/usr/bin/env python3
"""Produce standalone Docker image archives from a pinned offline runtime.

No binary rebuild or dependency update: add current application files as a new
filesystem layer, keeping the baseline image's platform and startup config.
"""
import argparse, copy, datetime, gzip, hashlib, io, json, pathlib, shutil, tarfile, tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
def digest(data): return hashlib.sha256(data).hexdigest()
def file_digest(path):
    h=hashlib.sha256()
    with path.open('rb') as f:
        for chunk in iter(lambda:f.read(4*1024*1024),b''): h.update(chunk)
    return h.hexdigest()
def add_bytes(out, name, data):
    info = tarfile.TarInfo(name); info.size = len(data); info.mode = 0o644
    out.addfile(info, io.BytesIO(data))
def build(base, output, tag, files, labels, uid):
    with tempfile.TemporaryDirectory(prefix='guanyin-enterprise-image-') as temp:
        raw = pathlib.Path(temp) / 'base.tar'
        with gzip.open(base, 'rb') as src, raw.open('wb') as dst: shutil.copyfileobj(src, dst, 4*1024*1024)
        with tarfile.open(raw) as source:
            manifest = json.load(source.extractfile('manifest.json'))[0]
            config = json.load(source.extractfile(manifest['Config']))
            if (config.get('os'), config.get('architecture')) != ('linux', 'amd64'):
                raise ValueError(f'{base}: expected linux/amd64')
            original_startup = copy.deepcopy(config['config'])
            layer = io.BytesIO()
            with tarfile.open(fileobj=layer, mode='w', format=tarfile.PAX_FORMAT) as out:
                for name, content in sorted(files.items()):
                    if isinstance(content, pathlib.Path): content = content.read_bytes()
                    info = tarfile.TarInfo(name); info.size = len(content)
                    info.mode = 0o755 if name.endswith(('dsh-core-entrypoint', 'guanyin-enterprise-entrypoint')) else 0o644
                    info.uid = info.gid = 1000 if name.startswith('opt/dsh-seed/') else uid
                    out.addfile(info, io.BytesIO(content))
            layer = layer.getvalue(); layer_id = digest(layer); layer_name = f'{layer_id}/layer.tar'
            config['rootfs']['diff_ids'].append('sha256:' + layer_id)
            config.setdefault('history', []).append({'created_by':'Guanyin Enterprise offline source update'})
            config['config'].setdefault('Labels', {}).update(labels)
            for key in ['Entrypoint','Cmd','User','Env','WorkingDir']:
                assert config['config'].get(key) == original_startup.get(key), key
            config_bytes = json.dumps(config, separators=(',', ':')).encode(); config_id = digest(config_bytes)
            new_manifest = [{'Config':f'{config_id}.json','RepoTags':[tag],'Layers':manifest['Layers']+[layer_name]}]
            with output.open('wb') as file, gzip.GzipFile(filename='', mode='wb', fileobj=file, compresslevel=1, mtime=0) as gz, tarfile.open(fileobj=gz, mode='w|') as out:
                for name in manifest['Layers']:
                    member = source.getmember(name)
                    out.addfile(member, source.extractfile(member))
                add_bytes(out, layer_name, layer)
                add_bytes(out, f'{config_id}.json', config_bytes)
                add_bytes(out, 'manifest.json', json.dumps(new_manifest).encode())
            print(f'{tag} linux/amd64 sha256:{config_id}', flush=True)
            return {'tag':tag,'platform':'linux/amd64','configDigest':'sha256:'+config_id,'layerDigest':'sha256:'+layer_id,'files':{name:digest(content.read_bytes() if isinstance(content,pathlib.Path) else content) for name,content in files.items()}}
def main():
    parser=argparse.ArgumentParser();parser.add_argument('--base-dir',type=pathlib.Path,required=True);parser.add_argument('--output-dir',type=pathlib.Path,required=True);args=parser.parse_args()
    args.output_dir.mkdir(parents=True,exist_ok=True)
    cp={f'app/{p.name}':p for p in (ROOT/'control-plane').glob('*.mjs')}
    cp.update({f'app/public/{p.relative_to(ROOT/"control-plane/public").as_posix()}':p for p in (ROOT/'control-plane/public').rglob('*') if p.is_file()})
    cp.update({'app/package.json':ROOT/'control-plane/package.json','app/package-lock.json':ROOT/'control-plane/package-lock.json','app/public/guanyin-logo.png':ROOT/'assets/branding/guanyin-mark-graphite-cinnabar-v4.png'})
    dsh_root=ROOT/'deploy/dsh-0.1.5-core'
    dsh={'opt/dsh-runtime/model-sync.mjs':dsh_root/'model-sync.mjs','opt/dsh-runtime/web-proxy.mjs':dsh_root/'web-proxy.mjs','opt/dsh-runtime/guanyin-logo.png':ROOT/'assets/branding/guanyin-mark-graphite-cinnabar-v4.png','usr/local/bin/dsh-core-entrypoint':dsh_root/'entrypoint.sh','usr/local/bin/guanyin-enterprise-entrypoint':ROOT/'deploy/dsh-enterprise/entrypoint.sh','opt/dsh-seed/profiles/web/node_modules/@guanyin/dsh-ui-policy/lib/client.js':dsh_root/'guanyin-ui-policy/lib/client.js','opt/dsh-seed/.bankops-release':b'dsh=0.1.5-rc.2\nprofile=guanyin-enterprise-v5\n'}
    records=[build(args.base_dir/'control-plane.tar.gz',args.output_dir/'control-plane.tar.gz','guanyin/control-plane:0.7.2-enterprise.2-amd64',cp,{'org.opencontainers.image.version':'0.7.2-enterprise.2','io.guanyin.edition':'enterprise','io.guanyin.update':'0.7.2-enterprise.2'},10001),build(args.base_dir/'dsh.tar.gz',args.output_dir/'dsh.tar.gz','bankops/guanyin-enterprise-dsh:0.1.5-rc.2-gy.ent.5-amd64',dsh,{'org.opencontainers.image.version':'0.1.5-rc.2-gy.ent.5','io.guanyin.edition':'enterprise','io.guanyin.update':'0.7.2-enterprise.2','io.guanyin.models-contract':'1','io.guanyin.profile':'guanyin-enterprise-v5'},0)]
    (args.output_dir/'image-list.txt').write_text(''.join(f"{r['tag']} {r['platform']} {r['configDigest']}\n" for r in records))
    (args.output_dir/'build-manifest.json').write_text(json.dumps({'images':records,'baseArchives':{n:file_digest(args.base_dir/n) for n in ['control-plane.tar.gz','dsh.tar.gz']}},ensure_ascii=False,indent=2)+'\n')
if __name__=='__main__':main()
