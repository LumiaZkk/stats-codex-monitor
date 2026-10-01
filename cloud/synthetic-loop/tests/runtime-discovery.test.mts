import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,chmodSync,rmSync,readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { RuntimeStore } from '../tunnel/stores.mts';
import { SyntheticRuntime } from '../tunnel/server.mts';
import type { RuntimeIdentity } from '../tunnel/rendezvous.mts';
import { makeNativeFixture } from '../bridge/transfer.mts';
import type { NativeSocketStatus } from '../tunnel/native-protocol.mts';
import { localResultFrame } from '../tunnel/native-protocol.mts';
function setup(){
  const dir=mkdtempSync(join(tmpdir(),'stats-discovery-protocol-'));chmodSync(dir,0o700);
  const store=new RuntimeStore(join(dir,'state.sqlite'));let now=Date.now(),allowed=true,pumps=0;
  const identity:RuntimeIdentity={instance_id:randomUUID(),protocol_version:2,uid:process.geteuid!(),runtime_pid:process.pid,started_at:new Date(now).toISOString(),expires_at:new Date(now+60_000).toISOString(),scope_hash:'1'.repeat(64)};
  const runtime=new SyntheticRuntime(store,()=>{if(!allowed)throw new Error('revoked');return 'fixture-owner';},undefined,'system',identity);
  runtime.bridge.clock=()=>now;runtime.pump=async()=>{pumps++;};
  const client=makeNativeFixture(new Date(now).toISOString(),new Date(now+60_000).toISOString(),randomUUID());
  const command=(op:string)=>({schema_version:2,op,expected_instance_id:identity.instance_id,client_request:client});
  return{store,runtime,identity,client,command,get pumps(){return pumps;},advance:(ms:number)=>{now+=ms;},revoke:()=>{allowed=false;},close:()=>{store.close();rmSync(dir,{recursive:true,force:true});}};
}
test('hello is read-only, echoes the fresh nonce and returns only nonsecret process identity',async()=>{
  const s=setup();try{
    for(let i=0;i<2;i++){const nonce=randomUUID();assert.deepEqual(await s.runtime.local({schema_version:2,op:'hello_native',expected_instance_id:s.identity.instance_id,nonce}),{schema_version:2,kind:'stats_runtime_hello',...s.identity,nonce});}
    assert.equal(s.store.db.prepare('SELECT count(*) AS n FROM diagnostic_requests').get()!.n,0);assert.equal(s.pumps,0);
    await assert.rejects(s.runtime.local({schema_version:2,op:'hello_native',expected_instance_id:s.identity.instance_id,nonce:'invalid'}),/invalid_schema/);
    await assert.rejects(s.runtime.local({schema_version:2,op:'hello_native',expected_instance_id:s.identity.instance_id,nonce:randomUUID(),path:'/unexpected'}),/invalid_schema/);
  }finally{s.close();}
});
test('bound v2 native operations preserve v1 status/bundle and reject a different runtime before any mutation',async()=>{
  const s=setup();try{
    const wrong=randomUUID();for(const op of ['diagnose_native','result_native','cancel_native'])await assert.rejects(s.runtime.local({...s.command(op),expected_instance_id:wrong}),/runtime_instance_mismatch/);
    assert.equal(s.store.db.prepare('SELECT count(*) AS n FROM diagnostic_requests').get()!.n,0);assert.equal(s.store.db.prepare('SELECT count(*) AS n FROM native_cancellations').get()!.n,0);assert.equal(s.pumps,0);
    const created=await s.runtime.local(s.command('diagnose_native')) as NativeSocketStatus;assert.equal(created.schema_version,1);assert.equal(created.status,'requested');
    const read=await s.runtime.local(s.command('result_native'));assert.deepEqual(read,created);
    const cancelled=await s.runtime.local(s.command('cancel_native')) as NativeSocketStatus;assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.bundle,null);
    await new Promise(r=>setImmediate(r));
  }finally{s.close();}
});
test('a process replacement cannot reuse the previous instance binding even over the same SQLite data',async()=>{
  const s=setup();try{
    const created=await s.runtime.local(s.command('diagnose_native')) as NativeSocketStatus;
    const replacement=new SyntheticRuntime(s.store,()=> 'fixture-owner',undefined,'system',{...s.identity,instance_id:randomUUID()});
    await assert.rejects(replacement.local(s.command('cancel_native')),/runtime_instance_mismatch/);
    assert.equal((await s.runtime.bridge.read('fixture-owner',created.request_id)).status,'requested');
    await new Promise(r=>setImmediate(r));
  }finally{s.close();}
});
test('missing/expired identity and revoked access fail before hello or bound commands',async()=>{
  const s=setup();try{
    const absent=new SyntheticRuntime(s.store,()=> 'fixture-owner');await assert.rejects(absent.local(s.command('diagnose_native')),/runtime_identity_unavailable/);
    s.advance(60_001);await assert.rejects(s.runtime.local(s.command('diagnose_native')),/runtime_expired/);
    s.revoke();await assert.rejects(s.runtime.local({schema_version:2,op:'hello_native',expected_instance_id:s.identity.instance_id,nonce:randomUUID()}),/revoked/);
    assert.equal(s.store.db.prepare('SELECT count(*) AS n FROM diagnostic_requests').get()!.n,0);
  }finally{s.close();}
});
test('shared hello fixture matches the production response frame exactly',async()=>{
  const s=setup();try{
    const descriptor=JSON.parse(readFileSync(new URL('../fixtures/runtime-descriptor-v1.json',import.meta.url),'utf8'));
    const {schema_version,kind,socket_path,...identity}=descriptor;
    const runtime=new SyntheticRuntime(s.store,()=> 'fixture-owner',undefined,'system',identity);runtime.bridge.clock=()=>Date.parse('2026-10-01T06:01:00.000Z');
    const expected=readFileSync(new URL('../fixtures/runtime-hello-v2.json',import.meta.url),'utf8'),nonce=JSON.parse(expected).result.nonce;
    assert.equal(localResultFrame(await runtime.local({schema_version:2,op:'hello_native',expected_instance_id:identity.instance_id,nonce})),expected);
  }finally{s.close();}
});
