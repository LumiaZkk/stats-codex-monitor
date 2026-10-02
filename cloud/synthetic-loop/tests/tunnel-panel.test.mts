import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,chmodSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { RuntimeStore } from '../tunnel/stores.mts';
import { SyntheticRuntime } from '../tunnel/server.mts';
import { digest,STREAM_ID } from '../bridge/core.mts';
import { PANEL_URI } from '../ui/panel-resource.mts';
const meta={'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientCapabilities':{}};
function setup(realEnabled=false){
  const dir=mkdtempSync(join(tmpdir(),'stats-panel-test-'));chmodSync(dir,0o700);
  const store=new RuntimeStore(join(dir,'state.sqlite'));let now=Date.now(),owner='panel-owner',allowed=true;
  const sent:unknown[]=[],identity={instance_id:randomUUID(),protocol_version:2 as const,uid:501,runtime_pid:12345,started_at:new Date(now).toISOString(),expires_at:new Date(now+120_000).toISOString(),scope_hash:'a'.repeat(64)};
  const runtime=new SyntheticRuntime(store,()=>{if(!allowed)throw new Error('revoked');return owner;},async(_url,body)=>{const event=JSON.parse(body);if(event.type==='verification')return{status:200,body:JSON.stringify({challenge:event.challenge})};sent.push(event);return{status:200,body:'{}'};},'system',identity,realEnabled);
  runtime.bridge.clock=()=>now;
  const call=(name:string,args:unknown={})=>runtime.mcp({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args,_meta:meta}});
  const data=async(name:string,args:unknown={})=>{const result=await call(name,args);assert.ok(!result.error,JSON.stringify(result));return (result.result as any).structuredContent;};
  const subscribe=()=>runtime.events.subscribe(owner,{name:'diagnostic.requested',arguments:{stream_id:STREAM_ID},delivery:{mode:'webhook',url:'https://fixture.invalid/callback',secret:'whsec_'+Buffer.alloc(32,4).toString('base64')}});
  return{runtime,store,sent,identity,call,data,subscribe,advance:(ms:number)=>{now+=ms;},changeOwner:()=>{owner='other-owner';},revoke:()=>{allowed=false;},close:async()=>{await new Promise(r=>setImmediate(r));store.close();rmSync(dir,{recursive:true,force:true});}};
}
test('panel discovery and read-only opening expose the live lease, not private device identity',async()=>{
  const s=setup();try{
    const opened=await s.data('open_diagnostic_panel');assert.equal(opened.kind,'stats_tunnel_panel');assert.equal(opened.subscription_ready,false);assert.equal(opened.synthetic,true);
    assert.deepEqual(opened.connection,{state:'online',instance_id:s.identity.instance_id,expires_at:s.identity.expires_at});assert.ok(!JSON.stringify(opened).includes('scope_hash'));assert.ok(!JSON.stringify(opened).includes('runtime_pid'));
    const listing=await s.runtime.mcp({jsonrpc:'2.0',id:1,method:'tools/list',params:{_meta:meta}});const result=listing.result as any;
    const panel=result.tools.find((t:any)=>t.name==='open_diagnostic_panel');assert.equal(panel._meta.ui.resourceUri,PANEL_URI);assert.deepEqual(panel._meta['openai/ui'].entrypoints,[{type:'global'},{type:'thread'}]);assert.equal(result.resultType,'complete');assert.equal(result.cacheScope,'private');assert.equal(result.ttlMs,0);
    const resource=await s.runtime.mcp({jsonrpc:'2.0',id:1,method:'resources/read',params:{uri:PANEL_URI,_meta:meta}});assert.equal((resource.result as any).contents[0].uri,PANEL_URI);assert.equal((resource.result as any).resultType,'complete');
    const status=await s.call('get_bridge_status');assert.equal((status.result as any).resultType,'complete');
    const missing=await s.runtime.mcp({jsonrpc:'2.0',id:1,method:'resources/read',params:{uri:'file:///not-permitted',_meta:meta}});assert.equal(missing.error?.code,-32002);
  }finally{await s.close();}
});
test('one panel intent creates a fixed request, emits one event, and returns the exact immutable plan',async()=>{
  const s=setup(true);try{
    const args={expected_instance_id:s.identity.instance_id,idempotency_key:randomUUID()};
    assert.match(JSON.stringify(await s.call('panel_create_synthetic_request',args)),/synthetic_subscription_unavailable/);
    await s.subscribe();assert.equal((await s.data('open_diagnostic_panel')).subscription_ready,true);
    const first=await s.data('panel_create_synthetic_request',args),again=await s.data('panel_create_synthetic_request',args);assert.deepEqual(again,first);
    assert.equal(first.data.request.synthetic,true);assert.equal(first.data.request.stream_id,STREAM_ID);assert.equal(first.data.execution,'not_supported');assert.equal(first.receipt,null);
    assert.equal(first.data.request_hash,digest(first.data.request));await s.runtime.pump();await s.runtime.pump();assert.equal(s.sent.length,1);
    const request=first.data.request,binding={expected_instance_id:s.identity.instance_id,request_id:request.request_id,request_hash:first.data.request_hash};
    const plan={schema_version:1,request_id:request.request_id,request_hash:first.data.request_hash,plan_id:randomUUID(),expires_at:request.expires_at,dry_run:true,summary:'Fixed synthetic panel test',actions:[{type:'observe_metrics',metrics:['cpu_utilization'],duration_seconds:60,dry_run:true}]};
    await s.data('submit_diagnostic_plan',plan);
    const returned=await s.data('panel_get_synthetic_result',binding);assert.equal(returned.data.status,'proposed');assert.deepEqual(returned.data.proposal,plan);assert.equal(returned.data.proposal_hash,digest(plan));assert.equal(returned.receipt,null);
    assert.equal(s.store.db.prepare('SELECT count(*) AS n FROM real_diagnostic_requests').get()!.n,0);
    assert.equal((s.sent[0] as any).data.request_id,request.request_id);assert.equal((s.sent[0] as any).data.request_hash,first.data.request_hash);
  }finally{await s.close();}
});
test('panel rejects instance/hash/owner mismatch, binds cancellation, and stops after expiry or revocation',async()=>{
  const s=setup();try{
    await s.subscribe();const create={expected_instance_id:s.identity.instance_id,idempotency_key:randomUUID()};
    assert.match(JSON.stringify(await s.call('panel_create_synthetic_request',{...create,expected_instance_id:randomUUID()})),/runtime_instance_mismatch/);
    assert.match(JSON.stringify(await s.call('panel_create_synthetic_request',{...create,telemetry:{}})),/invalid_schema/);
    const first=await s.data('panel_create_synthetic_request',create),binding={expected_instance_id:s.identity.instance_id,request_id:first.data.request.request_id,request_hash:first.data.request_hash};
    assert.match(JSON.stringify(await s.call('panel_cancel_synthetic_request',{...binding,request_hash:'b'.repeat(64)})),/request_hash_mismatch/);
    assert.equal((await s.data('panel_get_synthetic_result',binding)).data.status,'requested');
    const cancelled=await s.data('panel_cancel_synthetic_request',binding);assert.equal(cancelled.data.status,'cancelled');assert.equal(cancelled.data.proposal,null);assert.equal(cancelled.receipt,null);
    assert.deepEqual(await s.data('panel_cancel_synthetic_request',binding),cancelled);
    s.changeOwner();assert.match(JSON.stringify(await s.call('panel_get_synthetic_result',binding)),/not_found/);
    s.advance(120_000);assert.match(JSON.stringify(await s.call('open_diagnostic_panel')),/runtime_expired/);
    s.revoke();await assert.rejects(s.call('open_diagnostic_panel'),/revoked/);
  }finally{await s.close();}
});
test('panel intent pins one subscription and cannot redirect an existing non-panel request',async()=>{
  const s=setup();try{
    const firstSub=await s.subscribe();const key=randomUUID(),args={expected_instance_id:s.identity.instance_id,idempotency_key:key};
    const created=await s.data('panel_create_synthetic_request',args),id=created.data.request.request_id;
    assert.equal(s.store.panelDestination('panel-owner',id),firstSub.id);
    const second={name:'diagnostic.requested',arguments:{stream_id:STREAM_ID},delivery:{mode:'webhook',url:'https://fixture.invalid/other-callback',secret:'whsec_'+Buffer.alloc(32,5).toString('base64')}};
    await s.runtime.events.subscribe('panel-owner',second);
    assert.equal((await s.data('open_diagnostic_panel')).subscription_ready,false);
    assert.match(JSON.stringify(await s.call('panel_create_synthetic_request',{...args,idempotency_key:randomUUID()})),/synthetic_subscription_unavailable/);
    await s.runtime.pump();assert.equal(s.sent.length,1,'A later matching subscription cannot receive the pinned request');
    await s.store.subscriptions.remove(firstSub.id);await s.runtime.pump();assert.equal(s.sent.length,1);
    assert.match(JSON.stringify(await s.call('panel_create_synthetic_request',args)),/panel_subscription_changed/);
    const otherKey=randomUUID(),ordinary=await s.runtime.bridge.create('panel-owner',{idempotency_key:otherKey,fixture:'high-cpu-v1'});
    assert.match(JSON.stringify(await s.call('panel_create_synthetic_request',{...args,idempotency_key:otherKey})),/panel_intent_conflict/);
    assert.equal(s.store.panelDestination('panel-owner',ordinary.request.request_id),undefined);
    assert.ok(!JSON.stringify(created).includes(firstSub.id));
  }finally{await s.close();}
});
