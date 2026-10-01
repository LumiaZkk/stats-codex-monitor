// Isolated protocol/IPC test only. The access lease is deliberately a test fixture.
// No hosted identity, credential, real callback or same-dot wake is being verified.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID,createHash } from 'node:crypto';
import { makeNativeFixture } from '../bridge/transfer.mts';
import { runtimeDescriptorCachePath,validateRuntimeDescriptor } from '../tunnel/rendezvous.mts';
import { digest } from '../bridge/core.mts';
import type { NativeTransferRequest } from '../bridge/core.mts';
import type { NativeSocketStatus } from '../tunnel/native-protocol.mts';
import { mkdtemp,readFile,writeFile,rm,readdir,realpath } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const binary=process.env.TUNNEL_CLIENT_BIN;if(!binary)throw new Error('Verified official binary required');
process.umask(0o077);const dir=await realpath(await mkdtemp(join(tmpdir(),'stats-private-probe-')));
const now=Date.now(),lease={scope:{mode:'exclusive_personal_synthetic',tunnel_id:'tunnel_'+'a'.repeat(32),organization_id:'org-test',workspace_id:'11111111-1111-4111-8111-111111111111'},verified_at:now,valid_until:now+90_000,run_until:now+3_600_000};
await writeFile(join(dir,'access.json'),JSON.stringify(lease),{mode:0o600});
const server=fileURLToPath(new URL('../tunnel/stdio.mts',import.meta.url));
const child=spawn(resolve(binary),['dev','proxy','--backend','go','--duration','45s','--mcp-command',`${process.execPath} ${server}`,'--url-file',join(dir,'proxy.json')],{env:{PATH:process.env.PATH,HOME:dir,XDG_CONFIG_HOME:dir,NODE_ENV:'test',STATS_TUNNEL_RUN_DIR:dir,STATS_RUNTIME_USER_HOME:dir},stdio:['ignore','ignore','pipe'],detached:process.platform!=='win32'});
let diagnostic='',id=0;child.stderr.on('data',c=>{diagnostic=(diagnostic+c.toString()).slice(-8192);});
let spawnError:Error|undefined;child.on('error',e=>{spawnError=e;});
const abort=new AbortController();const cancel=()=>abort.abort();process.once('SIGINT',cancel);process.once('SIGTERM',cancel);
type Result={request:{request_id:string;expires_at:string;client_request?:NativeTransferRequest};request_hash:string;status:string;proposal_hash:string|null};
try{
  let info:{mcp_url:string}|undefined;const limit=Date.now()+20_000;
  while(!info && Date.now()<limit){abort.signal.throwIfAborted();if(spawnError)throw spawnError;if(child.exitCode!==null)throw new Error(diagnostic);try{info=JSON.parse(await readFile(join(dir,'proxy.json'),'utf8'));}catch{await new Promise(r=>setTimeout(r,100));}}
  if(!info)throw new Error('readiness_timeout');const endpoint=new URL(info.mcp_url);assert.equal(endpoint.hostname,'127.0.0.1');assert.equal(endpoint.protocol,'http:');
  async function call(method:string,params:Record<string,unknown>={}){
    const r=await fetch(endpoint,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:++id,method,params:{...params,_meta:{'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientCapabilities':{}}}}),signal:AbortSignal.any([abort.signal,AbortSignal.timeout(10_000)])});
    assert.equal(r.status,200,`${method}: ${await r.clone().text()} ${diagnostic}`);return r.json() as Promise<{result?:{structuredContent:Result;events?:unknown[]};error?:{message:string}}>;
  }
  async function local<T=Result>(p:unknown):Promise<T>{return new Promise((res,rej)=>{let data='';const s=connect(join(dir,'native.sock'));s.setEncoding('utf8');s.setTimeout(5000,()=>s.destroy(new Error('timeout')));s.once('connect',()=>s.write(JSON.stringify(p)+'\n'));s.on('data',c=>{data+=c;if(Buffer.byteLength(data)>16_384)s.destroy(new Error('too_large'));});s.once('error',rej);s.once('end',()=>{try{const v=JSON.parse(data);if(v.error)throw new Error(v.error);res(v.result);}catch(e){rej(e);}});});}
  assert.equal((await call('server/discover')).error,undefined);assert((await call('events/list')).result?.events?.length);
  const subscription=await call('events/subscribe',{name:'diagnostic.requested',arguments:{stream_id:'synthetic-smoke-v1'},delivery:{mode:'webhook',url:'http://127.0.0.1/callback',secret:'whsec_'+Buffer.alloc(32,6).toString('base64')}});assert(subscription.error);
  const input={op:'diagnose',idempotency_key:randomUUID()};const created=await local(input),again=await local(input);assert.equal(created.request_hash,again.request_hash);
  const get=await call('tools/call',{name:'get_diagnostic_request',arguments:{request_id:created.request.request_id}});assert.equal(get.result?.structuredContent.request_hash,created.request_hash);
  const proposed=await call('tools/call',{name:'submit_diagnostic_plan',arguments:{schema_version:1,request_id:created.request.request_id,request_hash:created.request_hash,plan_id:randomUUID(),expires_at:created.request.expires_at,dry_run:true,summary:'Isolated private transport probe.',actions:[{type:'open_activity_monitor',target:'current_device',dry_run:true}]}});assert.equal(proposed.result?.structuredContent.status,'proposed');
  const returned=await local({op:'result',request_id:created.request.request_id});assert.equal(returned.proposal_hash,proposed.result?.structuredContent.proposal_hash);
  assert.equal((await local({op:'cancel',request_id:created.request.request_id})).status,'cancelled');
  const descriptorDirectory=runtimeDescriptorCachePath(dir),descriptorFiles=(await readdir(descriptorDirectory)).filter(name=>name.endsWith('.json'));
  assert.equal(descriptorFiles.length,1);const descriptor=JSON.parse(await readFile(join(descriptorDirectory,descriptorFiles[0]),'utf8'));validateRuntimeDescriptor(descriptor);
  assert.equal(descriptor.socket_path,join(dir,'native.sock'));assert.equal(descriptor.uid,process.geteuid!());assert.equal(descriptor.scope_hash,digest(lease.scope));assert.equal(descriptor.expires_at,new Date(lease.run_until).toISOString());
  const nonce=randomUUID();const hello=await local<Record<string,unknown>>({schema_version:2,op:'hello_native',expected_instance_id:descriptor.instance_id,nonce});
  const {schema_version:descriptorSchema,kind:descriptorKind,socket_path,...identity}=descriptor;
  assert.deepEqual(hello,{schema_version:2,kind:'stats_runtime_hello',...identity,nonce});
  const nativeClient=makeNativeFixture(new Date().toISOString(),new Date(Date.now()+60_000).toISOString(),randomUUID());
  const nativeCommand=(op:string)=>({schema_version:2,op,expected_instance_id:descriptor.instance_id,client_request:nativeClient});
  await assert.rejects(local({...nativeCommand('diagnose_native'),expected_instance_id:randomUUID()}),/runtime_instance_mismatch/);
  const nativeCreated=await local<NativeSocketStatus>(nativeCommand('diagnose_native'));
  assert.equal(nativeCreated.kind,'stats_native_socket_status');assert.equal(nativeCreated.status,'requested');assert.equal(nativeCreated.bundle,null);
  assert.deepEqual(await local<NativeSocketStatus>(nativeCommand('diagnose_native')),nativeCreated);
  const nativeRead=await call('tools/call',{name:'get_diagnostic_request',arguments:{request_id:nativeCreated.request_id}});
  assert.deepEqual(nativeRead.result?.structuredContent.request.client_request,nativeClient);assert.equal(nativeRead.result?.structuredContent.request_hash,nativeCreated.request_hash);
  const nativePlan=await call('tools/call',{name:'submit_diagnostic_plan',arguments:{schema_version:1,request_id:nativeCreated.request_id,request_hash:nativeCreated.request_hash,plan_id:randomUUID(),expires_at:nativeClient.expires_at,dry_run:true,summary:'Isolated native envelope transport probe.',actions:[{type:'observe_metrics',dry_run:true,duration_seconds:60,metrics:['cpu_utilization']}]}});
  assert.equal(nativePlan.result?.structuredContent.status,'proposed');
  const nativeReturned=await local<NativeSocketStatus>(nativeCommand('result_native'));assert.equal(nativeReturned.status,'proposed');assert.ok(nativeReturned.bundle);
  assert.deepEqual(nativeReturned.bundle.client_request,nativeClient);assert.equal(nativeReturned.request_hash,nativeCreated.request_hash);
  assert.equal(createHash('sha256').update(nativeReturned.bundle.request_canonical_json).digest('hex'),nativeCreated.request_hash);
  assert.equal(createHash('sha256').update(nativeReturned.bundle.proposal_canonical_json).digest('hex'),nativePlan.result?.structuredContent.proposal_hash);
  const nativeCancelled=await local<NativeSocketStatus>(nativeCommand('cancel_native'));assert.equal(nativeCancelled.status,'cancelled');assert.equal(nativeCancelled.bundle,null);
  const uncertainClient=makeNativeFixture(new Date().toISOString(),new Date(Date.now()+60_000).toISOString(),randomUUID());
  await assert.rejects(local({schema_version:1,op:'cancel_native',client_request:uncertainClient}),/not_found/);
  await assert.rejects(local({schema_version:1,op:'diagnose_native',client_request:uncertainClient}),/request_cancelled/);
  await writeFile(join(dir,'access.json'),JSON.stringify({...lease,valid_until:Date.now()-1}),{mode:0o600});
  let rejected=false;try{rejected=Boolean((await call('tools/list')).error);}catch{rejected=true;}assert(rejected,'Expired access must reject calls or close the transport');
  process.stdout.write(JSON.stringify({private_local_socket_roundtrip:'passed',native_envelope_socket_roundtrip:'passed',rendezvous_bound_protocol_v2:'passed',official_mcp_transport:'passed',invalid_callback_rejected:true,expired_access_rejected:true,hosted_tunnel:'not_tested',current_dot_wake:'not_tested',native_execution:'not_tested'})+'\n');
}finally{
  process.removeListener('SIGINT',cancel);process.removeListener('SIGTERM',cancel);
  const stop=(s:NodeJS.Signals)=>{try{if(process.platform!=='win32'&&child.pid)process.kill(-child.pid,s);else child.kill(s);}catch(e){if((e as NodeJS.ErrnoException).code!=='ESRCH')throw e;}};
  const ended=new Promise(r=>child.once('exit',r));stop('SIGTERM');await Promise.race([ended,new Promise(r=>setTimeout(r,1000))]);if(child.exitCode===null&&child.signalCode===null){stop('SIGKILL');await Promise.race([ended,new Promise(r=>setTimeout(r,500))]);}await rm(dir,{recursive:true,force:true});
}
