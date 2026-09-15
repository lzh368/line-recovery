"""Real stdio MCP + deterministic backend regression; never invokes a model."""
import copy
import json
import os
import select
import subprocess
import sys
import tempfile
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

INTERFACES=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(INTERFACES))
from shared.backend import Backend,validate_fixture
from shared.contracts import flat_validate,tool_definitions
from shared.profiles import profile


class Clock:
    def __init__(self):self.now=1800000000.0
    def __call__(self):return self.now
    def step(self,s):self.now+=s


class BackendTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix='lr-mcp-test-')
        self.db=Path(self.tmp.name)/'device.sqlite3';self.clock=Clock()
        self.backend=Backend(self.db,clock=self.clock)
    def tearDown(self):self.tmp.cleanup()
    def init(self,name='power-return'):
        self.backend.initialize(profile(name),time_scale=1)
    def request(self,action='resume_conveyor',client='power',key='request_0001'):
        s=self.backend.read('CV-01',client)
        return {'device_id':'CV-01','expected_revision':s['revision'],'request_id':key}
    def test_resume_requires_fresh_query(self):
        self.init();r=self.backend.write('resume_conveyor',{'device_id':'CV-01','expected_revision':200,'request_id':'request_0001'},'power')
        self.assertEqual(r['reason_code'],'NO_FRESH_READ')
    def test_resume_stages_not_instant(self):
        self.init();a=self.request();r=self.backend.write('resume_conveyor',a,'power')
        self.assertEqual(r['status'],'accepted');self.assertEqual(r['post_state']['belt_speed_m_s'],0)
        self.clock.step(4);s=self.backend.read('CV-01','power')
        self.assertEqual(s['belt_speed_m_s'],.4);self.assertEqual(s['outfeed_count_total'],1019)
        self.clock.step(7);s=self.backend.read('CV-01','power');self.assertEqual(s['outfeed_count_total'],1022)
    def test_reads_alone_do_not_resume(self):
        self.init();self.clock.step(1000)
        self.assertEqual(self.backend.read('CV-01','power')['belt_speed_m_s'],0)
    def test_repeated_reads_not_a_time_machine(self):
        self.init();a=self.request();self.backend.write('resume_conveyor',a,'power')
        for _ in range(20):self.assertEqual(self.backend.read('CV-01','power')['belt_speed_m_s'],0)
    def test_idempotency_before_revision(self):
        self.init();a=self.request();first=self.backend.write('resume_conveyor',a,'power')
        self.clock.step(20);self.backend.read('CV-01','power')
        second=self.backend.write('resume_conveyor',a,'power');self.assertEqual(first,second)
        writes=[x for x in self.backend.audit_records() if x['phase']=='write'];self.assertEqual(len(writes),1)
    def test_same_id_changed_args_conflicts(self):
        self.init();a=self.request();self.backend.write('resume_conveyor',a,'power')
        a['expected_revision']+=1
        self.assertEqual(self.backend.write('resume_conveyor',a,'power')['reason_code'],'IDEMPOTENCY_CONFLICT')
    def test_shared_database_deduplicates_two_processes(self):
        self.init();a=self.request();b=Backend(self.db,clock=self.clock)
        first=self.backend.write('resume_conveyor',a,'power')
        self.assertEqual(b.write('resume_conveyor',a,'power'),first)
    def test_concurrent_writes_only_one_accepted(self):
        self.init();a=self.request(client='a');b=self.request(client='b',key='request_0002')
        def run(pair):
            args,client=pair
            return Backend(self.db,clock=self.clock).write('resume_conveyor',args,client)['status']
        with ThreadPoolExecutor(2) as pool:results=list(pool.map(run,[(a,'a'),(b,'b')]))
        self.assertEqual(sorted(results),['accepted','rejected'])
    def test_lease_expires(self):
        self.init();a=self.request();self.clock.step(31)
        self.assertEqual(self.backend.write('resume_conveyor',a,'power')['reason_code'],'NO_FRESH_READ')
    def test_unknown_and_false_guards_block(self):
        for key,value in [('zone_clear',None),('guard_closed',False),('maintenance_lockout',True),('emergency_stop_active',True),('drive_supply_voltage_v',None)]:
            with self.subTest(key=key):
                f=profile('power-return');f['initial_state'][key]=value
                self.backend.initialize(f,reset=True,time_scale=1);a=self.request()
                self.assertEqual(self.backend.write('resume_conveyor',a,'power')['reason_code'],'PRECONDITION_FAILED')
    def test_maintenance_blocks_both_tools(self):
        self.init('maintenance')
        for i,action in enumerate(['resume_conveyor','start_cooling']):
            a=self.request(action,key='request_000'+str(i));self.assertEqual(self.backend.write(action,a,'power')['status'],'rejected')
    def test_cooling_then_resume(self):
        self.init('cooling');a=self.request();self.assertEqual(self.backend.write('resume_conveyor',a,'power')['status'],'rejected')
        a=self.request('start_cooling','cool','cooling_0001');self.backend.write('start_cooling',a,'cool')
        self.clock.step(3);s=self.backend.read('CV-01','cool')
        self.assertTrue(s['cooling_fan_running']);self.assertFalse(s['temperature_recovery_ready']);self.assertEqual(s['belt_speed_m_s'],0)
        self.clock.step(230);s=self.backend.read('CV-01','cool');self.assertFalse(s['temperature_recovery_ready'])
        self.clock.step(30);s=self.backend.read('CV-01','power');self.assertTrue(s['temperature_recovery_ready'])
        a={'device_id':'CV-01','expected_revision':s['revision'],'request_id':'resume_after_cooling'}
        self.assertEqual(self.backend.write('resume_conveyor',a,'power')['status'],'accepted')
        self.clock.step(11);self.assertEqual(self.backend.read('CV-01','power')['outfeed_count_total'],1022)
    def test_cooling_never_starts_conveyor(self):
        self.init('cooling');a=self.request('start_cooling','cool');self.backend.write('start_cooling',a,'cool')
        self.clock.step(600);s=self.backend.read('CV-01','power');self.assertEqual(s['belt_speed_m_s'],0)
    def test_fan_failure_no_success(self):
        self.init('fan-failure');a=self.request('start_cooling','cool');self.backend.write('start_cooling',a,'cool')
        self.clock.step(6);s=self.backend.read('CV-01','cool');self.assertFalse(s['cooling_fan_running']);self.assertTrue(s['cooling_fan_fault'])
    def test_already_running_no_new_effect(self):
        self.init();a=self.request();self.backend.write('resume_conveyor',a,'power');self.clock.step(11)
        a=self.request(key='request_0002');r=self.backend.write('resume_conveyor',a,'power')
        self.assertEqual(r['status'],'already_satisfied');self.assertEqual(r['post_state']['outfeed_count_total'],1022)
    def test_epoch_reset_rejects_old_client(self):
        self.init();a=self.request();self.backend.initialize(profile('power-return'),reset=True,time_scale=1)
        self.assertGreater(self.backend.read('CV-01','b')['revision'],a['expected_revision'])
        self.assertEqual(self.backend.write('resume_conveyor',a,'power')['status'],'rejected')
        self.assertIn('archive_before_reset',[x['phase'] for x in self.backend.audit_records()])
    def test_foreign_device_blocked(self):
        self.init()
        with self.assertRaises(ValueError):self.backend.read('CV-02','power')
    def test_live_mode_refused(self):
        with patch.dict(os.environ,{'LINE_RECOVERY_MODE':'live'}):
            with self.assertRaises(ValueError):Backend(self.db)
    def test_uploaded_state_not_accepted_as_fixture(self):
        f=profile('power-return');f['initial_state']['source']='uploaded_snapshot'
        with self.assertRaises(ValueError):self.backend.initialize(f)
    def test_initialization_does_not_overwrite(self):
        self.init()
        with self.assertRaises(ValueError):self.backend.initialize(profile('cooling'))
        self.assertEqual(self.backend.inspect()['state']['cabinet_temperature_c'],35)
    def test_clock_rollback_fails_closed(self):
        self.init();self.backend.read('CV-01','power');self.clock.step(-1)
        with self.assertRaises(ValueError):self.backend.read('CV-01','power')
    def test_tampered_cooling_timer_rejected(self):
        f=profile('cooling');f['cooling_readback_1hz'][0]['temperature_recovery_ready']=True
        with self.assertRaises(ValueError):validate_fixture(f)


