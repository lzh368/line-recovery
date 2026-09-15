"""Transactional, elapsed-time-driven demo state. No network or device I/O."""
import copy
import json
import math
import os
import sqlite3
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

from .contracts import ROOT, validate_state

DEFAULT_DB = ROOT / 'interfaces/runtime/demo.sqlite3'
ACTIONS = ('resume_conveyor', 'start_cooling')
IGNORED = {'captured_at', 'expires_at', 'revision'}


def iso(now):
    return datetime.fromtimestamp(now, timezone.utc).isoformat()


def validate_fixture(fixture):
    if fixture.get('execution_mode') != 'dry_run' or fixture.get('kind') != 'authored_test_fixture_not_execution':
        raise ValueError('only an explicitly authored dry_run fixture may be loaded')
    validate_state(fixture['initial_state'])
    steps = fixture.get('steps', [])
    if not isinstance(steps, list) or len(steps)>1000:
        raise ValueError('invalid fixture steps')
    for step in steps:
        validate_state(step['state'])
        if step['state']['device_id'] != fixture['initial_state']['device_id']:
            raise ValueError('fixture device mismatch')
        if step.get('trigger') not in ('after_action', 'elapsed_without_action', 'before_first_resume_write'):
            raise ValueError('unknown fixture trigger')
        if step['trigger'] in ('after_action','before_first_resume_write') and step.get('action') not in ACTIONS:
            raise ValueError('unknown fixture action')
        if step['trigger'] != 'before_first_resume_write':
            delay = step.get('after_s')
            if type(delay) not in (int,float) or not math.isfinite(delay) or not 0 <= delay <= 86400:
                raise ValueError('invalid fixture delay')
    curve = fixture.get('cooling_readback_1hz', [])
    if not isinstance(curve, list) or len(curve)>86400:
        raise ValueError('invalid thermal curve')
    since = None
    for i, row in enumerate(curve, 1):
        if row['elapsed_after_start_cooling_s'] != i or type(row['valid']) is not bool:
            raise ValueError('thermal curve must be 1 Hz')
        temp = row['cabinet_temperature_c']
        if row['valid'] and (type(temp) not in (float,int) or not math.isfinite(temp)):
            raise ValueError('invalid temperature')
        since = (i if since is None else since) if row['valid'] and temp<=45 else None
        if row['temperature_recovery_ready'] is not (since is not None and i-since>=30):
            raise ValueError('thermal hold condition disagrees with 30-second rule')


