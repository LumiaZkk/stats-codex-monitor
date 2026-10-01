// Foreground, one-hour diagnostic runtime. The runtime key is process-only.
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rename, rm, chmod } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir,userInfo } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseStrictJson } from '../bridge/json.mts';
import { validateScope } from './identity.mts';
import type { Scope } from './identity.mts';
import { privateFile } from './stores.mts';
import { validateCallbackResolver } from './resolver.mts';
import { prepareRuntimeBinary, runtimeVersionValid } from './runtime-binary.mts';
import { verifyRemoteScope } from './control-plane.mts';
import { readRuntimeKey, stdioRuntimeCommand } from './runtime-environment.mts';

process.umask(0o077);
const [binaryArgument,scopePath,resolverArgument,...extra] = process.argv.slice(2);
if(extra.length)throw new Error('Unexpected runtime arguments.');
const callbackResolver=validateCallbackResolver(resolverArgument);
if (!binaryArgument || !scopePath) throw new Error('Pass verified official binary and approved scope JSON paths.');
privateFile(scopePath);
const candidate = resolve(binaryArgument), scope = parseStrictJson(await readFile(scopePath,'utf8')) as Scope;
validateScope(scope);
delete process.env.CONTROL_PLANE_API_KEY; delete process.env.OPENAI_API_KEY; delete process.env.OPENAI_ADMIN_KEY;
const runDir = await mkdtemp(join(tmpdir(),'stats-tunnel-')); await chmod(runDir,0o700);
const node = process.execPath, server = fileURLToPath(new URL('./stdio.mts',import.meta.url));
if (![node,server].every(p => /^[a-zA-Z0-9/_.-]+$/.test(p))) throw new Error('Use an installation path without spaces or shell metacharacters.');
const safeEnv = { PATH:'/usr/bin:/bin', HOME:runDir, XDG_CONFIG_HOME:runDir, NODE_ENV:'production', STATS_TUNNEL_RUN_DIR:runDir, STATS_RUNTIME_USER_HOME:userInfo().homedir, STATS_CALLBACK_RESOLVER:callbackResolver };
const serverCommand = stdioRuntimeCommand(node, server, safeEnv);
let key = '', binary = '';
const exec = promisify(execFile);
const runUntil = Date.now()+3_600_000;
let client: ReturnType<typeof spawn> | undefined, interval: ReturnType<typeof setInterval> | undefined, deadline: ReturnType<typeof setTimeout> | undefined, stopped = false, checking = false, stopping: Promise<void> | undefined, stage = 'client_version';
const cancelled = new AbortController();
function cancel() { cancelled.abort(); }
process.once('SIGINT',cancel); process.once('SIGTERM',cancel); process.once('SIGHUP',cancel);
async function verify() {
  await verifyRemoteScope(scope,key,cancelled.signal);
  cancelled.signal.throwIfAborted(); const now = Date.now(); if (now >= runUntil) throw new Error('test_expired');
  const lease = {scope,verified_at:now,valid_until:Math.min(now+90_000,runUntil),run_until:runUntil};
  await writeFile(join(runDir,'access.tmp'),JSON.stringify(lease),{mode:0o600}); await rename(join(runDir,'access.tmp'),join(runDir,'access.json'));
}
function stop(): Promise<void> {
  if (stopping) return stopping;
  stopped=true; stopping=(async()=>{clearInterval(interval); clearTimeout(deadline);
  await rm(join(runDir,'access.json'),{force:true});
  if (client?.pid && client.exitCode === null && client.signalCode === null) {
    const signal = (s: NodeJS.Signals) => { try { client!.kill(s); } catch (e) { if((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e; } };
    const exited = new Promise(r => client!.once('exit',r)); signal('SIGTERM');
    await Promise.race([exited,new Promise(r=>setTimeout(r,2000))]);
    if(client.exitCode === null && client.signalCode === null) { signal('SIGKILL'); await Promise.race([exited,new Promise(r=>setTimeout(r,1000))]); }
  }
  // Subscription signing secrets live in this private test directory only.
  await rm(runDir,{recursive:true,force:true});
  key='';
  })(); return stopping;
}
cancelled.signal.addEventListener('abort',()=>void stop(),{once:true});
try {
  binary = await prepareRuntimeBinary(candidate,runDir);
  const version = await exec(binary,['--version'],{env:safeEnv,timeout:5000,maxBuffer:4096});
  if (!runtimeVersionValid(version.stdout)) throw new Error('unverified_client_version');
  stage='hidden_key_input'; key=await readRuntimeKey(process.stdin,cancelled.signal);
  stage='tunnel_scope'; await verify();
  const args = ['--control-plane.tunnel-id',scope.tunnel_id,'--control-plane.api-key','env:CONTROL_PLANE_API_KEY','--control-plane.base-url','https://api.openai.com','--mcp.command',serverCommand,'--health.listen-addr','127.0.0.1:0','--health.url-file',join(runDir,'health.url'),'--log.level','warn','--log.format','json'];
  cancelled.signal.throwIfAborted(); stage='running_client';
  client = spawn(binary,['run',...args],{cwd:runDir,env:{PATH:'/usr/bin:/bin',HOME:runDir,XDG_CONFIG_HOME:runDir,CONTROL_PLANE_API_KEY:key},stdio:['ignore','ignore','ignore']});
  const exited = new Promise<void>((res,rej)=>{ client!.once('error',rej); client!.once('exit',code=>code === 0 || cancelled.signal.aborted ? res() : rej(new Error('client_stopped'))); });
  interval=setInterval(()=>{ if(checking || stopped)return; checking=true; void verify().catch(()=>{process.stderr.write('Tunnel access changed or expired; stopping safely.\n');cancel();}).finally(()=>{checking=false;});},30_000);
  deadline=setTimeout(cancel,Math.max(0,runUntil-Date.now()));
  process.stdout.write(`Stats diagnostic tunnel launched (readiness not yet verified; data scope: ${scope.mode}). Private run directory: ${runDir}\n`);
  process.stdout.write('Keep this terminal open. Ctrl-C stops the test and removes temporary credentials/subscriptions.\n');
  await exited;
} catch { process.stderr.write(`Tunnel test stopped at ${stage}. Verify the narrow runtime scope and local readiness. No key was logged.\n`); process.exitCode=1; }
finally { await stop(); process.removeListener('SIGINT',cancel); process.removeListener('SIGTERM',cancel); process.removeListener('SIGHUP',cancel); }
