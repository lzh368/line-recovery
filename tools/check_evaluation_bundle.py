"""Verify evaluator material/input binding without printing answers or calling a model."""
import hashlib
import json
from pathlib import Path

from datasets import check_case

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / 'data/dataset'
EVALUATION = DATA / 'evaluator'
FILES = {'reference.json', 'backend-fixture.json', 'source.json'}


def digest(file):
    return hashlib.sha256(file.read_bytes()).hexdigest()


def require(condition, message):
    if not condition:
        raise ValueError(message)


def main():
    package = json.loads((EVALUATION / 'manifest.json').read_text(encoding='utf-8'))
    split_file = DATA / 'split-manifest.json'
    split = json.loads(split_file.read_text(encoding='utf-8'))
    require(digest(split_file) == package['split_manifest_sha256'], 'Split manifest changed')
    require(package['dataset_version'] == split['dataset_version'] == 'dataset', 'Dataset version mismatch')
    index = {(e['split'], e['case_id']): e for e in split['cases']}
    require(len(index) == len(split['cases']) == len(package['cases']) == 24, 'Case count mismatch')
    expected = set()
    seen = set()
    for case in package['cases']:
        key = case['split'], case['case_id']
        require(key in index and key not in seen, 'Unknown or duplicate case')
        seen.add(key)
        row = index[key]
        require(case['input'] == 'data/dataset/' + row['input'], 'Input path mismatch')
        inputs = ROOT / case['input']
        require(digest(inputs / 'manifest.json') == row['input_manifest_sha256'] == case['input_manifest_sha256'], 'Input hash mismatch')
        check_case(inputs)
        require(set(case['files']) == FILES, 'Evaluator file set mismatch')
        folder = EVALUATION / key[0] / key[1]
        for name, entry in case['files'].items():
            file = folder / name
            require(not file.is_symlink() and file.resolve().is_relative_to(EVALUATION.resolve()), 'Unsafe evaluator path')
            raw = file.read_bytes()
            require(len(raw) == entry['bytes'] and digest(file) == entry['sha256'], 'Evaluator file changed: ' + str(file.relative_to(ROOT)))
            obj = json.loads(raw)
            require(obj['case_id'] == key[1], 'Case ID mismatch')
            if name != 'backend-fixture.json':
                require(obj['split'] == key[0], 'Reference/source split mismatch')
            else:
                require(obj['execution_mode'] == 'dry_run', 'Non-demo fixture')
            if name == 'source.json':
                # Production keeps semantic source names private; the public split
                # manifest uses event-<first 12 SHA-256 hex chars of that name>.
                event_id = 'event-' + hashlib.sha256(obj['event_source_group'].encode('utf-8')).hexdigest()[:12]
                require(event_id == row['event_source_group'], 'Event source mapping mismatch')
                require(obj['image_source_group'] == row['image_source_group'], 'Image source binding mismatch')
            expected.add(file)
    actual = {p for split_name in ['optimization', 'test'] for p in (EVALUATION / split_name).rglob('*') if p.is_file()}
    require(actual == expected and len(expected) == 72, 'Extra or missing evaluator files')
    require({p.name for p in EVALUATION.iterdir()} == {'optimization', 'test', 'README.md', 'manifest.json'}, 'Unexpected evaluator root entry')
    require(sum(k[0] == 'optimization' for k in seen) == 10 and sum(k[0] == 'test' for k in seen) == 14, 'Split counts changed')
    print(json.dumps({'kind': 'evaluation_bundle_integrity_not_agent_score', 'cases': 24, 'evaluation_files': 72, 'input_files': 264, 'passed': True, 'model_calls': 0}))


if __name__ == '__main__':
    main()
