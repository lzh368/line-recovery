"""Operator-only fixture compatibility check; reads private references, never runs an Agent.

Supply an explicit private fixture root. Do not expose that directory to the Agent.
This verifies the backend against authored feedback, not Agent action selection.
"""
import argparse
import json
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'interfaces'))
from shared.backend import Backend, IGNORED
from shared.contracts import read_json, validate_state


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--fixtures', type=Path, required=True)
    args = parser.parse_args()
    fixtures = sorted(args.fixtures.glob('*/*/backend-fixture.json'))
    if not fixtures:
        raise SystemExit('No fixtures found: expected split/case/backend-fixture.json')
    results = []
    for source in fixtures:
        fixture = read_json(source)
        reference = read_json(source.with_name('reference.json'))
        now = [1_800_000_000.0]
        with tempfile.TemporaryDirectory(prefix='lr-fixture-check-') as temp:
            backend = Backend(Path(temp) / 'state.sqlite3', clock=lambda: now[0])
            backend.initialize(fixture, time_scale=1)
            device = fixture['initial_state']['device_id']
            responses = []
            for i, action in enumerate(reference['action_policy']['ordered_write_actions']):
                client = 'power' if action == 'resume_conveyor' else 'cooling'
                # The fixture harness supplies the reference action, not a target Agent.
                for _ in range(601):
                    state = backend.read(device, client)
                    validate_state(state)
                    if not backend.blockers(state, action):
                        break
                    now[0] += 1
                else:
                    raise AssertionError(f'{source.parent.name}: action never permitted: {action}')
                result = backend.write(action, {
                    'device_id': device, 'expected_revision': state['revision'],
                    'request_id': f'fixture-check-{i:04d}',
                }, client)
                validate_state(result['post_state'])
                assert result['execution_mode'] == 'dry_run'
                if result['status'] == 'rejected':
                    assert reference['action_policy']['allowed_benign_rejection'], source.parent.name
                    assert result['reason_code'] == 'REVISION_CONFLICT', source.parent.name
                else:
                    assert result['status'] == 'accepted', source.parent.name
                responses.append(result['status'])
            now[0] += 600
            final = backend.read(device, 'fixture-check-final')
            validate_state(final)
            expected = reference['final_backend_state']
            differences = [key for key in expected if key not in IGNORED and final[key] != expected[key]]
            assert not differences, f'{source.parent.name}: final-state mismatch: {differences}'
            results.append({'case': source.parent.name, 'passed': True, 'write_responses': responses})
    print(json.dumps({'kind': 'backend_fixture_compatibility_not_agent_score',
                      'cases': len(results), 'passed': len(results),
                      'model_calls': 0, 'live_device_calls': 0, 'results': results}, ensure_ascii=False))


if __name__ == '__main__':
    main()
