"""Strict validation for the flat public tool/state contracts; stdlib only."""
import json
import math
import re
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def loads(text):
    def pairs(items):
        obj = {}
        for key, value in items:
            if key in obj:
                raise ValueError('duplicate JSON key')
            obj[key] = value
        return obj
    def invalid(_):
        raise ValueError('non-finite JSON number')
    return json.loads(text, object_pairs_hook=pairs, parse_constant=invalid)


def read_json(path):
    return loads(Path(path).read_text(encoding='utf-8'))


def flat_validate(value, schema):
    if not isinstance(value, dict):
        raise ValueError('expected object')
    if not set(schema.get('required', [])).issubset(value):
        raise ValueError('missing required fields')
    props = schema['properties']
    if schema.get('additionalProperties') is False and set(value) - set(props):
        raise ValueError('unexpected fields')
    for key, v in value.items():
        rule = props.get(key, {})
        types = rule.get('type', [])
        if isinstance(types, str):
            types = [types]
        fits = {'null': v is None, 'boolean': type(v) is bool,
                'integer': type(v) is int,
                'number': type(v) in (int, float) and math.isfinite(v),
                'string': isinstance(v, str)}
        if types and not any(fits.get(t, False) for t in types):
            raise ValueError('invalid type: ' + key)
        if 'const' in rule and v != rule['const']:
            raise ValueError('invalid constant: ' + key)
        if 'enum' in rule and v not in rule['enum']:
            raise ValueError('invalid enum: ' + key)
        if type(v) in (int, float) and 'minimum' in rule and v < rule['minimum']:
            raise ValueError('below minimum: ' + key)
        if isinstance(v, str):
            if len(v) < rule.get('minLength', 0):
                raise ValueError('empty field: ' + key)
            if 'pattern' in rule and re.fullmatch(rule['pattern'], v) is None:
                raise ValueError('invalid pattern: ' + key)
            if rule.get('format') == 'date-time':
                if datetime.fromisoformat(v.replace('Z', '+00:00')).tzinfo is None:
                    raise ValueError('timezone required: ' + key)


STATE_SCHEMA = read_json(ROOT / 'contracts/device-state.schema.json')


def validate_state(state):
    flat_validate(state, STATE_SCHEMA)
    if state['source'] != 'demo_backend':
        raise ValueError('only demo_backend state is accepted')
    counts = [state[k] for k in ('infeed_count_total', 'outfeed_count_total', 'manual_removed_count_total')]
    if all(x is not None for x in counts) and counts[0] - counts[1] - counts[2] < 0:
        raise ValueError('negative work in progress')


def tool_definitions(service):
    if service not in ('power-control', 'cooling-control'):
        raise ValueError('unknown service')
    return read_json(ROOT / 'interfaces' / service / 'tools.json')['tools']
