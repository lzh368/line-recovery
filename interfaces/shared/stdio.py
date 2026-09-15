"""MCP 2025-06-18 stdio: newline-delimited JSON-RPC, no stdout logs."""
import json
import sys
import uuid
from .backend import Backend
from .contracts import flat_validate, loads, tool_definitions

MAX_LINE = 1024*1024


def serve(service):
    backend=Backend()
    backend.inspect()  # Fail clearly if admin has not initialized demo state.
    definitions=tool_definitions(service)
    tools={t['name']:t for t in definitions}
    client=service+':'+uuid.uuid4().hex
    initialized=False
    ready=False
    def send(message):
        sys.stdout.write(json.dumps(message,ensure_ascii=False,allow_nan=False)+'\n')
        sys.stdout.flush()
    def error(ident,code,message):
        send({'jsonrpc':'2.0','id':ident,'error':{'code':code,'message':message}})
    while True:
        raw=sys.stdin.buffer.readline(MAX_LINE+1)
        if not raw: break
        if len(raw)>MAX_LINE:
            error(None,-32700,'message exceeds limit');break
        try:message=loads(raw.decode('utf-8'))
        except (ValueError,UnicodeError):
            error(None,-32700,'invalid JSON');continue
        if not isinstance(message,dict) or message.get('jsonrpc')!='2.0' or not isinstance(message.get('method'),str):
            error(None,-32600,'invalid JSON-RPC request');continue
        method=message['method'];ident=message.get('id');params=message.get('params',{})
        if 'id' not in message:
            if method=='notifications/initialized' and initialized:ready=True
            # Write operations are never accepted as unacknowledged notifications.
            continue
        if type(ident) not in (str,int) or not isinstance(params,dict):
            error(None,-32600,'invalid id or params');continue
        if method=='initialize':
            if initialized or not isinstance(params.get('protocolVersion'),str):
                error(ident,-32602,'invalid initialization');continue
            initialized=True
            result={'protocolVersion':'2025-06-18','capabilities':{'tools':{'listChanged':False}},
                    'serverInfo':{'name':'line-recovery-'+service,'version':'0.1.0'},
                    'instructions':'Dry-run demo only. Query current state before writing; accepted is not recovery. State is shared between both services. No live adapter.'}
        elif method=='ping':result={}
        elif not ready:
            error(ident,-32002,'initialization required');continue
        elif method=='tools/list':result={'tools':definitions}
        elif method=='tools/call':
            name=params.get('name');args=params.get('arguments',{})
            if not isinstance(name,str) or name not in tools:
                error(ident,-32602,'tool not available on this service');continue
            try:
                flat_validate(args,tools[name]['inputSchema'])
                if name in ('get_device_status','get_cooling_status'):
                    value=backend.read(args['device_id'],client)
                else:value=backend.write(name,args,client)
                result={'content':[{'type':'text','text':json.dumps(value,ensure_ascii=False,allow_nan=False)}],
                        'structuredContent':value,'isError':False}
            except (ValueError,KeyError) as exc:
                value={'error':'TOOL_REJECTED','message':str(exc)}
                result={'content':[{'type':'text','text':json.dumps(value,ensure_ascii=False)}],
                        'structuredContent':value,'isError':True}
            except Exception:
                # No DB paths, environment variables, or private fixture contents in errors.
                sys.stderr.write('MCP backend request failed\n');sys.stderr.flush()
                result={'content':[{'type':'text','text':'Backend unavailable; no action confirmation.'}],'isError':True}
        else:
            error(ident,-32601,'method not found');continue
        send({'jsonrpc':'2.0','id':ident,'result':result})
