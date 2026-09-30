// Foreground, one-hour synthetic test. The runtime key is process-only.
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rename, rm, chmod } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseStrictJson } from '../bridge/json.mts';
import { validateScope, verifyMetadata } from './identity.mts';
import type { Scope } from './identity.mts';
import { privateFile } from './stores.mts';

process.umask(0o077);
const [binaryArgument,scopePath] = process.argv.slice(2);
if (!binaryArgument || !scopePath) throw new Error('Pass verified official binary and approved scope JSON paths.');
privateFile(scopePath);
const binary = resolve(binaryArgument), scope = parseStrictJson(await readFile(scopePath,'utf8')) as Scope;
validateScope(scope);
const key = process.env.CONTROL_PLANE_API_KEY;
delete process.env.CONTROL_PLANE_API_KEY; delete process.env.OPENAI_API_KEY; delete process.env.OPENAI_ADMIN_KEY;
if (!key || key.length > 2048 || !key.startsWith('sk-') || /\s/.test(key)) throw new Error('A runtime key must be supplied through hidden terminal input.');
const runDir = await mkdtemp(join(tmpdir(),'stats-tunnel-')); await chmod(runDir,0o700);
const node = process.execPath, server = fileURLToPath(new URL('./stdio.mts',import.meta.url));
if (![node,server].every(p => /^[a-zA-Z0-9/_.-]+$/.test(p))) throw new Error('Use an installation path without spaces or shell metacharacters.');
const safeEnv = { PATH:process.env.PATH, HOME:runDir, XDG_CONFIG_HOME:runDir, NODE_ENV:'production', STATS_TUNNEL_RUN_DIR:runDir };
const secretEnv = {...safeEnv,CONTROL_PLANE_API_KEY:key};
const exec = promisify(execFile);
const runUntil = Date.now()+3_600_000;
let client: ReturnType<typeof spawn> | undefined, interval: ReturnType<typeof setInterval> | undefined, deadline: ReturnType<typeof setTimeout> | undefined, stopped = false, checking = false, stopping: Promise<void> | undefined, stage = 'client_version';
const cancelled = new AbortController();
function cancel() { cancelled.abort(); }
process.once('SIGINT',cancel); process.once('SIGTERM',cancel); process.once('SIGHUP',cancel);
async function verify() {
  const {stdout} = await exec(binary,['admin','--json','--control-plane.base-url','https://api.openai.com','tunnels','get',scope.tunnel_id],{env:secretEnv,timeout:35_000,maxBuffer:65_536,signal:cancelled.signal});
  verifyMetadata(scope,parseStrictJson(stdout));
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
  })(); return stopping;
}
cancelled.signal.addEventListener('abort',()=>void stop(),{once:true});
try {
  const version = await exec(binary,['--version'],{env:safeEnv,timeout:5000,maxBuffer:4096});
  if (!version.stdout.includes('0.0.15+a390c168ff1b2d14e73a95991c186c6aba3ff5a0')) throw new Error('unverified_client_version');
  stage='tunnel_scope'; await verify();
  const args = ['--control-plane.tunnel-id',scope.tunnel_id,'--control-plane.api-key','env:CONTROL_PLANE_API_KEY','--control-plane.base-url','https://api.openai.com','--mcp.command',`${node} ${server}`,'--health.listen-addr','127.0.0.1:0','--health.url-file',join(runDir,'health.url'),'--log.level','warn','--log.format','json'];
  // Do not print doctor stderr/stdout: failure diagnostics must never expose a key.
  stage='doctor'; await exec(binary,['doctor',...args,'--explain'],{env:secretEnv,timeout:45_000,maxBuffer:65_536,signal:cancelled.signal});
  cancelled.signal.throwIfAborted(); stage='running_client';
  client = spawn(binary,['run',...args],{env:secretEnv,stdio:['ignore','ignore','ignore']});
  const exited = new Promise<void>((res,rej)=>{ client!.once('error',rej); client!.once('exit',code=>code === 0 || cancelled.signal.aborted ? res() : rej(new Error('client_stopped'))); });
  interval=setInterval(()=>{ if(checking || stopped)return; checking=true; void verify().catch(()=>{process.stderr.write('Tunnel access changed or expired; stopping safely.\n');cancel();}).finally(()=>{checking=false;});},30_000);
  deadline=setTimeout(cancel,Math.max(0,runUntil-Date.now()));
  process.stdout.write(`Synthetic tunnel test launched (readiness not yet verified). Private run directory: ${runDir}\n`);
  process.stdout.write('Keep this terminal open. Ctrl-C stops the test and removes temporary credentials/subscriptions.\n');
  await exited;
} catch { process.stderr.write(`Tunnel test stopped at ${stage}. Verify the narrow runtime scope and local readiness. No key was logged.\n`); process.exitCode=1; }
finally { await stop(); process.removeListener('SIGINT',cancel); process.removeListener('SIGTERM',cancel); process.removeListener('SIGHUP',cancel); }
