import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync,chmodSync,readFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonical,digest } from '../bridge/core.mts';
import type { RealDiagnosticBody,RealReceipt } from '../bridge/real-contract.mts';
import { RuntimeStore } from '../tunnel/stores.mts';
import { SyntheticRuntime } from '../tunnel/server.mts';
const nodeNow=Date.now(),base=Date.parse('2026-10-01T10:00:02.000Z');
function shift(value:unknown,delta:number):unknown{
  if(typeof value==='string'&&/^2026-10-01T\d\d:\d\d:\d\d\.\d{3}Z$/.test(value))return new Date(Date.parse(value)+delta).toISOString();
  if(Array.isArray(value))return value.map(v=>shift(v,delta));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,shift(v,delta)]));return value;
}
async function setup(enabled=true,subscribe=true){
  const dir=mkdtempSync(join(tmpdir(),'stats-global-intent-'));chmodSync(dir,0o700);const store=new RuntimeStore(join(dir,'state.sqlite'));
  let now=nodeNow,owner='fixture-owner';const sent:Array<{url:string;body:any;headers:Record<string,string>}>=[];
  const identity={instance_id:randomUUID(),protocol_version:2 as const,uid:501,runtime_pid:123,started_at:new Date(now).toISOString(),expires_at:new Date(now+900_000).toISOString(),scope_hash:'a'.repeat(64)};
  const runtime=new SyntheticRuntime(store,()=>owner,async(url,text,headers)=>{const body=JSON.parse(text);if(body.type==='verification')return{status:200,body:JSON.stringify({challenge:body.challenge})};sent.push({url,body,headers});return{status:200,body:'{}'};},'system',identity,enabled);
  runtime.bridge.clock=()=>now;runtime.events.clock=()=>now;
  const subscribeEvent=(name:string,url='https://fixture.invalid/original')=>runtime.events.subscribe(owner,{name,arguments:{stream_id:'global-device-v1'},delivery:{mode:'webhook',url,secret:'whsec_'+Buffer.alloc(32,3).toString('base64')}});
  if(enabled&&subscribe)for(const name of ['diagnostic.requested','diagnostic.receipt_ready'])await subscribeEvent(name);
  const rpc=(name:string,args:unknown={})=>runtime.mcp({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}});
  const call=async(name:string,args:unknown={})=>{const reply=await rpc(name,args);assert.ok(!reply.error,JSON.stringify(reply));return (reply.result as any).structuredContent;};
  const session=randomUUID(),command=(op:string,more:Record<string,unknown>={})=>({schema_version:2,op,expected_instance_id:identity.instance_id,native_session_id:session,...more});
  const start=(key=randomUUID())=>call('panel_request_global_diagnostic',{expected_instance_id:identity.instance_id,idempotency_key:key});
  const bound=(result:any)=>({expected_instance_id:identity.instance_id,intent_id:result.intent.intent_id,intent_hash:result.intent_hash});
  const client=(result:any,mutate?:(body:RealDiagnosticBody)=>void)=>{
    const fixture=JSON.parse(readFileSync(new URL('../fixtures/real-request-v1.json',import.meta.url),'utf8'));
    const body=shift(JSON.parse(fixture.client_request_json),now-base) as RealDiagnosticBody;
    body.client_request_id=result.intent.intent_id;body.created_at=new Date(now).toISOString();body.consent.confirmed_at=body.created_at;body.expires_at=result.intent.expires_at;mutate?.(body);
    const text=canonical(body);return{schema_version:1 as const,kind:'stats_real_request' as const,client_request_json:text,client_request_hash:digest(body)};
  };
  return{runtime,store,identity,sent,session,command,start,bound,client,call,rpc,subscribeEvent,get now(){return now;},advance:(ms:number)=>{now+=ms;},changeOwner:()=>{owner='other-owner';},close:async()=>{await new Promise(r=>setImmediate(r));store.close();rmSync(dir,{recursive:true,force:true});}};
}
test('real collection is disabled without approved runtime scope and strict fields reject telemetry at intake',async()=>{
  const s=await setup(false);try{
    assert.equal((await s.call('open_diagnostic_panel')).real_enabled,false);
    await assert.rejects(s.runtime.local(s.command('next_global_collection_intent')),/real_data_scope_not_approved/);
    assert.match(JSON.stringify(await s.rpc('panel_request_global_diagnostic',{expected_instance_id:s.identity.instance_id,idempotency_key:randomUUID()})),/real_data_scope_not_approved/);
    assert.match(JSON.stringify(await s.rpc('panel_request_global_diagnostic',{expected_instance_id:s.identity.instance_id,idempotency_key:randomUUID(),snapshot:{}})),/invalid_schema/);
  }finally{await s.close();}
});
test('one metadata-only intent is idempotent, instance/owner/hash bound and claimed by one native session',async()=>{
  const s=await setup();try{
    const key=randomUUID(),first=await s.start(key);assert.deepEqual(await s.start(key),first);
    assert.equal(first.intent_hash,digest(first.intent));assert.equal(first.status,'awaiting_native');assert.equal(first.data,null);assert.equal(first.result_bundle,null);
    assert.equal(s.store.db.prepare('SELECT count(*) AS n FROM real_diagnostic_requests').get()!.n,0);await s.runtime.pump();assert.equal(s.sent.length,0);
    assert.match(JSON.stringify(await s.rpc('panel_request_global_diagnostic',{expected_instance_id:s.identity.instance_id,idempotency_key:randomUUID()})),/global_collection_busy/);
    await assert.rejects(s.runtime.local(s.command('next_global_collection_intent',{expected_instance_id:randomUUID()})),/runtime_instance_mismatch/);
    const claim=await s.runtime.local(s.command('next_global_collection_intent'));assert.equal((claim as any).intent_hash,first.intent_hash);assert.deepEqual(await s.runtime.local(s.command('next_global_collection_intent')),claim);
    assert.equal((await s.runtime.local(s.command('next_global_collection_intent',{native_session_id:randomUUID()})) as any).intent,null);
    assert.equal((await s.call('panel_get_global_diagnostic',s.bound(first))).status,'awaiting_consent');assert.equal((await s.call('open_diagnostic_panel')).native_collection_available,true);
    assert.match(JSON.stringify(await s.rpc('panel_get_global_diagnostic',{...s.bound(first),intent_hash:'b'.repeat(64)})),/intent_hash_mismatch/);
    s.advance(15_001);assert.equal((await s.call('open_diagnostic_panel')).native_collection_available,false);
    s.changeOwner();assert.match(JSON.stringify(await s.rpc('panel_get_global_diagnostic',s.bound(first))),/not_found/);
  }finally{await s.close();}
});
test('a unique pair is mandatory; different event URLs are allowed and missing destinations never retarget',async()=>{
  const s=await setup(true,false);try{
    await assert.rejects(s.start(),/global_subscription_unavailable/);
    await s.subscribeEvent('diagnostic.requested');await s.subscribeEvent('diagnostic.receipt_ready','https://fixture.invalid/receipt');
    const intent=await s.start();await s.runtime.local(s.command('next_global_collection_intent'));
    const destination=s.store.db.prepare('SELECT requested_subscription_id FROM global_collection_intents').get()!.requested_subscription_id as string;
    await s.store.subscriptions.remove(destination);await s.subscribeEvent('diagnostic.requested','https://fixture.invalid/replacement');
    await assert.rejects(s.runtime.local(s.command('diagnose_real_for_intent',{...s.bound(intent),client_request:s.client(intent)})),/global_destination_unavailable/);
    assert.equal(s.store.db.prepare('SELECT count(*) AS n FROM real_diagnostic_requests').get()!.n,0);
  }finally{await s.close();}
});
test('late consent, mismatched identity and old direct-upload route cannot bypass cancelled or declined intents',async()=>{
  for(const terminal of ['cancelled','declined'] as const){const s=await setup();try{
    const intent=await s.start(),client=s.client(intent);await s.runtime.local(s.command('next_global_collection_intent'));
    const upload=s.command('diagnose_real_for_intent',{...s.bound(intent),client_request:client});
    await assert.rejects(s.runtime.local({...upload,native_session_id:randomUUID()}),/native_session_mismatch/);
    await assert.rejects(s.runtime.local({schema_version:2,op:'diagnose_real',expected_instance_id:s.identity.instance_id,client_request:client}),/collection_intent_required/);
    if(terminal==='cancelled')await s.call('panel_cancel_global_diagnostic',s.bound(intent));
    else await s.runtime.local(s.command('resolve_global_collection_intent',{...s.bound(intent),decision:'declined'}));
    await assert.rejects(s.runtime.local(upload),/collection_intent_terminal/);
    assert.equal((await s.call('panel_get_global_diagnostic',s.bound(intent))).status,terminal);
    assert.equal(s.store.db.prepare('SELECT count(*) AS n FROM real_diagnostic_requests').get()!.n,0);await s.runtime.pump();assert.equal(s.sent.length,0);
  }finally{await s.close();}}
});
test('native consent must postdate this intent and expire within it; expired claims cannot upload',async()=>{
  const s=await setup();try{
    const intent=await s.start();await s.runtime.local(s.command('next_global_collection_intent'));
    const upload=(client:unknown)=>s.runtime.local(s.command('diagnose_real_for_intent',{...s.bound(intent),client_request:client}));
    await assert.rejects(upload(s.client(intent,b=>{b.consent.confirmed_at=new Date(s.now-1).toISOString();})),/collection_consent_binding_mismatch/);
    await assert.rejects(upload(s.client(intent,b=>{b.client_request_id=randomUUID();})),/collection_consent_binding_mismatch/);
    s.advance(600_000);await assert.rejects(upload(s.client(intent)),/collection_intent_terminal/);
    assert.equal((await s.call('panel_get_global_diagnostic',s.bound(intent))).status,'expired');
  }finally{await s.close();}
});
test('consented upload, signed events, immutable proposal and receipt stay on the pinned subscriptions',async()=>{
  const s=await setup();try{
    const intent=await s.start();await s.runtime.local(s.command('next_global_collection_intent'));const client=s.client(intent);
    const upload=s.command('diagnose_real_for_intent',{...s.bound(intent),client_request:client}),created:any=await s.runtime.local(upload);
    assert.deepEqual(await s.runtime.local(upload),created);const id=created.request_id;
    const altered=s.client(intent,b=>{b.snapshot.disk_free_bytes=1;});await assert.rejects(s.runtime.local({...upload,client_request:altered}),/real_binding_mismatch/);
    for(const name of ['diagnostic.requested','diagnostic.receipt_ready'])await s.subscribeEvent(name,'https://fixture.invalid/other-dot');
    await s.runtime.pump();await s.runtime.pump();assert.equal(s.sent.length,1);assert.equal(s.sent[0].url,'https://fixture.invalid/original');assert.match(s.sent[0].headers['webhook-signature'],/^v1,/);
    assert.deepEqual(Object.keys(s.sent[0].body.data).sort(),['expires_at','request_hash','request_id','stream_id','synthetic']);
    const plan={schema_version:2,request_id:id,request_hash:created.request_hash,plan_id:randomUUID(),expires_at:new Date(s.now+5_000).toISOString(),dry_run:false,requires_local_approval:true,policy_id:'local_capabilities_v1',decision:'no_action',summary:'No local action is needed.',actions:[]};
    await s.call('submit_diagnostic_plan',plan);
    const body=JSON.parse(client.client_request_json),receipt:RealReceipt={schema_version:1,kind:'stats_real_receipt',receipt_id:randomUUID(),client_request_id:intent.intent.intent_id,request_id:id,request_hash:created.request_hash,plan_id:plan.plan_id,plan_hash:digest(plan),candidate_id:null,policy_id:'local_capabilities_v1',started_at:new Date(s.now).toISOString(),completed_at:new Date(s.now).toISOString(),local_approval_at:null,outcome:'no_action',quit_requested:false,process_exit_confirmed:false,before:{observed_at:new Date(s.now).toISOString(),snapshot:body.snapshot,candidate:null},after:null};
    const envelope={schema_version:1,kind:'stats_real_receipt_envelope',receipt_json:canonical(receipt),receipt_hash:digest(receipt)};
    await s.runtime.local({schema_version:2,op:'receipt_real',expected_instance_id:s.identity.instance_id,client_request_id:intent.intent.intent_id,client_request_hash:client.client_request_hash,request_id:id,request_hash:created.request_hash,receipt:envelope});
    await s.runtime.pump();assert.equal(s.sent.length,2);assert.equal(s.sent[1].url,'https://fixture.invalid/original');assert.equal(s.sent[1].body.name,'diagnostic.receipt_ready');
    s.advance(6_000);const result=await s.call('panel_get_global_diagnostic',s.bound(intent));assert.equal(result.status,'expired');assert.equal(result.data.proposal,null);assert.deepEqual(result.data.receipt,envelope);assert.equal(result.result_bundle.proposal_hash,digest(plan));
    const cancelled=await s.call('panel_cancel_global_diagnostic',s.bound(intent));assert.equal(cancelled.status,'cancelled');assert.deepEqual(cancelled.data.receipt,envelope);
  }finally{await s.close();}
});
test('legacy direct native requests also require and retain a unique event pair',async()=>{
  const s=await setup(true,false);try{
    const fake={intent:{intent_id:randomUUID(),expires_at:new Date(s.now+600_000).toISOString()}},client=s.client(fake),command={schema_version:2,op:'diagnose_real',expected_instance_id:s.identity.instance_id,client_request:client};
    await assert.rejects(s.runtime.local(command),/global_subscription_unavailable/);
    for(const name of ['diagnostic.requested','diagnostic.receipt_ready'])await s.subscribeEvent(name);
    const created=await s.runtime.local(command);assert.deepEqual(await s.runtime.local(command),created);
    await s.subscribeEvent('diagnostic.requested','https://fixture.invalid/other');await s.runtime.pump();assert.equal(s.sent.length,1);assert.equal(s.sent[0].url,'https://fixture.invalid/original');
  }finally{await s.close();}
});