class Backend:
    def __init__(self, database=None, clock=time.time):
        self.path = Path(database or os.environ.get('LINE_RECOVERY_STATE_DB', DEFAULT_DB)).absolute()
        self.clock = clock
        if os.environ.get('LINE_RECOVERY_MODE', 'dry_run') != 'dry_run':
            raise ValueError('live mode is not implemented; refusing to start')

    @contextmanager
    def transaction(self, create=False):
        if not create and not self.path.is_file():
            raise ValueError('demo state not initialized; run interfaces/manage.py init')
        if self.path.is_symlink():
            raise ValueError('state database must not be a symlink')
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        if create:
            try:
                fd=os.open(self.path,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
                os.close(fd)
            except FileExistsError:
                pass
        con = sqlite3.connect(str(self.path), timeout=5, isolation_level=None)
        try:
            con.execute('PRAGMA busy_timeout=5000')
            con.execute('BEGIN IMMEDIATE')
            yield con
            con.commit()
        except BaseException:
            con.rollback()
            raise
        finally:
            con.close()

    def initialize(self, fixture, time_scale=20, reset=False):
        validate_fixture(fixture)
        if type(time_scale) not in (int,float) or not math.isfinite(time_scale) or not 0 < time_scale <=100:
            raise ValueError('time_scale must be in (0,100]')
        now = self.clock()
        with self.transaction(create=True) as con:
            con.execute('CREATE TABLE IF NOT EXISTS device (id INTEGER PRIMARY KEY CHECK(id=1), doc TEXT NOT NULL)')
            con.execute('CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, run_id TEXT, body TEXT NOT NULL)')
            old = con.execute('SELECT doc FROM device WHERE id=1').fetchone()
            if old and not reset:
                raise ValueError('state already exists; use explicit reset (history is retained)')
            if old:
                archived=json.loads(old[0])
                self.audit(con,archived,'archive_before_reset',{'document':archived})
            doc = {'run_id':uuid.uuid4().hex, 'state':copy.deepcopy(fixture['initial_state']),
                   'fixture':fixture, 'elapsed':0.0, 'last_real':now, 'time_scale':time_scale,
                   'leases':{}, 'operations':{}, 'origins':{}, 'applied':[]}
            # Never reuse a pre-reset version: old clients must not execute in the new run.
            previous = json.loads(old[0])['state']['revision'] if old else 0
            doc['state']['revision'] = max(previous+1, doc['state']['revision'])
            self.save(con,doc)
            self.audit(con,doc,'initialize',{'time_scale':time_scale,'reset':bool(old)})
        os.chmod(self.path,0o600)
        return doc['run_id']

    def load(self,con):
        row = con.execute('SELECT doc FROM device WHERE id=1').fetchone()
        if not row: raise ValueError('demo state is empty')
        return json.loads(row[0])

    def save(self,con,doc):
        con.execute('INSERT OR REPLACE INTO device(id,doc) VALUES(1,?)', (json.dumps(doc,ensure_ascii=False,allow_nan=False),))

    def audit(self,con,doc,phase,detail):
        body = {'at':iso(self.clock()),'elapsed_demo_s':round(doc['elapsed'],3),'phase':phase,
                'execution_mode':'dry_run','device_id':doc['state']['device_id'],**detail}
        con.execute('INSERT INTO audit(run_id,body) VALUES(?,?)',(doc['run_id'],json.dumps(body,ensure_ascii=False,allow_nan=False)))

    def replace_state(self,doc,state):
        update = {k:v for k,v in state.items() if k not in IGNORED}
        if any(doc['state'].get(k)!=v for k,v in update.items()):
            doc['state'].update(update)
            doc['state']['revision'] += 1

    def advance(self,con,doc,now):
        if now < doc['last_real']:
            raise ValueError('backend clock moved backwards; refusing actions')
        doc['elapsed'] += (now-doc['last_real'])*doc['time_scale']
        doc['last_real'] = now
        due = []
        for i,step in enumerate(doc['fixture'].get('steps',[])):
            if i in doc['applied']: continue
            trigger = step['trigger']
            if trigger == 'elapsed_without_action': at=step['after_s']
            elif trigger == 'after_action' and step['action'] in doc['origins']:
                at=doc['origins'][step['action']]['at']+step['after_s']
            else: continue
            if at <= doc['elapsed']: due.append((at,i,step))
        for at,i,step in sorted(due):
            self.replace_state(doc,step['state'])
            doc['applied'].append(i)
            self.audit(con,doc,'feedback',{'step':i,'due_demo_s':at,'status':step.get('status'),
                                         'state':self.snapshot(doc,now)})
        curve=doc['fixture'].get('cooling_readback_1hz',[])
        if curve and 'start_cooling' in doc['origins']:
            elapsed=int(doc['elapsed']-doc['origins']['start_cooling']['at'])
            if elapsed>=1:
                row=curve[min(elapsed,len(curve))-1]
                updates={'cabinet_temperature_c':row['cabinet_temperature_c'] if row['valid'] else None}
                # Readback data cannot remove another outstanding blocker.
                if not row['temperature_recovery_ready']:
                    updates.update(temperature_recovery_ready=False,thermal_pause_active=True,run_resume_permitted=False)
                self.replace_state(doc,updates)

    def snapshot(self,doc,now):
        return {**doc['state'],'source':'demo_backend','captured_at':iso(now),'expires_at':iso(now+30)}

    def read(self,device_id,client):
        with self.transaction() as con:
            now=self.clock()
            doc=self.load(con)
            if device_id!=doc['state']['device_id']:raise ValueError('device not allowlisted')
            self.advance(con,doc,now)
            doc['leases']={k:v for k,v in doc['leases'].items() if now-v['at']<=30}
            doc['leases'][client]={'at':now,'revision':doc['state']['revision']}
            state=self.snapshot(doc,now)
            self.audit(con,doc,'read',{'client':client,'state':state})
            self.save(con,doc)
            return state

    def blockers(self,state,action):
        expected={'controller_online':True,'upstream_power_available':True,
                  'emergency_stop_active':False,'maintenance_lockout':False,'guard_closed':True,'zone_clear':True}
        if action=='resume_conveyor':
            expected.update(drive_power_enabled=True,drive_ready=True,production_requested=True,
                            run_resume_permitted=True,downstream_ready=True,unresolved_accumulation=False,
                            thermal_pause_active=False,temperature_recovery_ready=True)
        else:
            expected.update(cooling_control_permitted=True,cooling_fan_fault=False)
        failures=[k for k,v in expected.items() if state.get(k) is not v]
        if action=='resume_conveyor':
            if state.get('operating_mode')!='AUTO':failures.append('operating_mode')
            v=state.get('drive_supply_voltage_v')
            if type(v) not in (int,float) or not 22.8<=v<=25.2:failures.append('drive_supply_voltage_v')
        return failures

    def write(self,action,args,client):
        with self.transaction() as con:
            now=self.clock()
            doc=self.load(con)
            if action not in ACTIONS: raise ValueError('action not allowlisted')
            if args['device_id']!=doc['state']['device_id']:raise ValueError('device not allowlisted')
            fingerprint=json.dumps({'action':action,**args},sort_keys=True)
            key=args['request_id'];old=doc['operations'].get(key)
            # Idempotency is deliberately before state advancement and revision checks.
            if old and old['fingerprint']==fingerprint:
                self.audit(con,doc,'idempotent_replay',{'request_id':key,'action':action})
                return old['response']
            self.advance(con,doc,now)
            def finish(status,reason,message,remember=True):
                response={'schema_version':'0.1','operation_id':'op_'+uuid.uuid4().hex,'request_id':key,
                          'device_id':args['device_id'],'action':action,'execution_mode':'dry_run',
                          'status':status,'reason_code':reason,'message':message,
                          'started_at':iso(now),'finished_at':None if status=='accepted' else iso(now),
                          'post_state':self.snapshot(doc,now)}
                if remember:doc['operations'][key]={'fingerprint':fingerprint,'response':response}
                self.audit(con,doc,'write',{'client':client,'action':action,'request':args,'result':response})
                self.save(con,doc)
                return response
            if old:
                return finish('rejected','IDEMPOTENCY_CONFLICT','同一请求号不能用于不同动作或参数。',False)
            # Explicit fixture race occurs at the atomic execution point, never a hidden success shortcut.
            if action=='resume_conveyor':
                for i,step in enumerate(doc['fixture'].get('steps',[])):
                    if step['trigger']=='before_first_resume_write' and i not in doc['applied']:
                        self.replace_state(doc,step['state']);doc['applied'].append(i)
                        self.audit(con,doc,'execution_race',{'state':self.snapshot(doc,now)})
            lease=doc['leases'].get(client)
            if not lease or now-lease['at']>30:
                return finish('rejected','NO_FRESH_READ','执行前必须经本服务重新查询可信状态。')
            if lease['revision']!=args['expected_revision'] or args['expected_revision']!=doc['state']['revision']:
                return finish('rejected','REVISION_CONFLICT','设备状态已变化，请重新查询；没有执行动作。')
            blocked=self.blockers(doc['state'],action)
            if blocked:
                return finish('rejected','PRECONDITION_FAILED','前置条件未满足：'+','.join(blocked))
            s=doc['state']
            if action=='resume_conveyor' and s['run_command'] is True and type(s['belt_speed_m_s']) in (int,float) and s['belt_speed_m_s']>.02:
                return finish('already_satisfied','ALREADY_RUNNING','已有运动反馈，未重复启动。')
            if action=='start_cooling' and s['cooling_fan_running'] is True:
                return finish('already_satisfied','FAN_ALREADY_RUNNING','风机已运行，未重复开启。')
            if action in doc['origins']:
                return finish('rejected','OPERATION_IN_PROGRESS','本次演示已有该动作；请查询反馈，不要换请求号重发。')
            if not any(x['trigger']=='after_action' and x['action']==action for x in doc['fixture'].get('steps',[])):
                return finish('rejected','ACTION_NOT_AVAILABLE','当前演示后端没有该动作的执行反馈，未执行。')
            doc['origins'][action]={'at':doc['elapsed'],'request_id':key}
            doc['state']['revision']+=1
            return finish('accepted','COMMAND_ACCEPTED','演示控制请求已受理；实际运行、温度及产出须查询后续反馈。')

    def inspect(self):
        with self.transaction() as con:
            doc=self.load(con)
            return {'run_id':doc['run_id'],'execution_mode':'dry_run','time_scale':doc['time_scale'],
                    'elapsed_demo_s':doc['elapsed'],'state':self.snapshot(doc,self.clock()),
                    'audit_rows':con.execute('SELECT count(*) FROM audit WHERE run_id=?',(doc['run_id'],)).fetchone()[0]}

    def audit_records(self):
        with self.transaction() as con:
            return [{'run_id':run,**json.loads(body)} for run,body in con.execute('SELECT run_id,body FROM audit ORDER BY id')]
