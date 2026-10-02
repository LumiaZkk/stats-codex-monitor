import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,chmodSync,rmSync,readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID,createHash } from 'node:crypto';
import { Bridge } from '../bridge/core.mts';
import { MemoryStore } from '../bridge/memory-store.mts';
import { makeNativeFixture } from '../bridge/transfer.mts';
import { parseStrictJson } from '../bridge/json.mts';
import { RuntimeStore } from '../tunnel/stores.mts';
import { SyntheticRuntime } from '../tunnel/server.mts';
import { LOCAL_FRAME_MAX_BYTES,LocalRequestFrame,localResultFrame,nativeSocketStatus } from '../tunnel/native-protocol.mts';
import type { NativeSocketStatus } from '../tunnel/native-protocol.mts';
function setup(){
  const dir=mkdtempSync(join(tmpdir(),'stats-native-socket-test-'));chmodSync(dir,0o700);
  let store=new RuntimeStore(join(dir,'state.sqlite')),now=Date.now(),owner='native-owner',allowed=true;
  const access=()=>{if(!allowed)throw new Error('revoked');return owner;};
  let runtime=new SyntheticRuntime(store,access);runtime.bridge.clock=()=>now;
  const request=(id:string=randomUUID())=>makeNativeFixture(new Date(now).toISOString(),new Date(now+60_000).toISOString(),id);
  const send=async(op:string,client=request())=>runtime.local({schema_version:1,op,client_request:client}) as Promise<NativeSocketStatus>;
  return {get store(){return store;},get runtime(){return runtime;},request,send,advance:(ms:number)=>{now+=ms;},owner:(name:string)=>{owner=name;},revoke:()=>{allowed=false;},restart:()=>{store.close();store=new RuntimeStore(join(dir,'state.sqlite'));runtime=new SyntheticRuntime(store,access);runtime.bridge.clock=()=>now;},close:()=>{store.close();rmSync(dir,{recursive:true,force:true});}};
}
test('native envelope submits idempotently, survives restart and returns the existing canonical proposal bundle',async()=>{
  const s=setup();try{
    const client=s.request(),first=await s.send('diagnose_native',client),again=await s.send('diagnose_native',client);
    assert.deepEqual(first,again);assert.equal(first.status,'requested');assert.equal(first.bundle,null);assert.equal(first.kind,'stats_native_socket_status');
    const request=await s.runtime.bridge.read('native-owner',first.request_id);assert.deepEqual(request.request.client_request,client);
    const plan={schema_version:1,request_id:first.request_id,request_hash:first.request_hash,plan_id:randomUUID(),expires_at:client.expires_at,dry_run:true,summary:'Synthetic native socket proposal',actions:[{type:'open_activity_monitor',target:'current_device',dry_run:true}]};
    await s.runtime.bridge.submit('native-owner',plan);s.restart();
    const result=await s.send('result_native',client);assert.equal(result.status,'proposed');assert.ok(result.bundle);assert.deepEqual(result.bundle.client_request,client);
    assert.equal(createHash('sha256').update(result.bundle.request_canonical_json).digest('hex'),result.request_hash);
    assert.equal(createHash('sha256').update(result.bundle.proposal_canonical_json).digest('hex'),result.bundle.proposal_hash);
    assert.equal(JSON.parse(result.bundle.proposal_canonical_json).dry_run,true);
    assert.equal((await s.send('cancel_native',client)).status,'cancelled');assert.equal((await s.send('result_native',client)).bundle,null);
    await assert.rejects(s.runtime.bridge.submit('native-owner',plan),/request_terminal/);
  }finally{s.close();}
});
test('native binding rejects changed hashes, changed envelopes, foreign owners, additional data and execution operations',async()=>{
  const s=setup();try{
    const client=s.request();await s.send('diagnose_native',client);
    await assert.rejects(s.send('result_native',{...client,client_request_hash:'0'.repeat(64)}),/client_request_hash_mismatch/);
    s.advance(1000);const changed=s.request(client.client_request_id);await assert.rejects(s.send('result_native',changed),/native_binding_mismatch/);
    await assert.rejects(s.runtime.local({schema_version:1,op:'diagnose_native',client_request:{...client,telemetry:{cpu:42}}}),/invalid_schema/);
    await assert.rejects(s.runtime.local({schema_version:2,op:'result_native',client_request:client}),/invalid_schema/);
    await assert.rejects(s.runtime.local({schema_version:1,op:'execute_native',client_request:client}),/unsupported_local_operation/);
    s.owner('other-owner');await assert.rejects(s.send('result_native',client),/not_found/);await assert.rejects(s.send('cancel_native',client),/not_found/);
    s.owner('native-owner');assert.equal((await s.send('result_native',client)).status,'requested');s.revoke();await assert.rejects(s.send('result_native',client),/revoked/);
  }finally{s.close();}
});
test('existing expired bindings remain readable while expired fresh submissions cannot create rows',async()=>{
  const s=setup();try{
    const client=s.request(),fresh=s.request();await s.send('diagnose_native',client);s.advance(61_000);
    const expired=await s.send('result_native',client);assert.equal(expired.status,'expired');assert.equal(expired.bundle,null);
    assert.equal((await s.send('diagnose_native',client)).status,'expired');
    await assert.rejects(s.send('diagnose_native',fresh),/invalid_transfer_expiry/);
    assert.equal(s.store.db.prepare('SELECT count(*) AS n FROM diagnostic_requests').get()!.n,1);
  }finally{s.close();}
});
test('cancellation before or during submit cannot be undone through native, MCP import or legacy insertion',async()=>{
  for(const cancelFirst of [true,false]){
    const s=setup();try{
      const client=s.request();const operations=cancelFirst ? [s.send('cancel_native',client),s.send('diagnose_native',client)] : [s.send('diagnose_native',client),s.send('cancel_native',client)];
      await Promise.allSettled(operations);s.restart();
      const rowId=s.store.nativeRequestId('native-owner',client);
      if(rowId){assert.equal((await s.send('result_native',client)).status,'cancelled');assert.equal((await s.send('diagnose_native',client)).status,'cancelled');}
      else {
        await assert.rejects(s.send('diagnose_native',client),/request_cancelled/);
        const imported=await s.runtime.mcp({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'import_synthetic_request',arguments:client}});assert.equal(imported.error?.message,'request_cancelled');
        await assert.rejects(s.runtime.local({op:'diagnose',idempotency_key:client.client_request_id}),/idempotency_conflict/);
      }
      assert.equal(s.store.pending('native-owner').length,0);
    }finally{s.close();}
  }
});
test('unknown cancellation markers are bounded without blocking cancellation of an existing request',async()=>{
  const s=setup();try{
    const known=s.request();await s.send('diagnose_native',known);
    for(let i=0;i<100;i++)await assert.rejects(s.send('cancel_native',s.request()),/not_found/);
    await assert.rejects(s.send('cancel_native',s.request()),/native_cancellation_limit/);
    assert.equal((await s.send('cancel_native',known)).status,'cancelled');
    assert.equal(s.store.db.prepare('SELECT count(*) AS n FROM native_cancellations').get()!.n,100);
  }finally{s.close();}
});
test('socket wrapper golden bytes match the existing native bundle and total UTF-8 wire bound',async()=>{
  const bundle=JSON.parse(readFileSync(new URL('../fixtures/native-result-v1.json',import.meta.url),'utf8'));
  const request=JSON.parse(bundle.request_canonical_json),plan=JSON.parse(bundle.proposal_canonical_json),store=new MemoryStore();
  await store.create({owner:'fixture-owner',idempotencyKey:bundle.client_request.client_request_id,request,requestHash:bundle.request_hash,eventId:'evt_fixture',cancelled:false,plan,planHash:bundle.proposal_hash});
  const bridge=new Bridge(store,()=>Date.parse(bundle.exported_at));
  const result=await nativeSocketStatus(bridge,'fixture-owner',bundle.client_request,request.request_id);
  assert.equal(localResultFrame(result),readFileSync(new URL('../fixtures/native-socket-status-v1.json',import.meta.url),'utf8'));
  const overhead=Buffer.byteLength(localResultFrame(''));assert.equal(Buffer.byteLength(localResultFrame('x'.repeat(LOCAL_FRAME_MAX_BYTES-overhead))),LOCAL_FRAME_MAX_BYTES);
  assert.throws(()=>localResultFrame('x'.repeat(LOCAL_FRAME_MAX_BYTES-overhead+1)),/response_too_large/);assert.throws(()=>localResultFrame('界'.repeat(6000)),/response_too_large/);
  assert.throws(()=>parseStrictJson('{"schema_version":1,"op":"result_native","op":"cancel_native"}'));
});

test('production local frame reader bounds all chunks and rejects duplicate keys or trailing frames',()=>{
  const reader=new LocalRequestFrame();assert.equal(reader.push('{"op":"res'),null);
  assert.deepEqual(reader.push('ult"}\n'),{value:{op:'result'}});
  assert.throws(()=>reader.push('x'),/invalid_local_frame/);
  assert.throws(()=>new LocalRequestFrame().push('{"op":1}\n{"op":2}\n'),/invalid_local_frame/);
  assert.throws(()=>new LocalRequestFrame().push('{"op":1,"op":2}\n'),/invalid_or_duplicate_json/);
  assert.throws(()=>new LocalRequestFrame().push('界'.repeat(6000)),/request_too_large/);
  const maximum='"'+'x'.repeat(LOCAL_FRAME_MAX_BYTES-3)+'"\n';
  assert.equal(Buffer.byteLength(maximum),LOCAL_FRAME_MAX_BYTES);assert.ok(new LocalRequestFrame().push(maximum));
  const split=new LocalRequestFrame();assert.equal(split.push(maximum.slice(0,-1)),null);
  assert.throws(()=>split.push('x\n'),/request_too_large/);
});
