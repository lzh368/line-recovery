#!/usr/bin/env python3
"""Run the cooling-control MCP stdio service."""
import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from shared.stdio import serve

if __name__=='__main__':
    try:serve('cooling-control')
    except (ValueError,OSError) as exc:
        print(str(exc),file=sys.stderr);sys.exit(1)
