import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync,chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { RuntimeStore,privateFile } from '../tunnel/stores.mts';
import { SyntheticRuntime } from '../tunnel/server.mts';
import { leasePrincipal,verifyMetadata } from '../tunnel/identity.mts';
import { makeNativeFixture } from '../bridge/transfer.mts';
import { callbackTransport,validateCallbackResolver } from '../tunnel/resolver.mts';
const scope={mode:'exclusive_personal_synthetic' as const,tunnel_id:'tunnel_'+'a'.repeat(32),organization_id:'org-test',workspace_id:'11111111-1111-4111-8111-111111111111'};
test('runtime resolver changes require an explicit finite mode, with system default and no arbitrary endpoint',()=>{
  assert.equal(validateCallbackResolver(undefined),'system');assert.equal(callbackTransport('system').mode,'system');assert.equal(callbackTransport('cloudflare_doh').mode,'cloudflare_doh');
  for(const value of ['https://arbitrary.example/dns-query','fallback',true,null,''])assert.throws(()=>validateCallbackResolver(value),/invalid_callback_resolver/);
});
test('exclusive boundary rejects broadened, wrong or expired tunnel metadata',()=>{
  const metadata={id:scope.tunnel_id,organization_ids:[scope.organization_id],workspace_ids:[scope.workspace_id]};
  verifyMetadata(scope,metadata);
  for(const extra of [{organization_ids:['org-other']},{workspace_ids:[scope.workspace_id,'other']},{tenant_ids:['other']},{id:'wrong'}])assert.throws(()=>verifyMetadata(scope,{...metadata,...extra}));
  const now=Date.now(),lease={scope,verified_at:now,valid_until:now+90_000,run_until:now+3_600_000};
  assert.match(leasePrincipal(lease),/^exclusive-tunnel:/);
  assert.throws(()=>leasePrincipal({...lease,valid_until:now-1}));
  assert.throws(()=>leasePrincipal({...lease,valid_until:now+90_001}));
});
test('terminal callback rejection is not retried by persisted outbox rounds',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'stats-terminal-test-'));chmodSync(dir,0o700);const store=new RuntimeStore(join(dir,'state.sqlite'));let sends=0;
  const access=()=> 'isolated-terminal-test';const runtime=new SyntheticRuntime(store,access,async(_u,b)=>{const p=JSON.parse(b);if(p.type==='verification')return{status:200,body:JSON.stringify({challenge:p.challenge})};sends++;return{status:413,body:'{}'};});
  try{
    await runtime.bridge.create(access(),{idempotency_key:randomUUID(),fixture:'high-cpu-v1'});
    await runtime.events.subscribe(access(),{name:'diagnostic.requested',arguments:{stream_id:'synthetic-smoke-v1'},delivery:{mode:'webhook',url:'https://fixture.invalid/callback',secret:'whsec_'+Buffer.alloc(32,9).toString('base64')}});
    await runtime.pump();await runtime.pump();assert.equal(sends,1);
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
test('all insertion paths share the capacity bound while existing idempotent requests remain readable',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'stats-capacity-test-'));chmodSync(dir,0o700);const store=new RuntimeStore(join(dir,'state.sqlite'));const runtime=new SyntheticRuntime(store,()=> 'isolated-capacity-test');
  try{
    const first={idempotency_key:randomUUID(),fixture:'high-cpu-v1'};const r=await runtime.bridge.create(runtime.access(),first);
    for(let i=1;i<100;i++)await runtime.bridge.create(runtime.access(),{idempotency_key:randomUUID(),fixture:'high-cpu-v1'});
    assert.equal((await runtime.bridge.create(runtime.access(),first)).request_hash,r.request_hash);
    const now=Date.now(),file=makeNativeFixture(new Date(now).toISOString(),new Date(now+60_000).toISOString(),randomUUID());
    const response=await runtime.mcp({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'import_synthetic_request',arguments:file}});
    assert.equal(response.error?.message,'request_limit');assert.equal(store.db.prepare('SELECT count(*) AS n FROM diagnostic_requests').get()!.n,100);
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
test('real SQLite runtime persists bounded subscriptions, dry-run plans and delivery dedup',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'stats-runtime-test-'));chmodSync(dir,0o700);
  let now=Date.now(),allowed=true,sent=0; const access=()=>{if(!allowed)throw new Error('revoked');return leasePrincipal({scope,verified_at:now,valid_until:now+90_000,run_until:now+3_600_000});};
  let store=new RuntimeStore(join(dir,'state.sqlite'));
  const post=async(_u:string,b:string)=>{const p=JSON.parse(b);if(p.type==='verification')return{status:200,body:JSON.stringify({challenge:p.challenge})};sent++;return{status:202,body:'{}'};};
  try{
    let runtime=new SyntheticRuntime(store,access,post);const input={op:'diagnose',idempotency_key:randomUUID()};
    const created=await runtime.local(input);assert.ok('request' in created);assert.equal(created.request.synthetic,true);
    const sub=await runtime.events.subscribe(access(),{name:'diagnostic.requested',arguments:{stream_id:'synthetic-smoke-v1'},delivery:{mode:'webhook',url:'https://fixture.invalid/callback',secret:'whsec_'+Buffer.alloc(32,9).toString('base64')},ttlMs:60_000});
    await runtime.pump();assert.equal(sent,1);await runtime.pump();assert.equal(sent,1);
    store.close();store=new RuntimeStore(join(dir,'state.sqlite'));runtime=new SyntheticRuntime(store,access,post);
    assert.equal((await store.subscriptions.get(sub.id))!.owner,access());await runtime.pump();assert.equal(sent,1);
    const plan={schema_version:1,request_id:created.request.request_id,request_hash:created.request_hash,plan_id:randomUUID(),expires_at:created.request.expires_at,dry_run:true,summary:'Synthetic only',actions:[{type:'open_activity_monitor',target:'current_device',dry_run:true}]};
    await runtime.bridge.submit(access(),plan);assert.equal((await runtime.local({op:'result',request_id:plan.request_id})).status,'proposed');
    await assert.rejects(runtime.local({...input,telemetry:{cpu:1}}));await assert.rejects(runtime.local({op:'execute',command:'anything'}));
    await runtime.local({op:'cancel',request_id:plan.request_id});const cancelled=await runtime.local({op:'result',request_id:plan.request_id});assert.ok('proposal' in cancelled);assert.equal(cancelled.proposal,null);
    allowed=false;await assert.rejects(runtime.mcp({jsonrpc:'2.0',id:1,method:'tools/list'}));await runtime.pump();assert.equal(sent,1);
    privateFile(join(dir,'state.sqlite'));chmodSync(join(dir,'state.sqlite'),0o644);assert.throws(()=>privateFile(join(dir,'state.sqlite')));
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
test('authenticated status reports sanitized subscribe failure after rollback',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'stats-status-test-'));chmodSync(dir,0o700);const store=new RuntimeStore(join(dir,'state.sqlite'));
  const runtime=new SyntheticRuntime(store,()=> 'isolated-status-test',async()=>({status:403,body:'private response must not escape'}));
  const params={name:'diagnostic.requested',arguments:{stream_id:'synthetic-smoke-v1'},delivery:{mode:'webhook',url:'https://fixture.invalid/private-callback',secret:'whsec_'+Buffer.alloc(32,9).toString('base64')}};
  try{
    await runtime.mcp({jsonrpc:'2.0',id:1,method:'events/subscribe',params});await runtime.mcp({jsonrpc:'2.0',id:2,method:'events/unsubscribe',params});
    const status=await runtime.mcp({jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'get_bridge_status',arguments:{}}});
    const body=JSON.stringify(status);assert.ok(body.includes('callback_http_error'));assert.ok(body.includes('awaiting_subscription'));
    for(const privateValue of [params.delivery.url,params.delivery.secret,'private response must not escape'])assert.ok(!body.includes(privateValue));
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
