// Isolated protocol/IPC test only. The access lease is deliberately a test fixture.
// No hosted identity, credential, real callback or same-dot wake is being verified.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID,createHash } from 'node:crypto';
import { makeNativeFixture } from '../bridge/transfer.mts';
import { runtimeDescriptorCachePath,validateRuntimeDescriptor } from '../tunnel/rendezvous.mts';
import { canonical,digest } from '../bridge/core.mts';
import { realStringHash,validateRealResult } from '../bridge/real-contract.mts';
import type { RealDiagnosticBody,RealRequestEnvelope,RealResultBundle } from '../bridge/real-contract.mts';
import type { NativeTransferRequest } from '../bridge/core.mts';
import type { NativeSocketStatus } from '../tunnel/native-protocol.mts';
import { mkdtemp,readFile,writeFile,rm,readdir,realpath } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PANEL_URI,PANEL_HTML } from '../ui/panel-resource.mts';
import { prepareRuntimeBinary } from '../tunnel/runtime-binary.mts';
import { prepareContainment } from './runtime-probe-containment.mts';
import { createLoopbackControlPlane } from './official-runtime-fixture.mts';
const binary=process.env.TUNNEL_CLIENT_BIN;if(!binary)throw new Error('Verified official runtime-only binary required');
process.umask(0o077);const dir=await realpath(await mkdtemp(join(tmpdir(),'stats-private-probe-')));
const now=Date.now(),lease={scope:{mode:'exclusive_personal_global_diagnostics_v1',tunnel_id:'tunnel_'+'a'.repeat(32),organization_id:'org-test',workspace_id:'11111111-1111-4111-8111-111111111111'},verified_at:now,valid_until:now+90_000,run_until:now+3_600_000};
await writeFile(join(dir,'access.json'),JSON.stringify(lease),{mode:0o600});
const server=fileURLToPath(new URL('../tests/support/contained-runtime.mts',import.meta.url));
const runtimeBinary=await prepareRuntimeBinary(binary,dir),controlPlane=await createLoopbackControlPlane(lease.scope.tunnel_id);
const containment=await prepareContainment(dir,server,controlPlane.apiKey);
const child=spawn(runtimeBinary,['run','--control-plane.tunnel-id',lease.scope.tunnel_id,'--control-plane.api-key','env:CONTROL_PLANE_API_KEY','--control-plane.base-url',controlPlane.url,'--mcp.command',containment.command,'--health.listen-addr','127.0.0.1:0'],{env:containment.env,stdio:['ignore','pipe','pipe'],detached:process.platform!=='win32'});
let diagnostic='';for(const stream of [child.stdout,child.stderr])stream.on('data',c=>{diagnostic=(diagnostic+c.toString()).slice(-8192);});
let spawnError:Error|undefined;child.on('error',e=>{spawnError=e;});
const abort=new AbortController();const cancel=()=>abort.abort();process.once('SIGINT',cancel);process.once('SIGTERM',cancel);
type Result={request:{request_id:string;expires_at:string;client_request?:NativeTransferRequest};request_hash:string;status:string;proposal_hash:string|null};
try{
  async function call(method:string,params:Record<string,unknown>={}){
    abort.signal.throwIfAborted();if(spawnError)throw spawnError;
    if(child.exitCode!==null||child.signalCode!==null)throw new Error(`Official runtime stopped: ${diagnostic}`);
    try { return await controlPlane.call<{structuredContent:Result;events?:unknown[]}>(method,params,abort.signal); }
    catch(error) { throw new Error(`Isolated runtime call ${method} failed: ${(error as Error).message}; client exit=${child.exitCode}, signal=${child.signalCode}; ${diagnostic}`); }
  }
  async function local<T=Result>(p:unknown):Promise<T>{return new Promise((res,rej)=>{let data='';const s=connect(join(dir,'native.sock'));s.setEncoding('utf8');s.setTimeout(5000,()=>s.destroy(new Error('timeout')));s.once('connect',()=>s.write(JSON.stringify(p)+'\n'));s.on('data',c=>{data+=c;if(Buffer.byteLength(data)>16_384)s.destroy(new Error('too_large'));});s.once('error',rej);s.once('end',()=>{try{const v=JSON.parse(data);if(v.error)throw new Error(v.error);res(v.result);}catch(e){rej(e);}});});}
  assert.equal((await call('server/discover')).error,undefined);assert((await call('events/list')).result?.events?.length);
  // Exercise the complete (large, single-line) HTML resource through the actual
  // runtime poll/response wire and production stdio framing, not only direct rpc.
  const resource=await call('resources/read',{uri:PANEL_URI}) as unknown as {error?:unknown;result:{resultType:string;ttlMs:number;cacheScope:string;contents:Array<{uri:string;mimeType:string;text:string}>}};
  assert.equal(resource.error,undefined);assert.equal(resource.result.resultType,'complete');assert.equal(resource.result.ttlMs,0);assert.equal(resource.result.cacheScope,'private');
  assert.equal(resource.result.contents.length,1);assert.equal(resource.result.contents[0].uri,PANEL_URI);assert.equal(resource.result.contents[0].mimeType,'text/html;profile=mcp-app');
  assert.equal(createHash('sha256').update(resource.result.contents[0].text).digest('hex'),createHash('sha256').update(PANEL_HTML).digest('hex'));
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
  // These are public fake golden metrics, not measurements of the CI machine.
  // Only the production socket/MCP path is real in this isolated probe.
  for(const name of ['diagnostic.requested','diagnostic.receipt_ready']){
    const subscribed=await call('events/subscribe',{name,arguments:{stream_id:'global-device-v1'},delivery:{mode:'webhook',url:'https://fixture.invalid/events',secret:'whsec_'+Buffer.alloc(32,7).toString('base64')}});assert.equal(subscribed.error,undefined);
  }
  const intake=await call('tools/call',{name:'panel_request_global_diagnostic',arguments:{expected_instance_id:descriptor.instance_id,idempotency_key:randomUUID()}}) as unknown as {error?:unknown;result:{structuredContent:{intent:{intent_id:string;expires_at:string};intent_hash:string;status:string}}};
  assert.equal(intake.error,undefined);const collection=intake.result.structuredContent;assert.equal(collection.status,'awaiting_native');
  const nativeSession=randomUUID(),claim=await local<{intent:{intent_id:string};intent_hash:string}>({schema_version:2,op:'next_global_collection_intent',expected_instance_id:descriptor.instance_id,native_session_id:nativeSession});
  assert.equal(claim.intent.intent_id,collection.intent.intent_id);assert.equal(claim.intent_hash,collection.intent_hash);
  const realFixture=JSON.parse(await readFile(new URL('../fixtures/real-request-v1.json',import.meta.url),'utf8')) as RealRequestEnvelope;
  const realNow=Date.now(),shift=(v:unknown):unknown=>typeof v==='string'&&/^2026-10-01T\d\d:\d\d:\d\d\.\d{3}Z$/.test(v)?new Date(Date.parse(v)+realNow-Date.parse('2026-10-01T10:00:02.000Z')).toISOString():Array.isArray(v)?v.map(shift):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,shift(x)])):v;
  const realBody=shift(JSON.parse(realFixture.client_request_json)) as RealDiagnosticBody;realBody.client_request_id=collection.intent.intent_id;realBody.created_at=new Date(realNow).toISOString();realBody.consent.confirmed_at=realBody.created_at;realBody.expires_at=collection.intent.expires_at;
  const realText=canonical(realBody),realClient={...realFixture,client_request_json:realText,client_request_hash:realStringHash(realText)};
  const realCommand=(op:string,extra:Record<string,unknown>={}):Record<string,unknown>=>({schema_version:2,op:op==='diagnose_real'?'diagnose_real_for_intent':op,expected_instance_id:descriptor.instance_id,...(op==='diagnose_real'?{native_session_id:nativeSession,intent_id:collection.intent.intent_id,intent_hash:collection.intent_hash}:{}),...(op==='receipt_real'?{client_request_id:realBody.client_request_id,client_request_hash:realClient.client_request_hash,request_id:realCreated.request_id,request_hash:realCreated.request_hash}:{client_request:realClient}),...extra});
  type RealStatus={request_id:string;request_hash:string;status:string;bundle:RealResultBundle|null;receipt:{receipt_id:string;receipt_hash:string}|null};
  const realCreated:RealStatus=await local<RealStatus>(realCommand('diagnose_real'));assert.equal(realCreated.status,'requested');
  assert.deepEqual(await local<RealStatus>(realCommand('diagnose_real')),realCreated);
  const realRead=await call('tools/call',{name:'get_diagnostic_request',arguments:{request_id:realCreated.request_id}});assert.equal(realRead.result?.structuredContent.request_hash,realCreated.request_hash);
  const realPlan={schema_version:2,request_id:realCreated.request_id,request_hash:realCreated.request_hash,plan_id:randomUUID(),expires_at:realBody.expires_at,dry_run:false,requires_local_approval:true,policy_id:'local_capabilities_v1',decision:'no_action',summary:'Fixture-only production transport probe; no native action.',actions:[]};
  assert.equal((await call('tools/call',{name:'submit_diagnostic_plan',arguments:realPlan})).result?.structuredContent.status,'proposed');
  const realResult=await local<RealStatus>(realCommand('result_real'));assert.ok(realResult.bundle);validateRealResult(realResult.bundle,Date.now(),realClient);
  const receipt={schema_version:1,kind:'stats_real_receipt',receipt_id:randomUUID(),client_request_id:realBody.client_request_id,request_id:realCreated.request_id,request_hash:realCreated.request_hash,plan_id:realPlan.plan_id,plan_hash:digest(realPlan),candidate_id:null,policy_id:'local_capabilities_v1',started_at:new Date(realNow).toISOString(),completed_at:new Date(realNow).toISOString(),local_approval_at:null,outcome:'no_action',quit_requested:false,process_exit_confirmed:false,before:{observed_at:realBody.created_at,snapshot:realBody.snapshot,candidate:null},after:null};
  const receiptText=canonical(receipt),receiptEnvelope={schema_version:1,kind:'stats_real_receipt_envelope',receipt_json:receiptText,receipt_hash:realStringHash(receiptText)};
  const receiptAck=await local<RealStatus>(realCommand('receipt_real',{receipt:receiptEnvelope}));assert.deepEqual(receiptAck.receipt,{receipt_id:receipt.receipt_id,receipt_hash:receiptEnvelope.receipt_hash});
  assert.equal((await local<RealStatus>(realCommand('cancel_real'))).status,'cancelled');
  controlPlane.assertHealthy();await containment.assertPassed();
  await writeFile(join(dir,'access.json'),JSON.stringify({...lease,valid_until:Date.now()-1}),{mode:0o600});
  let rejected=false;try{rejected=Boolean((await call('tools/list')).error);}catch{rejected=true;}assert(rejected,'Expired access must reject calls or close the transport');
  process.stdout.write(JSON.stringify({private_local_socket_roundtrip:'passed',native_envelope_socket_roundtrip:'passed',rendezvous_bound_protocol_v2:'passed',global_collection_intent_roundtrip:'passed',real_schema_fixture_roundtrip:'passed',receipt_return:'passed',official_mcp_transport:'passed',panel_resource_transport:'passed',runtime_only_containment:'passed',invalid_callback_rejected:true,expired_access_rejected:true,hosted_tunnel:'not_tested',current_dot_wake:'not_tested',native_execution:'not_tested',real_telemetry_used:false})+'\n');
}finally{
  process.removeListener('SIGINT',cancel);process.removeListener('SIGTERM',cancel);
  const stop=(s:NodeJS.Signals)=>{try{if(process.platform!=='win32'&&child.pid)process.kill(-child.pid,s);else child.kill(s);}catch(e){if((e as NodeJS.ErrnoException).code!=='ESRCH')throw e;}};
  const ended=new Promise(r=>child.once('exit',r));stop('SIGTERM');await Promise.race([ended,new Promise(r=>setTimeout(r,1000))]);if(child.exitCode===null&&child.signalCode===null){stop('SIGKILL');await Promise.race([ended,new Promise(r=>setTimeout(r,500))]);}await controlPlane.close();await rm(dir,{recursive:true,force:true});
}
