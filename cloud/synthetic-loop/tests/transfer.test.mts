import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Bridge, canonical, digest, validateNativeRequest } from '../bridge/core.mts';
import { MemoryStore } from '../bridge/memory-store.mts';
import { importNativeRequest, exportNativeResult, makeNativeFixture, parseNativeRequestFile } from '../bridge/transfer.mts';
import { inspectNativeRequestFile } from '../bridge/import-file.mts';
const time=Date.parse('2026-09-30T09:18:00.000Z');
const native=JSON.parse(readFileSync(new URL('../fixtures/native-request-v1.json',import.meta.url),'utf8'));
const golden=JSON.parse(readFileSync(new URL('../fixtures/native-result-v1.json',import.meta.url),'utf8'));
test('cross-language fixed vectors and canonical string hashes match',async()=>{
  const text=readFileSync(new URL('../fixtures/native-request-v1.json',import.meta.url),'utf8');
  assert.deepEqual(await inspectNativeRequestFile(text,time),native); assert.deepEqual(parseNativeRequestFile(text),native); validateNativeRequest(native,time);
  assert.equal(digest(JSON.parse(golden.request_canonical_json)),golden.request_hash); assert.equal(digest(JSON.parse(golden.proposal_canonical_json)),golden.proposal_hash);
});
test('native browser import → manual proposal → unsigned result export is bound to original request',async()=>{
  const bridge=new Bridge(new MemoryStore(),()=>time); const created=await importNativeRequest(bridge,'a',native);
  assert.equal(created.request.expires_at,native.expires_at); assert.deepEqual(created.request.client_request,native);
  assert.deepEqual(await importNativeRequest(bridge,'a',native),created);
  await assert.rejects(exportNativeResult(bridge,'a',created.request.request_id),/proposal_not_available/);
  const proposal={...JSON.parse(golden.proposal_canonical_json),request_id:created.request.request_id,request_hash:created.request_hash,plan_id:randomUUID()};
  await bridge.submit('a',proposal);
  const bundle=await exportNativeResult(bridge,'a',created.request.request_id);
  assert.equal(bundle.integrity,'unsigned_sha256'); assert.equal(bundle.request_canonical_json,canonical(created.request)); assert.equal(bundle.proposal_canonical_json,canonical(proposal)); assert.equal(bundle.client_request.client_request_hash,native.client_request_hash);
  await assert.rejects(exportNativeResult(bridge,'b',created.request.request_id),/not_found/);
  await bridge.cancel('a',created.request.request_id); await assert.rejects(exportNativeResult(bridge,'a',created.request.request_id),/proposal_not_available/);
});
test('native import rejects telemetry, wrong hashes, stale/future expiry and idempotency collisions',async()=>{
  const bridge=new Bridge(new MemoryStore(),()=>time);
  for(const value of [{...native,metrics:{cpu:0.9}},{...native,client_request_hash:'0'.repeat(64)},{...native,fixture:'real-data'}]) await assert.rejects(importNativeRequest(bridge,'a',value));
  const stale=makeNativeFixture('2026-09-30T08:00:00.000Z','2026-09-30T08:30:00.000Z',randomUUID()); await assert.rejects(importNativeRequest(bridge,'a',stale),/invalid_transfer_expiry/);
  const future=makeNativeFixture('2026-09-30T10:00:00.000Z','2026-09-30T10:30:00.000Z',randomUUID()); await assert.rejects(importNativeRequest(bridge,'a',future),/invalid_transfer_expiry/);
  await bridge.create('a',{idempotency_key:native.client_request_id,fixture:'high-cpu-v1'}); await assert.rejects(importNativeRequest(bridge,'a',native),/idempotency_conflict/);
});
test('browser preview rejects additional data before any network submission',async()=>{
  const valid=canonical(native); assert.deepEqual(await inspectNativeRequestFile(valid,time),native);
  for(const text of [JSON.stringify({...native,metrics:{cpu:0.9}}),valid.replace('"fixture":"high-cpu-v1"','"fixture":"high-cpu-v1","fixture":"high-cpu-v1"'),JSON.stringify({...native,client_request_hash:'0'.repeat(64)}),' '.repeat(16385)]) await assert.rejects(inspectNativeRequestFile(text,time));
});
test('native exports unavailable for legacy browser fixtures and expired imported requests',async()=>{
  const store=new MemoryStore(),bridge=new Bridge(store,()=>time); const browser=await bridge.create('a',{idempotency_key:randomUUID(),fixture:'high-cpu-v1'}); await assert.rejects(exportNativeResult(bridge,'a',browser.request.request_id),/not_a_native_transfer/);
  const created=await importNativeRequest(bridge,'a',native); const p={...JSON.parse(golden.proposal_canonical_json),request_id:created.request.request_id,request_hash:created.request_hash}; await bridge.submit('a',p);
  const late=new Bridge(store,()=>Date.parse(native.expires_at)); await assert.rejects(exportNativeResult(late,'a',created.request.request_id),/proposal_not_available/);
  await assert.rejects(bridge.submit('a',{...p,actions:[{type:'observe_metrics',metrics:['cpu_utilization'],duration_seconds:121,dry_run:true}]}),/invalid_schema/);
});
test('MCP import and result tools share the authenticated transfer contract',async()=>{
  const { rpc, TOOLS }=await import('../bridge/mcp.mts');
  const bridge=new Bridge(new MemoryStore(),()=>time);
  const imported=await rpc(bridge,'a',{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'import_synthetic_request',arguments:native}});
  assert.ok('result' in imported);
  assert.equal(TOOLS.find(t=>t.name==='import_synthetic_request')?.annotations.readOnlyHint,false);
  assert.equal(TOOLS.find(t=>t.name==='get_native_result_bundle')?.annotations.readOnlyHint,true);
  const blocked=await rpc(bridge,null,{jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'import_synthetic_request',arguments:native}});
  assert.equal(blocked.error?.code,-32001);
});
test('production POST handler rejects duplicate keys, missing auth, wrong origin and oversize bodies',async()=>{
  const { nativeTransferPost }=await import('../bridge/transfer-http.mts');
  const bridge=new Bridge(new MemoryStore(),()=>time);
  const request=(body:string, user=true, origin='https://site.example')=>new Request('https://site.example/api/transfers',{method:'POST',headers:{'content-type':'application/json',origin,...(user?{'oai-authenticated-user-id':'isolated-test-user'}:{})},body});
  const good=await nativeTransferPost(request(canonical(native)),()=>bridge); assert.equal(good.status,201);
  const duplicate=canonical(native).replace('"fixture":"high-cpu-v1"','"fixture":"high-cpu-v1","fixture":"high-cpu-v1"');
  assert.equal((await nativeTransferPost(request(duplicate),()=>bridge)).status,400);
  assert.equal((await nativeTransferPost(request(canonical(native),false),()=>bridge)).status,401);
  assert.equal((await nativeTransferPost(request(canonical(native),true,'https://other.example'),()=>bridge)).status,403);
  assert.equal((await nativeTransferPost(request(' '.repeat(16385)),()=>bridge)).status,413);
});
test('strict JSON body parser rejects nested and escaped duplicate keys',async()=>{
  const { parseStrictJson }=await import('../bridge/json.mts');
  const { jsonBody }=await import('../bridge/http-body.mts');
  assert.throws(()=>parseStrictJson('{"a":1,"\\u0061":2}'));
  assert.throws(()=>parseStrictJson('{"nested":{"x":1,"x":2}}'));
  assert.throws(()=>parseStrictJson('[1,]'));
  assert.throws(()=>parseStrictJson('{"x":1,}'));
  assert.throws(()=>parseStrictJson('1 2'));
  assert.deepEqual(JSON.parse(JSON.stringify(parseStrictJson('{"a":[1,true,null,"\\u00e9"]}'))),{a:[1,true,null,'é']});
  await assert.rejects(jsonBody(new Request('https://site.example/mcp',{method:'POST',headers:{'content-type':'application/json'},body:'{"params":{"a":1,"a":2}}'})),/invalid_or_duplicate_json/);
});
test('cloud plans reject duplicates to match native decoder',async()=>{
  const bridge=new Bridge(new MemoryStore(),()=>time);const r=await importNativeRequest(bridge,'a',native);
  const p={...JSON.parse(golden.proposal_canonical_json),request_id:r.request.request_id,request_hash:r.request_hash};
  await assert.rejects(bridge.submit('a',{...p,actions:[p.actions[0],p.actions[0]]}),/duplicate_plan_action_or_metric/);
  await assert.rejects(bridge.submit('a',{...p,actions:[{type:'observe_metrics',metrics:['cpu_utilization','cpu_utilization'],duration_seconds:60,dry_run:true}]}),/duplicate_plan_action_or_metric/);
});
test('canonical real-calendar expiry is required before proposal storage',async()=>{
  const bridge=new Bridge(new MemoryStore(),()=>Date.parse('2026-03-02T09:00:00.000Z'));
  const r=await bridge.create('a',{idempotency_key:randomUUID(),fixture:'high-cpu-v1'});
  const p={...JSON.parse(golden.proposal_canonical_json),request_id:r.request.request_id,request_hash:r.request_hash,expires_at:'2026-02-30T09:15:00.000Z'};
  assert.equal(Date.parse(p.expires_at),Date.parse('2026-03-02T09:15:00.000Z'));
  await assert.rejects(bridge.submit('a',p),/invalid_plan_expiry/);
  assert.equal((await bridge.read('a',r.request.request_id)).status,'requested');
});
