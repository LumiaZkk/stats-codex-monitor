// Credential-free production-server lifecycle regression. Real Unix sockets and
// actual signals are used; this does not connect to a hosted tunnel or dot.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp,writeFile,realpath,readdir,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { runtimeDescriptorCachePath } from '../tunnel/rendezvous.mts';
const script=fileURLToPath(new URL('../tunnel/stdio.mts',import.meta.url));
for(const reason of ['SIGTERM','SIGINT','SIGHUP','EOF'] as const){
  const dir=await realpath(await mkdtemp(join(tmpdir(),'stats-stop-test-'))),now=Date.now();
  const scope={mode:'exclusive_personal_synthetic',tunnel_id:'tunnel_'+'a'.repeat(32),organization_id:'org-test',workspace_id:'11111111-1111-4111-8111-111111111111'};
  await writeFile(join(dir,'access.json'),JSON.stringify({scope,verified_at:now,valid_until:now+90_000,run_until:now+3_600_000}),{mode:0o600});
  const child=spawn(process.execPath,[script],{env:{PATH:process.env.PATH,HOME:dir,STATS_RUNTIME_USER_HOME:dir,STATS_TUNNEL_RUN_DIR:dir},stdio:['pipe','ignore','ignore']});
  let spawnError:Error|undefined;child.once('error',error=>{spawnError=error;});const exited=new Promise<void>(resolve=>child.once('exit',()=>resolve()));
  try {
    let ready=false;const until=Date.now()+10_000;
    while(!ready&&Date.now()<until){if(spawnError)throw spawnError;assert.equal(child.exitCode,null);try{ready=(await readdir(runtimeDescriptorCachePath(dir))).some(name=>name.endsWith('.json'));}catch{}if(!ready)await new Promise(resolve=>setTimeout(resolve,25));}
    assert(ready,'Descriptor must be published before stop');
    if(reason==='EOF')child.stdin!.end();else child.kill(reason);
    let deadline:ReturnType<typeof setTimeout>|undefined;
    try{await Promise.race([exited,new Promise((_,reject)=>{deadline=setTimeout(()=>reject(new Error('runtime_stop_timeout')),5000);})]);}finally{clearTimeout(deadline);}
    assert.equal(child.exitCode,0,`Graceful ${reason} must exit cleanly`);
    assert.deepEqual(await readdir(runtimeDescriptorCachePath(dir)),[],`${reason} must remove its descriptor`);
  }finally{
    if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await exited;}
    await rm(dir,{recursive:true,force:true});
  }
}
process.stdout.write('{"foreground_descriptor_cleanup":"passed","stop_modes":["SIGTERM","SIGINT","SIGHUP","EOF"],"real_credentials_used":false}\n');
