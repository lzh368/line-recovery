/** Real HTTP + existing Penguin-generated MCP client. No diagnosis/model calls. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { setTimeout as pause } from 'node:timers/promises';

const repo=path.resolve(import.meta.dirname,'../..');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'lr-mcp-app-'));
const database=path.join(temporary,'device.sqlite3');
process.env.LINE_RECOVERY_STATE_DB=database;
process.env.LR_RUNTIME_DIR=path.join(temporary,'runtime');
process.env.LR_DATA_ROOT=path.join(temporary,'agent');
process.env.LR_INTERFACES_CONFIG=path.join(repo,'app/config/interfaces.json');
process.env.DEEPSEEK_API_KEY='';
process.env.OPENROUTER_API_KEY='';
// Deliberately launch from repository root to test cwd-independent config resolution.
process.chdir(repo);
const manage=(command:string,profile:string)=>execFileSync('python3',[
  path.join(repo,'interfaces/manage.py'),'--db',database,command,'--profile',profile,'--time-scale','100',
],{stdio:'pipe',env:{...process.env,LINE_RECOVERY_MODE:'dry_run'}});
manage('init','power-return');
const {createServer}=await import('../src/server.ts');
const registry=await import('../src/tools/registry.ts');
const {validate}=await import('../src/case/contracts.ts');
const server=createServer();
await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
const address=server.address();
assert(address && typeof address==='object');
const base=`http://127.0.0.1:${address.port}`;
let checks=0;
function check(ok:unknown,message:string){checks++;assert(ok,message);}
async function post(url:string,body?:unknown){
  const r=await fetch(base+url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body??{})});
  const json=await r.json() as any;check(r.ok,url+': '+JSON.stringify(json));return json;
}
async function connect(){
  for(const id of ['power-control','cooling-control']){
    await post(`/api/tools/${id}/connect`);
    check(registry.isConnected(id as any),id+' connected');
  }
}
async function waitFor(tool:'get_device_status'|'get_cooling_status',predicate:(s:any)=>boolean,timeoutMs=5000){
  const until=Date.now()+timeoutMs;
  while(Date.now()<until){
    const state=await registry.callTool(tool==='get_device_status'?'power-control':'cooling-control',tool,{device_id:'CV-01'}) as any;
    check(validate('device-state.schema.json',state).valid,'status Schema');
    check(state.source==='demo_backend','demo source');
    if(predicate(state))return state;
    await pause(40);
  }
  throw new Error('feedback timeout');
}
try{
  await connect();
  await post('/api/cases/load-example');
  const before=await registry.callTool('power-control','get_device_status',{device_id:'CV-01'}) as any;
  const run=await post('/api/cases/lr_001/recovery',{action:'resume_conveyor'});
  check(run.outcome.attempted,'resume attempted through app backend');
  check(run.outcome.operations[0].status==='accepted','not instantaneous confirmation');
  check(validate('action-result.schema.json',run.outcome.operations[0]).valid,'action result Schema');
  const after=await waitFor('get_device_status',s=>s.outfeed_count_total>before.outfeed_count_total);
  check(after.belt_speed_m_s>.02,'conveyor running');
  const shared=await registry.callTool('cooling-control','get_cooling_status',{device_id:'CV-01'}) as any;
  check(shared.outfeed_count_total===after.outfeed_count_total,'two services share state');
  await registry.disconnectAll();manage('reset','cooling');await connect();
  // Protocol/adapter smoke only. No claim that the example input is a thermal case.
  const cool=await post('/api/cases/lr_001/recovery',{action:'start_cooling'});
  check(cool.outcome.attempted,'cooling attempted through app backend');
  check(cool.outcome.operations[0].status==='accepted','fan request accepted only');
  check(validate('action-result.schema.json',cool.outcome.operations[0]).valid,'cooling action Schema');
  const cooled=await waitFor('get_cooling_status',s=>s.temperature_recovery_ready===true);
  check(cooled.cooling_fan_running===true && cooled.belt_speed_m_s===0,'cooling does not start conveyor');
  const resume=await post('/api/cases/lr_001/recovery',{action:'resume_conveyor'});
  check(resume.outcome.attempted,'resume after continuous temperature readiness');
  check(validate('action-result.schema.json',resume.outcome.operations[0]).valid,'post-cooling resume Schema');
  await waitFor('get_device_status',s=>s.outfeed_count_total>cooled.outfeed_count_total);
  const audit=JSON.parse(execFileSync('python3',[path.join(repo,'interfaces/manage.py'),'--db',database,'audit'],{encoding:'utf8'}));
  check(audit.filter((x:any)=>x.phase==='write'&&x.result?.status==='accepted').length===3,'three actual accepted write requests');
  console.log(JSON.stringify({passed:true,checks,transport:'MCP stdio',http_adapter:true,model_calls:0,live_device_calls:0}));
}finally{
  await registry.disconnectAll();
  server.closeAllConnections();
  await new Promise<void>(resolve=>server.close(()=>resolve()));
  fs.rmSync(temporary,{recursive:true,force:true});
}
