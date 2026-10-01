// Tests verified official runtime-only `run` against an unavailable loopback
// control plane. No actual OpenAI API key or hosted connection is used.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp,writeFile,access,rm,readdir,realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { runtimeDescriptorCachePath } from '../tunnel/rendezvous.mts';
import { prepareRuntimeBinary } from '../tunnel/runtime-binary.mts';
import { prepareContainment } from './runtime-probe-containment.mts';
import { createLoopbackControlPlane } from './official-runtime-fixture.mts';
const binary=process.env.TUNNEL_CLIENT_BIN;if(!binary)throw new Error('Verified official runtime-only binary required');
process.umask(0o077);const dir=await realpath(await mkdtemp(join(tmpdir(),'stats-watchdog-test-')));
const scope={mode:'exclusive_personal_synthetic',tunnel_id:'tunnel_'+'a'.repeat(32),organization_id:'org-test',workspace_id:'11111111-1111-4111-8111-111111111111'};
const now=Date.now(),lease={scope,verified_at:now,valid_until:now+90_000,run_until:now+3_600_000};
await writeFile(join(dir,'access.json'),JSON.stringify(lease),{mode:0o600});
const runtimeBinary=await prepareRuntimeBinary(binary,dir),fixture=await createLoopbackControlPlane(scope.tunnel_id,true);
const server=fileURLToPath(new URL('../tests/support/contained-runtime.mts',import.meta.url));
const containment=await prepareContainment(dir,server,fixture.apiKey);
const child=spawn(runtimeBinary,['run','--control-plane.tunnel-id',scope.tunnel_id,'--control-plane.api-key','env:CONTROL_PLANE_API_KEY','--control-plane.base-url',fixture.url,'--mcp.command',containment.command,'--health.listen-addr','127.0.0.1:0'],{env:containment.env,stdio:['ignore','ignore','ignore'],detached:process.platform!=='win32'});
let error:Error|undefined;child.once('error',e=>{error=e;});const exited=new Promise<boolean>(r=>child.once('exit',()=>r(true)));
try{
  let ready=false;const limit=Date.now()+10_000;
  while(!ready && Date.now()<limit){if(error)throw error;assert.equal(child.exitCode,null,'Client must remain alive before the lease is expired');try{await access(join(dir,'native.sock'));ready=true;}catch{await new Promise(r=>setTimeout(r,100));}}
  assert(ready,'Private server must start before the watchdog test');
  await new Promise(r=>setTimeout(r,300));assert.equal(child.exitCode,null);
  await writeFile(join(dir,'access.json'),JSON.stringify({...lease,valid_until:Date.now()-1}),{mode:0o600});
  assert(await Promise.race([exited,new Promise<boolean>(r=>setTimeout(()=>r(false),5000))]),'Official run must stop when the private server closes stdio after lease expiry');
  assert.deepEqual(await readdir(runtimeDescriptorCachePath(dir)),[],'Watchdog exit must remove its nonsecret rendezvous descriptor');
  fixture.assertHealthy();await containment.assertPassed();
  process.stdout.write('{"official_run_watchdog_shutdown":"passed","descriptor_cleanup":"passed","real_credentials_used":false,"hosted_connection":"not_tested"}\n');
}finally{
  const stop=(signal:NodeJS.Signals)=>{try{if(process.platform!=='win32'&&child.pid)process.kill(-child.pid,signal);else child.kill(signal);}catch(e){if((e as NodeJS.ErrnoException).code!=='ESRCH')throw e;}};
  stop('SIGTERM');await Promise.race([exited,new Promise(r=>setTimeout(r,1000))]);if(child.exitCode===null&&child.signalCode===null){stop('SIGKILL');await Promise.race([exited,new Promise(r=>setTimeout(r,500))]);}
  await fixture.close();await rm(dir,{recursive:true,force:true});
}
