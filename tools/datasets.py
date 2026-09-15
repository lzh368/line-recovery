"""Check packaged inputs or recreate upload ZIPs. Standard library only; no model calls."""
import argparse
import hashlib
import json
import zipfile
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
DATA=ROOT/'data/dataset'


def check_case(path):
    manifest=json.loads((path/'manifest.json').read_text(encoding='utf-8'))
    entries=manifest['files']
    expected={e['path'] for e in entries}
    actual={p.relative_to(path).as_posix() for p in path.rglob('*') if p.is_file() and p.name!='manifest.json'}
    if expected!=actual or len(entries)!=len(expected):raise ValueError('Manifest coverage mismatch: '+str(path))
    for item in entries:
        name=item['path'];p=path/name
        if Path(name).is_absolute() or '..' in Path(name).parts or p.is_symlink():raise ValueError('Unsafe path')
        raw=p.read_bytes()
        if len(raw)!=item['bytes'] or hashlib.sha256(raw).hexdigest()!=item['sha256']:raise ValueError('File changed: '+str(p))
    return len(entries)+1


def pack(path,dest):
    check_case(path)
    dest.parent.mkdir(parents=True,exist_ok=True)
    # Build bytes first. Never silently replace a different existing ZIP.
    import io
    buf=io.BytesIO()
    with zipfile.ZipFile(buf,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=6) as z:
        for p in sorted(path.rglob('*')):
            if p.is_file():
                info=zipfile.ZipInfo(p.relative_to(path).as_posix(),date_time=(2026,9,15,0,0,0))
                info.compress_type=zipfile.ZIP_DEFLATED;info.external_attr=0o100644<<16
                z.writestr(info,p.read_bytes())
    raw=buf.getvalue()
    if dest.exists():
        if dest.read_bytes()!=raw:raise FileExistsError('Different archive exists: '+str(dest))
    else:dest.write_bytes(raw)
    return len(raw)


def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('command',choices=['check','zip']);p.add_argument('--split',choices=['optimization','test','all'],default='all');a=p.parse_args()
    entries=json.loads((DATA/'split-manifest.json').read_text(encoding='utf-8'))['cases']
    cases=0;files=0;bytes_=0
    for e in entries:
        if a.split!='all' and e['split']!=a.split:continue
        directory=DATA/e['input']
        if hashlib.sha256((directory/'manifest.json').read_bytes()).hexdigest()!=e['input_manifest_sha256']:raise ValueError('Frozen case changed: '+e['case_id'])
        files+=check_case(directory);cases+=1
        if a.command=='zip':bytes_+=pack(directory,DATA/'uploads'/e['split']/(e['case_id']+'.zip'))
    print(json.dumps({'command':a.command,'cases':cases,'files':files,'zip_bytes':bytes_,'model_calls':0}))


if __name__=='__main__':main()
