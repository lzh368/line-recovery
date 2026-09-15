"""Check/rebuild the seven supplemental test cases; no Agent or network calls."""
import argparse
import csv
import hashlib
import json
import struct
import sys
import zipfile
from collections import Counter, defaultdict
from datetime import datetime, timedelta
from pathlib import Path

from datasets import check_case, pack
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'interfaces'))
from shared.backend import validate_fixture


def read(p): return json.loads(p.read_text(encoding='utf-8'))
def sha(p): return hashlib.sha256(p.read_bytes()).hexdigest()


def check(data):
    manifest=read(data/'split-manifest.json'); package=read(data/'evaluator/manifest.json')
    assert manifest['dataset_version']==package['dataset_version']=='dataset'
    assert sha(data/'split-manifest.json')==package['split_manifest_sha256']
    entries=[e for e in manifest['cases'] if e['source_dataset']=='dataset-v0.2'];assert len(entries)==7
    assert {e['case_id'] for e in entries}=={f'lr_{n}' for n in range(301,308)}
    assert {e['split'] for e in entries}=={'test'}
    old=[e for e in manifest['cases'] if e['source_dataset']=='dataset-v0.1']
    old_images={e['image_sha256'] for e in old}|{sha(ROOT/'examples/input/images/frame_001.png')}
    old_events={e['event_source_group'] for e in old}
    files=0;images=set();summary=[];pairs={e['case_id']:e for e in package['cases'] if e['source_dataset']=='dataset-v0.2'}
    assert set(pairs)=={e['case_id'] for e in entries} and len(pairs)==7
    for e in entries:
        d=data/e['input']; case=e['case_id'];p=data/'evaluator/test'/case
        assert e['input']=='test/'+case and not d.is_symlink()
        files+=check_case(d)
        assert len(list(x for x in d.rglob('*') if x.is_file()))==11
        assert sha(d/'manifest.json')==e['input_manifest_sha256']==pairs[case]['input_manifest_sha256']
        assert pairs[case]['input']=='data/dataset/'+e['input']
        assert set(pairs[case]['files'])=={'reference.json','backend-fixture.json','source.json'}
        for name,info in pairs[case]['files'].items():
            assert sha(p/name)==info['sha256'] and (p/name).stat().st_size==info['bytes']
            assert read(p/name)['case_id']==case
        source=read(p/'source.json');truth=read(p/'reference.json');fixture=read(p/'backend-fixture.json')
        assert 'event-'+hashlib.sha256(source['event_source_group'].encode()).hexdigest()[:12]==e['event_source_group']
        assert e['event_source_group'] not in old_events and source['source_case_ids']==[]
        assert source['image_source_group']==e['image_source_group']
        validate_fixture(fixture)
        req=read(d/'request.json');state=read(d/'device_state.json');dev=read(d/'device.json')
        assert req['dataset_version']=='dataset-v0.2' and req['case_id']==case
        assert req['synthetic'] and state['source']=='uploaded_snapshot'
        assert req['device_id']==state['device_id']==fixture['initial_state']['device_id']==dev['device_id']
        with (d/'telemetry.csv').open(newline='') as f:
            reader=csv.DictReader(f);rows=list(reader);keys=reader.fieldnames
        assert keys==[f['name'] for f in read(d/'data_dictionary.json')['fields']]
        assert len(rows)==121
        start=datetime.fromisoformat(req['window_start'])
        assert start+timedelta(seconds=120)==datetime.fromisoformat(req['window_end'])
        missing=False; previous=None;stable=None
        for i,r in enumerate(rows):
            assert r['timestamp']==(start+timedelta(seconds=i)).isoformat()
            n=lambda k: None if r[k]=='' else float(r[k])
            missing=missing or any(v=='' for v in r.values())
            counters=[n(k) for k in ['infeed_count_total','outfeed_count_total','manual_removed_count_total']]
            if all(v is not None for v in counters):
                assert 0<=counters[0]-counters[1]-counters[2]<=6,(case,i,'material balance')
                if previous and previous[0]==i-1:
                    assert all(0<=v-pv<=1 for v,pv in zip(counters,previous[1]))
                    if n('infeed_enabled')==0: assert counters[0]==previous[1][0]
                    if n('belt_speed_m_s')==0: assert counters[1]==previous[1][1]
                previous=(i,counters)
            if n('run_command')==1:
                assert n('drive_ready')==1 and n('drive_power_enabled')==1
                assert n('thermal_pause_active')==0
            if n('drive_power_enabled')==0:
                assert n('drive_supply_voltage_v')<=1 and n('run_command')==0
            temp=n('cabinet_temperature_c')
            stable=(i if stable is None else stable) if temp is not None and temp<=45 else None
            if n('thermal_pause_active')==1:
                assert n('run_command')==0 and n('temperature_recovery_ready')==0
                assert stable is None or i-stable<30
        assert req['collection']['telemetry_complete']==(not missing)
        assert bool(req['collection']['missing_fields'])==missing
        for k,v in state.items():
            if k not in rows[-1]:continue
            cell=rows[-1][k]
            expected=('UNKNOWN' if k=='operating_mode' else None) if cell=='' else cell if k=='operating_mode' else float(cell)
            assert v==expected,(case,'snapshot',k)
        events=[json.loads(line) for line in (d/'events.jsonl').read_text().splitlines()]
        assert len(events)==len({x['event_id'] for x in events})==14
        assert [e['timestamp'] for e in events]==sorted(e['timestamp'] for e in events)
        for event in events:
            i=int((datetime.fromisoformat(event['timestamp'])-start).total_seconds());assert 0<=i<=120
            r=rows[i]
            if '该时点采集值：' in event['message']:
                for k,v in json.loads(event['message'].split('：',1)[1]).items():assert str(v)==r[k]
            if event['code'] in ('SUPPLY_VALID_FALL','BRANCH_ISOLATED'):assert float(r['drive_supply_voltage_v'])<=1
            if event['code']=='DRIVE_READY':assert r['drive_ready']=='1'
            if event['code']=='SPEED_ZERO':assert float(r['belt_speed_m_s'])<=.02
            if event['code']=='THERMAL_HOLD':assert float(r['cabinet_temperature_c'])>=60 and r['thermal_pause_active']=='1'
            if event['code']=='LOCAL_START_AUTHORIZED':assert r['run_command']=='1'
        for evidence in truth['diagnosis_evidence']:
            assert evidence['file']=='events.jsonl'
            assert any(x['event_id']==evidence['locator'] and x['message']==evidence['observation'] for x in events)
        frames=read(d/'images.json')['frames'];assert len(frames)==1
        raw=(d/frames[0]['file']).read_bytes();assert raw[:8]==b'\x89PNG\r\n\x1a\n'
        assert min(struct.unpack('>II',raw[16:24]))>=768
        imagehash=sha(d/frames[0]['file']);assert imagehash==e['image_sha256'] and imagehash not in old_images
        images.add(imagehash)
        i=int((datetime.fromisoformat(frames[0]['timestamp'])-start).total_seconds())
        assert int(rows[i]['infeed_count_total'])-int(rows[i]['outfeed_count_total'])-int(rows[i]['manual_removed_count_total'])==3
        with zipfile.ZipFile(data/'uploads/test'/f'{case}.zip') as z:
            assert z.testzip() is None
            assert set(z.namelist())=={x.relative_to(d).as_posix() for x in d.rglob('*') if x.is_file()}
            for name in z.namelist():assert z.read(name)==(d/name).read_bytes()
        summary.append(dict(window=truth['diagnosis']['window_status'],image=e['image_source_group'],
            logs=14,images=1,files=11,events_complete=req['collection']['events_complete'],telemetry_complete=req['collection']['telemetry_complete']))
    shortcuts={}
    for key in ('logs','images','files','image','events_complete','telemetry_complete'):
        buckets=defaultdict(Counter)
        for s in summary:buckets[str(s[key])][s['window']]+=1
        hits=sum(max(c.values()) for c in buckets.values());assert hits<7
        shortcuts[key]=dict(in_sample_lookup_hits=hits,total=7,perfect_mapping=False)
    assert len(images)==2 and files==77
    return dict(kind='data_integrity_not_agent_score',cases=7,input_files=files,evaluator_files=21,rows=847,
        events=98,new_base_images=len(images),upload_zips=7,passed=True,agent_runs=0,shortcut_diagnostics=shortcuts)


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('command',choices=['check','zip']);p.add_argument('--data',type=Path,default=ROOT/'data/dataset');a=p.parse_args()
    if a.command=='zip':
        for e in read(a.data/'split-manifest.json')['cases']:
            if e['source_dataset']!='dataset-v0.2':continue
            pack(a.data/e['input'],a.data/'uploads/test'/f"{e['case_id']}.zip")
    print(json.dumps(check(a.data),ensure_ascii=False,indent=2))
