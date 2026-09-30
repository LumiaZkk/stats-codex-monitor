import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync,chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { RuntimeStore,privateFile } from '../tunnel/stores.mts';
import { SyntheticRuntime } from '../tunnel/server.mts';
import { leasePrincipal,verifyMetadata } from '../tunnel/identity.mts';
const scope={mode:'exclusive_personal_synthetic' as const,tunnel_id:'tunnel_'+'a'.repeat(32),organization_id:'org-test',workspace_id:'11111111-1111-4111-8111-111111111111'};
test('exclusive boundary rejects broadened, wrong or expired tunnel metadata',()=>{
  const metadata={id:scope.tunnel_id,organization_ids:[scope.organization_id],workspace_ids:[scope.workspace_id]};
  verifyMetadata(scope,metadata);
  for(const extra of [{organization_ids:['org-other']},{workspace_ids:[scope.workspace_id,'other']},{tenant_ids:['other']},{id:'wrong'}])assert.throws(()=>verifyMetadata(scope,{...metadata,...extra}));
  const now=Date.now(),lease={scope,verified_at:now,valid_until:now+90_000,run_until:now+3_600_000};
  assert.match(leasePrincipal(lease),/^exclusive-tunnel:/);
  assert.throws(()=>leasePrincipal({...lease,valid_until:now-1}));
  assert.throws(()=>leasePrincipal({...lease,valid_until:now+90_001}));
});
test('real SQLite runtime persists bounded subscriptions, dry-run plans and delivery dedup',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'stats-runtime-test-'));chmodSync(dir,0o700);
  let now=Date.now(),allowed=true,sent=0; const access=()=>{if(!allowed)throw new Error('revoked');return leasePrincipal({scope,verified_at:now,valid_until:now+90_000,run_until:now+3_600_000});};
  let store=new RuntimeStore(join(dir,'state.sqlite'));
  const post=async(_u:string,b:string)=>{const p=JSON.parse(b);if(p.type==='verification')return{status:200,body:JSON.stringify({challenge:p.challenge})};sent++;return{status:202,body:'{}'};};
  try{
    let runtime=new SyntheticRuntime(store,access,post);const input={op:'diagnose',idempotency_key:randomUUID()};
    const created=await runtime.local(input);assert.equal(created.request.synthetic,true);
    const sub=await runtime.events.subscribe(access(),{name:'diagnostic.requested',arguments:{stream_id:'synthetic-smoke-v1'},delivery:{mode:'webhook',url:'https://fixture.invalid/callback',secret:'whsec_'+Buffer.alloc(32,9).toString('base64')},ttlMs:60_000});
    await runtime.pump();assert.equal(sent,1);await runtime.pump();assert.equal(sent,1);
    store.close();store=new RuntimeStore(join(dir,'state.sqlite'));runtime=new SyntheticRuntime(store,access,post);
    assert.equal((await store.subscriptions.get(sub.id))!.owner,access());await runtime.pump();assert.equal(sent,1);
    const plan={schema_version:1,request_id:created.request.request_id,request_hash:created.request_hash,plan_id:randomUUID(),expires_at:created.request.expires_at,dry_run:true,summary:'Synthetic only',actions:[{type:'open_activity_monitor',target:'current_device',dry_run:true}]};
    await runtime.bridge.submit(access(),plan);assert.equal((await runtime.local({op:'result',request_id:plan.request_id})).status,'proposed');
    await assert.rejects(runtime.local({...input,telemetry:{cpu:1}}));await assert.rejects(runtime.local({op:'execute',command:'anything'}));
    await runtime.local({op:'cancel',request_id:plan.request_id});assert.equal((await runtime.local({op:'result',request_id:plan.request_id})).proposal,null);
    allowed=false;await assert.rejects(runtime.mcp({jsonrpc:'2.0',id:1,method:'tools/list'}));await runtime.pump();assert.equal(sent,1);
    privateFile(join(dir,'state.sqlite'));chmodSync(join(dir,'state.sqlite'),0o644);assert.throws(()=>privateFile(join(dir,'state.sqlite')));
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
