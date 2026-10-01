import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync,chmodSync,rmSync,readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { canonical,digest } from '../bridge/core.mts';
import { realStringHash,validateRealResult } from '../bridge/real-contract.mts';
import type { RealDiagnosticBody,RealRequestEnvelope,RealPlan,RealReceipt } from '../bridge/real-contract.mts';
import { SyntheticRuntime } from '../tunnel/server.mts';
import { RuntimeStore } from '../tunnel/stores.mts';
import { localResultFrame } from '../tunnel/native-protocol.mts';
import { validateScope,leasePrincipal } from '../tunnel/identity.mts';
const fixture=JSON.parse(readFileSync(new URL('../fixtures/real-request-v1.json',import.meta.url),'utf8')) as RealRequestEnvelope;
const base=Date.parse('2026-10-01T10:00:02.000Z');
function shift(value:unknown,delta:number):unknown{
  if(typeof value==='string'&&/^2026-10-01T\d\d:\d\d:\d\d\.\d{3}Z$/.test(value))return new Date(Date.parse(value)+delta).toISOString();
  if(Array.isArray(value))return value.map(v=>shift(v,delta));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,shift(v,delta)]));return value;
}
function envelope(body:RealDiagnosticBody):RealRequestEnvelope{const text=canonical(body);return{schema_version:1,kind:'stats_real_request',client_request_json:text,client_request_hash:realStringHash(text)};}
function setup(enabled=true){
  const dir=mkdtempSync(join(tmpdir(),'stats-real-runtime-'));chmodSync(dir,0o700);const store=new RuntimeStore(join(dir,'state.sqlite'));
  let now=Date.now(),allowed=true;const owner='isolated-real-owner',sent:unknown[]=[];
  const identity={instance_id:randomUUID(),protocol_version:2 as const,uid:process.geteuid!(),runtime_pid:process.pid,started_at:new Date(now).toISOString(),expires_at:new Date(now+3_600_000).toISOString(),scope_hash:'1'.repeat(64)};
  const runtime=new SyntheticRuntime(store,()=>{if(!allowed)throw new Error('revoked');return owner;},async(_url,text)=>{const body=JSON.parse(text);if(body.type==='verification')return{status:200,body:JSON.stringify({challenge:body.challenge})};sent.push(body);return{status:200,body:'{}'};},'system',identity,enabled);
  runtime.bridge.clock=()=>now;runtime.events.clock=()=>now;
  const body=shift(JSON.parse(fixture.client_request_json),now-base) as RealDiagnosticBody;body.client_request_id=randomUUID();const client=envelope(body);
  const command=(op:string,more:Record<string,unknown>={})=>{const common={schema_version:2,op,expected_instance_id:identity.instance_id};if(op==='receipt_real'){const id=runtime.real.clientId(owner,client),hash=id?runtime.real.read(owner,id).request_hash:'0'.repeat(64);return{...common,client_request_id:body.client_request_id,client_request_hash:client.client_request_hash,request_id:id??'00000000-0000-4000-8000-000000000000',request_hash:hash,...more};}return{...common,client_request:client,...more};};
  const rpc=(name:string,args:unknown)=>runtime.mcp({jsonrpc:'2.0',id:randomUUID(),method:'tools/call',params:{name,arguments:args}});
  return{store,runtime,owner,identity,body,client,command,rpc,sent,get now(){return now;},advance:(ms:number)=>{now+=ms;},revoke:()=>{allowed=false;},close:async()=>{await new Promise(r=>setImmediate(r));store.close();rmSync(dir,{recursive:true,force:true});}};
}
function planFor(s:ReturnType<typeof setup>,id:string,decision:RealPlan['decision']='recommend_quit'):RealPlan{const request=s.runtime.real.read(s.owner,id);return{schema_version:2,request_id:id,request_hash:request.request_hash,plan_id:randomUUID(),expires_at:request.request.expires_at,dry_run:false,requires_local_approval:true,policy_id:'local_capabilities_v1',decision,summary:'Fixture only; review exact local target before any action.',actions:decision==='recommend_quit'?[{type:'quit_app',candidate_id:s.body.candidates[0].candidate_id}]:decision==='observe'?[{type:'observe_metrics'}]:[]};}
function receiptFor(s:ReturnType<typeof setup>,plan:RealPlan){
  const start=s.now,finish=start+60_000,candidate=s.body.candidates.find(c=>plan.actions[0]?.type==='quit_app'&&c.candidate_id===plan.actions[0].candidate_id)??null;
  const snapshot=structuredClone(s.body.snapshot);for(const key of ['cpu_observed_at','memory_observed_at','disk_observed_at','io_observed_at'] as const)if(snapshot[key]!==null)snapshot[key]=new Date(start).toISOString();
  const after=structuredClone(snapshot);for(const key of ['cpu_observed_at','memory_observed_at','disk_observed_at','io_observed_at'] as const)if(after[key]!==null)after[key]=new Date(finish).toISOString();
  const receipt:RealReceipt={schema_version:1,kind:'stats_real_receipt',receipt_id:randomUUID(),client_request_id:s.body.client_request_id,request_id:plan.request_id,request_hash:plan.request_hash,plan_id:plan.plan_id,plan_hash:digest(plan),candidate_id:candidate?.candidate_id??null,policy_id:'local_capabilities_v1',started_at:new Date(start).toISOString(),completed_at:new Date(finish).toISOString(),local_approval_at:new Date(start).toISOString(),outcome:candidate?'quit_confirmed':'observed',quit_requested:Boolean(candidate),process_exit_confirmed:Boolean(candidate),before:{observed_at:new Date(start).toISOString(),snapshot,candidate:candidate?{...candidate,observed_at:new Date(start).toISOString()}:null},after:{observed_at:new Date(finish).toISOString(),snapshot:after,candidate:candidate?{...candidate,observed_at:new Date(finish).toISOString(),cpu_basis_points:null,resident_bytes:null,interval_ms:null}:null}};
  const text=canonical(receipt);return{schema_version:1 as const,kind:'stats_real_receipt_envelope' as const,receipt_json:text,receipt_hash:realStringHash(text)};
}
test('real data and real stream are disabled in the default synthetic scope',async()=>{
  const s=setup(false);try{
    for(const op of ['diagnose_real','result_real','cancel_real','receipt_real'])await assert.rejects(s.runtime.local(s.command(op)),/real_data_scope_not_approved/);
    assert.equal(s.store.db.prepare('SELECT count(*) AS n FROM real_diagnostic_requests').get()!.n,0);
    const status=await s.rpc('get_bridge_status',{});assert.match(JSON.stringify(status),/"real_data_scope":"disabled"/);
    const events=await s.runtime.mcp({jsonrpc:'2.0',id:1,method:'events/list'});assert.ok(!JSON.stringify(events).includes('global-device-v1'));
    await assert.rejects(s.runtime.events.subscribe(s.owner,{name:'diagnostic.requested',arguments:{stream_id:'global-device-v1'},delivery:{mode:'webhook',url:'https://fixture.invalid/events',secret:'whsec_'+Buffer.alloc(32,1).toString('base64')}}),/invalid_schema/);
  }finally{await s.close();}
});
test('real MCP catalog exposes object inputs and a visible stream filter without weakening branch validation',async()=>{
  const s=setup();try{
    const tools=await s.runtime.mcp({jsonrpc:'2.0',id:1,method:'tools/list'}),catalog=tools.result as {tools:Array<{name:string;inputSchema:{type:string;properties:Record<string,unknown>}}>};
    for(const tool of catalog.tools)assert.equal(tool.inputSchema.type,'object');
    const plan=catalog.tools.find(t=>t.name==='submit_diagnostic_plan')!;assert.ok(plan.inputSchema.properties.requires_local_approval);
    const events=await s.runtime.mcp({jsonrpc:'2.0',id:2,method:'events/list'}),definitions=events.result as {events:Array<{inputSchema:{type:string;properties:Record<string,unknown>}}>};
    for(const event of definitions.events){assert.equal(event.inputSchema.type,'object');assert.ok(event.inputSchema.properties.stream_id);}
    assert.ok((await s.rpc('submit_diagnostic_plan',{schema_version:2,dry_run:false})).error);
  }finally{await s.close();}
});
test('explicit real scope remains exclusively owned and changes the scope fingerprint',()=>{
  const now=Date.now(),scope={mode:'exclusive_personal_synthetic' as const,tunnel_id:'tunnel_'+'a'.repeat(32),organization_id:'org-test',workspace_id:randomUUID()};
  const real={...scope,mode:'exclusive_personal_global_diagnostics_v1' as const};validateScope(real);
  const lease={scope,verified_at:now,valid_until:now+90_000,run_until:now+3_600_000};assert.notEqual(leasePrincipal(lease),leasePrincipal({...lease,scope:real}));
  for(const mode of ['real','all_data','exclusive_personal_selected_app_v1'])assert.throws(()=>validateScope({...scope,mode}));
});
test('real commands reject wrong runtime instance, unbounded fields and revoked access before insertion',async()=>{
  const s=setup();try{
    await assert.rejects(s.runtime.local(s.command('diagnose_real',{expected_instance_id:randomUUID()})),/runtime_instance_mismatch/);
    await assert.rejects(s.runtime.local(s.command('diagnose_real',{command:'anything'})),/invalid_schema/);
    await assert.rejects(s.runtime.local({...s.command('diagnose_real'),schema_version:1}),/invalid_schema/);
    s.revoke();await assert.rejects(s.runtime.local(s.command('diagnose_real')),/revoked/);
    assert.equal(s.store.db.prepare('SELECT count(*) AS n FROM real_diagnostic_requests').get()!.n,0);
  }finally{await s.close();}
});
test('bound native request, signed event, MCP plan, receipt return and receipt event preserve ownership and hashes',async()=>{
  const s=setup();try{
    for(const name of ['diagnostic.requested','diagnostic.receipt_ready'])await s.runtime.events.subscribe(s.owner,{name,arguments:{stream_id:'global-device-v1'},delivery:{mode:'webhook',url:'https://fixture.invalid/events',secret:'whsec_'+Buffer.alloc(32,1).toString('base64')}});
    const created=await s.runtime.local(s.command('diagnose_real'));assert.ok('request_id' in created);const id=created.request_id;
    assert.deepEqual(await s.runtime.local(s.command('diagnose_real')),created);
    await s.runtime.pump();await s.runtime.pump();assert.equal(s.sent.length,1);
    assert.ok(!JSON.stringify(s.sent).includes('display_name'));assert.ok(!JSON.stringify(s.sent).includes('resident_bytes'));
    const read=await s.rpc('get_diagnostic_request',{request_id:id});assert.match(JSON.stringify(read),/stats_real_diagnostic/);
    assert.throws(()=>s.runtime.real.read('other-owner',id),/not_found/);
    const plan=planFor(s,id);const submitted=await s.rpc('submit_diagnostic_plan',plan);assert.ok(!submitted.error,JSON.stringify(submitted));
    const result=await s.runtime.local(s.command('result_real'));assert.ok('bundle' in result);assert.ok(result.bundle);validateRealResult(result.bundle,s.now,s.client);assert.ok(Buffer.byteLength(localResultFrame(result))<=16_384);
    const receipt=receiptFor(s,plan);s.advance(60_000);
    const received=await s.runtime.local(s.command('receipt_real',{receipt}));assert.ok('receipt' in received);assert.deepEqual(received.receipt,{receipt_id:JSON.parse(receipt.receipt_json).receipt_id,receipt_hash:receipt.receipt_hash});
    assert.deepEqual(await s.runtime.local(s.command('receipt_real',{receipt})),received);
    await s.runtime.pump();await s.runtime.pump();assert.equal(s.sent.length,2);
    assert.equal((s.sent[1] as {name:string}).name,'diagnostic.receipt_ready');
    const evidence=await s.rpc('get_diagnostic_result',{request_id:id});assert.match(JSON.stringify(evidence),/stats_real_receipt/);
    await s.runtime.local(s.command('cancel_real'));assert.equal(s.runtime.real.read(s.owner,id).status,'cancelled');assert.deepEqual(s.runtime.real.read(s.owner,id).receipt,receipt);
    const changed=JSON.parse(receipt.receipt_json) as RealReceipt;changed.receipt_id=randomUUID();const text=canonical(changed);
    await assert.rejects(s.runtime.local(s.command('receipt_real',{receipt:{...receipt,receipt_json:text,receipt_hash:realStringHash(text)}})),/receipt_conflict/);
  }finally{await s.close();}
});
test('cancellation before uncertain submission blocks the identical late request and mismatched bindings',async()=>{
  const s=setup();try{
    await assert.rejects(s.runtime.local(s.command('cancel_real')),/not_found/);
    await assert.rejects(s.runtime.local(s.command('diagnose_real')),/request_cancelled/);
    const changed=structuredClone(s.body);changed.snapshot.disk_free_bytes=1;const client=envelope(changed);
    await assert.rejects(s.runtime.local(s.command('diagnose_real',{client_request:client})),/real_binding_mismatch/);
    assert.equal(s.store.db.prepare('SELECT count(*) AS n FROM real_diagnostic_requests').get()!.n,0);
  }finally{await s.close();}
});
test('no action and observation plans are valid; executable extras, arbitrary targets and replacements are rejected',async()=>{
  for(const decision of ['observe','no_action'] as const){const s=setup();try{
    const created=await s.runtime.local(s.command('diagnose_real'));assert.ok('request_id' in created);const plan=planFor(s,created.request_id,decision);
    assert.ok(!(await s.rpc('submit_diagnostic_plan',plan)).error);
    assert.ok((await s.rpc('submit_diagnostic_plan',{...plan,summary:'replacement'})).error);
    assert.ok((await s.rpc('submit_diagnostic_plan',{...plan,command:'anything'})).error);
    s.advance(600_001);const expired=await s.runtime.local(s.command('result_real'));assert.ok('status' in expired);assert.equal(expired.status,'expired');
    await assert.rejects(s.runtime.local(s.command('diagnose_real',{client_request:envelope({...s.body,client_request_id:randomUUID()})})),/expiry/);
  }finally{await s.close();}}
});
test('real event delivery records survive ordinary subscription pruning and process recreation',async()=>{
  const s=setup();try{
    await s.runtime.events.subscribe(s.owner,{name:'diagnostic.requested',arguments:{stream_id:'global-device-v1'},delivery:{mode:'webhook',url:'https://fixture.invalid/events',secret:'whsec_'+Buffer.alloc(32,1).toString('base64')}});
    await s.runtime.local(s.command('diagnose_real'));await s.runtime.pump();assert.equal(s.sent.length,1);s.store.prune();await s.runtime.pump();assert.equal(s.sent.length,1);
    assert.equal(s.store.db.prepare('SELECT count(*) AS n FROM deliveries WHERE received=1').get()!.n,1);
  }finally{await s.close();}
});
test('shared real socket golden is byte-identical to the production status response',async()=>{
  const s=setup();try{
    s.runtime.bridge.clock=()=>base;
    const expected=readFileSync(new URL('../fixtures/real-socket-status-v1.json',import.meta.url),'utf8'),result=JSON.parse(expected).result;
    const bundle=result.bundle,request=JSON.parse(bundle.request_json),body=JSON.parse(request.client_request.client_request_json);
    s.store.db.prepare('INSERT INTO real_diagnostic_requests(request_id,owner,client_id,request_json,request_hash,event_id,expires_at,plan_json,plan_hash) VALUES(?,?,?,?,?,?,?,?,?)').run(request.request_id,s.owner,body.client_request_id,bundle.request_json,bundle.request_hash,'evt_'+randomUUID(),request.expires_at,bundle.proposal_json,bundle.proposal_hash);
    assert.equal(localResultFrame(s.runtime.real.status(s.owner,request.client_request)),expected);assert.ok(Buffer.byteLength(expected)<=16_384);
  }finally{await s.close();}
});
test('real request and uncertain-cancellation tables are bounded while existing cancellation remains available',async()=>{
  const s=setup();try{
    const first=s.runtime.real.create(s.owner,s.client);for(let i=1;i<100;i++)s.runtime.real.create(s.owner,envelope({...s.body,client_request_id:randomUUID()}));
    assert.throws(()=>s.runtime.real.create(s.owner,envelope({...s.body,client_request_id:randomUUID()})),/real_request_limit/);
    assert.equal(s.runtime.real.create(s.owner,s.client).request_hash,first.request_hash);
    for(let i=0;i<100;i++)assert.throws(()=>s.runtime.real.cancel(s.owner,envelope({...s.body,client_request_id:randomUUID()})),/not_found/);
    assert.throws(()=>s.runtime.real.cancel(s.owner,envelope({...s.body,client_request_id:randomUUID()})),/real_cancellation_limit/);
    assert.equal(s.runtime.real.cancel(s.owner,s.client).status,'cancelled');
  }finally{await s.close();}
});
test('receipt notification has a finite post-completion window and cannot expose collected values',async()=>{
  const s=setup();try{
    const first=s.runtime.real.create(s.owner,s.client),plan=planFor(s,first.request.request_id);s.runtime.real.submit(s.owner,plan);
    const receipt=receiptFor(s,plan);s.advance(60_000);s.runtime.real.receipt(s.owner,s.client,receipt);
    const events=s.runtime.real.events(s.owner,first.request.request_id);assert.equal(events.length,1);
    assert.deepEqual(Object.keys(events[0].data).sort(),['expires_at','receipt_hash','receipt_id','request_hash','request_id','stream_id','synthetic']);
    s.advance(600_000);assert.deepEqual(s.runtime.real.events(s.owner,first.request.request_id),[]);assert.ok(s.runtime.real.read(s.owner,first.request.request_id).receipt);
  }finally{await s.close();}
});
function wideBody(body:RealDiagnosticBody,name:string){
  const template=body.candidates[0];body.candidates=Array.from({length:5},()=>({...template,candidate_id:randomUUID(),display_name:name}));
  body.consumers=Array.from({length:10},(_,i)=>{const c=body.candidates[i%5];return{consumer_id:randomUUID(),display_name:name,category:'ordinary_gui_app' as const,cpu_basis_points:c.cpu_basis_points,resident_bytes:c.resident_bytes,interval_ms:c.interval_ms,observed_at:c.observed_at,measurement_scope:'single_process' as const,quit_candidate_id:i<5?c.candidate_id:null};});body.coverage.sampled_processes=10;
}
test('request admission budgets nested JSON escaping before creating an unreturnable request',async()=>{
  const s=setup();try{wideBody(s.body,'\\'.repeat(64));const client=envelope(s.body);
    await assert.rejects(s.runtime.local(s.command('diagnose_real',{client_request:client})),/request_result_too_large/);
    assert.equal(s.store.db.prepare('SELECT count(*) AS n FROM real_diagnostic_requests').get()!.n,0);
  }finally{await s.close();}
});
test('compact receipt references keep wide Unicode requests uploadable and reject every mismatched binding',async()=>{
  const s=setup();try{wideBody(s.body,'🧪'.repeat(64));const client=envelope(s.body);
    const created=await s.runtime.local(s.command('diagnose_real',{client_request:client}));assert.ok('request_id' in created);const plan=planFor(s,created.request_id);s.runtime.real.submit(s.owner,plan);
    const receipt=receiptFor(s,plan);s.advance(60_000);
    const command={schema_version:2,op:'receipt_real',expected_instance_id:s.identity.instance_id,client_request_id:s.body.client_request_id,client_request_hash:client.client_request_hash,request_id:created.request_id,request_hash:created.request_hash,receipt};
    assert.ok(Buffer.byteLength(JSON.stringify(command))+1<=16_384);
    for(const field of ['client_request_id','client_request_hash','request_id','request_hash'] as const){const value=field.endsWith('_hash')?'0'.repeat(64):randomUUID();await assert.rejects(s.runtime.local({...command,[field]:value}),/real_binding_mismatch|not_found/);}
    assert.equal(s.runtime.real.read(s.owner,created.request_id).receipt,null);
    const returned=await s.runtime.local(command);assert.ok(Buffer.byteLength(localResultFrame(returned))<=16_384);assert.ok('receipt' in returned&&returned.receipt);
    await assert.rejects(s.runtime.local({...command,client_request:client}),/invalid_schema/);
  }finally{await s.close();}
});