for(const scenario of ['unclaimed','claimed','legacy_without_instance'] as const)test(`database reopen cannot adopt an ${scenario} intent into a replacement runtime`,async()=>{
  const dir=mkdtempSync(join(tmpdir(),'stats-intent-reopen-'));chmodSync(dir,0o700);
  const path=join(dir,'state.sqlite'),owner='reopen-owner',now=Date.now();let store=new RuntimeStore(path);
  const identity=(instance_id:string)=>({instance_id,protocol_version:2 as const,uid:501,runtime_pid:123,started_at:new Date(now).toISOString(),expires_at:new Date(now+900_000).toISOString(),scope_hash:'a'.repeat(64)});
  const launch=(instance:string)=>{const value=new SyntheticRuntime(store,()=>owner,async(_url,text)=>{const body=JSON.parse(text);return{status:200,body:body.type==='verification'?JSON.stringify({challenge:body.challenge}):'{}'};},'system',identity(instance),true);value.bridge.clock=()=>now;value.events.clock=()=>now;return value;};
  const rpc=(runtime:SyntheticRuntime,name:string,args:unknown)=>runtime.mcp({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}});
  try{
    const firstID=randomUUID(),first=launch(firstID),key=randomUUID(),session=randomUUID();
    for(const name of ['diagnostic.requested','diagnostic.receipt_ready'])await first.events.subscribe(owner,{name,arguments:{stream_id:'global-device-v1'},delivery:{mode:'webhook',url:'https://fixture.invalid/events',secret:'whsec_'+Buffer.alloc(32,8).toString('base64')}});
    const initial=await rpc(first,'panel_request_global_diagnostic',{expected_instance_id:firstID,idempotency_key:key});assert.ok(!initial.error);
    const old=(initial.result as any).structuredContent;
    if(scenario==='claimed')await first.local({schema_version:2,op:'next_global_collection_intent',expected_instance_id:firstID,native_session_id:session});
    await new Promise(r=>setImmediate(r));
    if(scenario==='legacy_without_instance')store.db.exec('ALTER TABLE global_collection_intents DROP COLUMN runtime_instance_id');
    store.close();store=new RuntimeStore(path);
    const secondID=randomUUID(),second=launch(secondID),bound={expected_instance_id:secondID,intent_id:old.intent.intent_id,intent_hash:old.intent_hash};
    assert.ok(store.db.prepare('PRAGMA table_info(global_collection_intents)').all().some(column=>column.name==='runtime_instance_id'));
    assert.equal((await second.local({schema_version:2,op:'next_global_collection_intent',expected_instance_id:secondID,native_session_id:session}) as any).intent,null);
    for(const name of ['panel_get_global_diagnostic','panel_cancel_global_diagnostic'])assert.match(JSON.stringify(await rpc(second,name,bound)),/collection_runtime_mismatch/);
    assert.match(JSON.stringify(await rpc(second,'panel_request_global_diagnostic',{expected_instance_id:secondID,idempotency_key:key})),/collection_runtime_mismatch/);
    const fixture=JSON.parse(readFileSync(new URL('../fixtures/real-request-v1.json',import.meta.url),'utf8'));
    const body=shift(JSON.parse(fixture.client_request_json),now-base) as RealDiagnosticBody;body.client_request_id=old.intent.intent_id;body.created_at=new Date(now).toISOString();body.consent.confirmed_at=body.created_at;body.expires_at=old.intent.expires_at;
    const client={schema_version:1,kind:'stats_real_request',client_request_json:canonical(body),client_request_hash:digest(body)};
    await assert.rejects(second.local({schema_version:2,op:'diagnose_real_for_intent',...bound,native_session_id:session,client_request:client}),/collection_runtime_mismatch/);
    await assert.rejects(second.local({schema_version:2,op:'resolve_global_collection_intent',...bound,native_session_id:session,decision:'declined'}),/collection_runtime_mismatch/);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM real_diagnostic_requests').get()!.n,0);
    const fresh=await rpc(second,'panel_request_global_diagnostic',{expected_instance_id:secondID,idempotency_key:randomUUID()});assert.ok(!fresh.error,JSON.stringify(fresh));
    const newIntent=(fresh.result as any).structuredContent;assert.notEqual(newIntent.intent.intent_id,old.intent.intent_id);
    const claim=await second.local({schema_version:2,op:'next_global_collection_intent',expected_instance_id:secondID,native_session_id:session});assert.equal((claim as any).intent.intent_id,newIntent.intent.intent_id);
    const saved=store.db.prepare('SELECT runtime_instance_id FROM global_collection_intents WHERE intent_id=?').get(old.intent.intent_id)!.runtime_instance_id;
    assert.equal(saved,scenario==='legacy_without_instance'?'':firstID,'Old row is preserved without rebinding');
  }finally{await new Promise(r=>setImmediate(r));store.close();rmSync(dir,{recursive:true,force:true});}
});
