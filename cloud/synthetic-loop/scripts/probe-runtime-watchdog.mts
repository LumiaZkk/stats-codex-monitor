// Tests official `run` (not `dev proxy`, which intentionally keeps its local test
// control plane alive). No actual OpenAI API key or hosted connection is used.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp,writeFile,access,rm } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
const binary=process.env.TUNNEL_CLIENT_BIN;if(!binary)throw new Error('Verified official binary required');
process.umask(0o077);const dir=await mkdtemp(join(tmpdir(),'stats-watchdog-test-'));
const scope={mode:'exclusive_personal_synthetic',tunnel_id:'tunnel_'+'a'.repeat(32),organization_id:'org-test',workspace_id:'11111111-1111-4111-8111-111111111111'};
const now=Date.now(),lease={scope,verified_at:now,valid_until:now+90_000,run_until:now+3_600_000};
await writeFile(join(dir,'access.json'),JSON.stringify(lease),{mode:0o600});
const fixture=createServer((_req,res)=>{res.writeHead(503,{'Content-Type':'application/json'});res.end('{"error":"isolated unavailable control plane"}');});
await new Promise<void>(r=>fixture.listen(0,'127.0.0.1',r));const address=fixture.address();assert(address && typeof address!=='string');
const server=fileURLToPath(new URL('../tunnel/stdio.mts',import.meta.url));
const child=spawn(resolve(binary),['run','--control-plane.tunnel-id',scope.tunnel_id,'--control-plane.api-key','env:CONTROL_PLANE_API_KEY','--control-plane.base-url',`http://127.0.0.1:${address.port}`,'--mcp.command',`${process.execPath} ${server}`,'--health.listen-addr','127.0.0.1:0'],{env:{PATH:process.env.PATH,HOME:dir,XDG_CONFIG_HOME:dir,NODE_ENV:'test',STATS_TUNNEL_RUN_DIR:dir,CONTROL_PLANE_API_KEY:'sk-isolated-watchdog-fixture-not-a-credential'},stdio:['ignore','ignore','ignore']});
let error:Error|undefined;child.once('error',e=>{error=e;});const exited=new Promise<boolean>(r=>child.once('exit',()=>r(true)));
try{
  let ready=false;const limit=Date.now()+10_000;
  while(!ready && Date.now()<limit){if(error)throw error;assert.equal(child.exitCode,null,'Client must remain alive before the lease is expired');try{await access(join(dir,'native.sock'));ready=true;}catch{await new Promise(r=>setTimeout(r,100));}}
  assert(ready,'Private server must start before the watchdog test');
  await new Promise(r=>setTimeout(r,300));assert.equal(child.exitCode,null);
  await writeFile(join(dir,'access.json'),JSON.stringify({...lease,valid_until:Date.now()-1}),{mode:0o600});
  assert(await Promise.race([exited,new Promise<boolean>(r=>setTimeout(()=>r(false),5000))]),'Official run must stop when the private server closes stdio after lease expiry');
  process.stdout.write('{"official_run_watchdog_shutdown":"passed","real_credentials_used":false,"hosted_connection":"not_tested"}\n');
}finally{
  child.kill('SIGTERM');await Promise.race([exited,new Promise(r=>setTimeout(r,1000))]);if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await Promise.race([exited,new Promise(r=>setTimeout(r,500))]);}
  fixture.closeAllConnections();await new Promise<void>(r=>fixture.close(()=>r()));await rm(dir,{recursive:true,force:true});
}