class Peer:
    def __init__(self,service,db):
        env={**os.environ,'LINE_RECOVERY_STATE_DB':str(db),'LINE_RECOVERY_MODE':'dry_run'}
        self.p=subprocess.Popen([sys.executable,str(INTERFACES/service/'server.py')],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,bufsize=1,env=env,cwd=db.parent)
        self.i=0
    def receive(self):
        ready,_,_=select.select([self.p.stdout],[],[],5)
        if not ready:raise TimeoutError('stdio response timeout')
        line=self.p.stdout.readline()
        if not line:raise RuntimeError('stdio ended: '+self.p.stderr.read())
        return json.loads(line)
    def send(self,obj):self.p.stdin.write(json.dumps(obj)+'\n');self.p.stdin.flush()
    def request(self,method,params=None):
        self.i+=1;self.send({'jsonrpc':'2.0','id':self.i,'method':method,'params':params or {}})
        r=self.receive();assert r['id']==self.i;return r
    def start(self):
        r=self.request('initialize',{'protocolVersion':'2025-06-18','capabilities':{},'clientInfo':{'name':'test','version':'1'}})
        assert r['result']['protocolVersion']=='2025-06-18'
        self.send({'jsonrpc':'2.0','method':'notifications/initialized'});return self
    def call(self,name,args):return self.request('tools/call',{'name':name,'arguments':args})
    def close(self):
        self.p.stdin.close()
        try:self.p.wait(timeout=2)
        except subprocess.TimeoutExpired:self.p.kill();self.p.wait()
        self.p.stdout.close();self.p.stderr.close()


class StdioTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix='lr-mcp-wire-');self.db=Path(self.tmp.name)/'state.sqlite3'
        Backend(self.db).initialize(profile('power-return'));self.peers=[]
    def tearDown(self):
        for p in self.peers:p.close()
        self.tmp.cleanup()
    def peer(self,service):
        p=Peer(service,self.db);self.peers.append(p);return p
    def test_real_lifecycle_and_tools(self):
        for service in ['power-control','cooling-control']:
            p=self.peer(service).start();r=p.request('tools/list')
            self.assertEqual(r['result']['tools'],tool_definitions(service));self.assertEqual(p.request('ping')['result'],{})
    def test_requires_initialization(self):
        p=self.peer('power-control');self.assertIn('error',p.request('tools/list'))
    def test_shared_state_readback_over_wire(self):
        p=self.peer('power-control').start();c=self.peer('cooling-control').start()
        a=p.call('get_device_status',{'device_id':'CV-01'})['result']['structuredContent']
        b=c.call('get_cooling_status',{'device_id':'CV-01'})['result']['structuredContent']
        self.assertEqual(a['revision'],b['revision']);self.assertEqual(a['outfeed_count_total'],b['outfeed_count_total'])
    def test_rejects_extra_authorization_and_invalid_revision(self):
        p=self.peer('power-control').start()
        for args in [{'device_id':'CV-01','approved':True},{'device_id':'CV-01','expected_revision':True,'request_id':'abcdefgh'}]:
            tool='get_device_status' if 'approved' in args else 'resume_conveyor'
            self.assertTrue(p.call(tool,args)['result']['isError'])
    def test_cross_service_write_not_exposed(self):
        p=self.peer('cooling-control').start()
        self.assertIn('error',p.call('resume_conveyor',{}))
        self.assertIn('error',p.call([],{}))
        self.assertEqual(p.request('ping')['result'],{})
    def test_parse_error_does_not_poison_connection(self):
        p=self.peer('power-control').start();p.p.stdin.write('{oops}\n');p.p.stdin.flush()
        self.assertEqual(p.receive()['error']['code'],-32700);self.assertEqual(p.request('ping')['result'],{})
    def test_duplicate_keys_and_nan_rejected(self):
        p=self.peer('power-control').start()
        for text in ['{"jsonrpc":"2.0","jsonrpc":"2.0","id":4,"method":"ping"}', '{"id":NaN}']:
            p.p.stdin.write(text+'\n');p.p.stdin.flush();self.assertEqual(p.receive()['error']['code'],-32700)
    def test_write_notification_is_not_executed(self):
        p=self.peer('power-control').start();s=p.call('get_device_status',{'device_id':'CV-01'})['result']['structuredContent']
        p.send({'jsonrpc':'2.0','method':'tools/call','params':{'name':'resume_conveyor','arguments':{'device_id':'CV-01','expected_revision':s['revision'],'request_id':'ignored_notification'}}})
        self.assertEqual(p.request('ping')['result'],{})
        self.assertFalse(any(x['phase']=='write' for x in Backend(self.db).audit_records()))

if __name__=='__main__':unittest.main(verbosity=2)
