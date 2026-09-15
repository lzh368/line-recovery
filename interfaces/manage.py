#!/usr/bin/env python3
"""Operator-only initialization/fixture loading. Never exposed as an MCP tool."""
import argparse
import json
from pathlib import Path
from shared.backend import Backend
from shared.contracts import read_json
from shared.profiles import profile


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--db',type=Path,help='isolated SQLite file; default interfaces/runtime/demo.sqlite3')
    sub=p.add_subparsers(dest='command',required=True)
    for command in ('init','reset'):
        s=sub.add_parser(command)
        g=s.add_mutually_exclusive_group(required=True)
        g.add_argument('--profile',choices=['power-return','cooling','maintenance','fan-failure'])
        g.add_argument('--fixture',type=Path,help='trusted backend-fixture.json outside Agent workspace; never a user upload')
        s.add_argument('--time-scale',type=float,default=20,help='demo elapsed seconds per wall-clock second; (0,100], default20')
    sub.add_parser('status')
    audit=sub.add_parser('audit');audit.add_argument('--output',type=Path,help='new JSON file; may contain private states')
    a=p.parse_args();backend=Backend(a.db)
    if a.command in ('init','reset'):
        fixture=read_json(a.fixture) if a.fixture else profile(a.profile)
        run=backend.initialize(fixture,time_scale=a.time_scale,reset=a.command=='reset')
        result={'run_id':run,'execution_mode':'dry_run','database':str(backend.path),'time_scale':a.time_scale,
                'note':'Previous state and audit are retained on reset. Only one case per database.'}
    elif a.command=='status':
        # A status display is a genuine readback, advancing elapsed demo time.
        info=backend.inspect();backend.read(info['state']['device_id'],'operator-status');result=backend.inspect()
    else:
        result=backend.audit_records()
        if a.output:
            a.output.parent.mkdir(parents=True,exist_ok=True)
            with a.output.open('x',encoding='utf-8') as f:json.dump(result,f,ensure_ascii=False,indent=2)
            result={'records':len(result),'output':str(a.output)}
    print(json.dumps(result,ensure_ascii=False,indent=2))


if __name__=='__main__':
    try:main()
    except (ValueError,OSError) as exc:
        raise SystemExit(str(exc))
