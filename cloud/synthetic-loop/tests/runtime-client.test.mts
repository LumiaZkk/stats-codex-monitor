import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm, symlink, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { PassThrough, Readable } from 'node:stream';
import { verifyRuntimeBinary, prepareRuntimeBinary, runtimeVersionValid, RUNTIME_COMMIT } from '../tunnel/runtime-binary.mts';
import { readRuntimeKey, stdioRuntimeCommand } from '../tunnel/runtime-environment.mts';
import { verifyRemoteScope } from '../tunnel/control-plane.mts';
const exec = promisify(execFile);
const scope = {mode:'exclusive_personal_synthetic' as const,tunnel_id:'tunnel_'+'a'.repeat(32),organization_id:'org-test',workspace_id:'11111111-1111-4111-8111-111111111111'};
const metadata = {id:scope.tunnel_id,organization_ids:[scope.organization_id],workspace_ids:[scope.workspace_id],tenant_ids:[]};

test('runtime hash guard rejects executable, directory, symlink and FIFO without executing the candidate', async t => {
  const dir=await mkdtemp(join(tmpdir(),'stats-client-guard-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const marker=join(dir,'executed'),candidate=join(dir,'candidate');
  await writeFile(candidate,`#!/bin/sh\ntouch '${marker}'\n`,{mode:0o700});
  await assert.rejects(verifyRuntimeBinary(candidate),/unverified_runtime_binary/);
  await assert.rejects(verifyRuntimeBinary(dir),/invalid_runtime_binary/);
  const link=join(dir,'link');await symlink(candidate,link);
  await assert.rejects(verifyRuntimeBinary(link));
  if(process.platform!=='win32'){
    const fifo=join(dir,'fifo');await exec('/usr/bin/mkfifo',[fifo]);
    await assert.rejects(verifyRuntimeBinary(fifo),/invalid_runtime_binary/);
  }
  await assert.rejects(access(marker));
});

test('runtime guard rejects full/other flavor versions and exact-source drift', () => {
  const prefix=`0.0.15 git sha: ${RUNTIME_COMMIT} `;
  assert(runtimeVersionValid(prefix+'flavor=runtime\n'));
  for(const value of [prefix+'flavor=full',prefix+'flavor=runtime-cloudflared',prefix+'flavor=runtime extra',prefix.replace(RUNTIME_COMMIT,'b'.repeat(40))+'flavor=runtime','0.0.15+a390c168ff1b2d14e73a95991c186c6aba3ff5a0'])assert.equal(runtimeVersionValid(value),false);
});

test('launch rejects an unpinned candidate before key input and strips ambient Node hooks', async t => {
  const dir=await mkdtemp(join(tmpdir(),'stats-client-launch-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const candidate=join(dir,'candidate');await writeFile(candidate,'untrusted',{mode:0o700});
  const script=fileURLToPath(new URL('../tunnel/launch.command',import.meta.url));
  await assert.rejects(exec('/bin/bash',[script,process.execPath,candidate,join(dir,'unused-scope')],{env:{PATH:'/usr/bin:/bin',NODE_OPTIONS:'--require=/definitely/missing/preload.cjs',CONTROL_PLANE_API_KEY:'sk-fake-do-not-inherit'},timeout:3000}),error=>{
    const e=error as Error&{stderr:string};assert.match(e.stderr,/pinned runtime-only client is required/);assert.doesNotMatch(e.stderr,/Paste|\/dev\/tty|missing\/preload|sk-fake/);return true;
  });
});

test('verified private copy cannot be prepared in an unsafe directory',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'stats-client-copy-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const file=join(dir,'not-dir');await writeFile(file,'x');
  await assert.rejects(prepareRuntimeBinary(file,file),/private_runtime_directory_required/);
});

test('key stdin accepts one bounded line, rejects multi-line/overflow and aborts an open pipe',async()=>{
  assert.equal(await readRuntimeKey(Readable.from(['sk-fixture-','only\n'])),'sk-fixture-only');
  for(const value of ['sk-test','sk-test\nsk-other\n','sk-with space\n','sk-'+ 'x'.repeat(2050)+'\n'])await assert.rejects(readRuntimeKey(Readable.from([value])),/invalid_runtime_key/);
  const input=new PassThrough(),abort=new AbortController();
  const waiting=readRuntimeKey(input,abort.signal),rejected=assert.rejects(waiting,/runtime_key_input_cancelled/);
  abort.abort();await rejected;assert.equal(input.destroyed,true);
});

test('stdio command clears environment and rejects arbitrary variables or shell characters',()=>{
  assert.equal(stdioRuntimeCommand('/usr/bin/node','/private/app/stdio.mts',{PATH:'/usr/bin:/bin',HOME:'/private/run'}),'/usr/bin/env -i HOME=/private/run PATH=/usr/bin:/bin /usr/bin/node /private/app/stdio.mts');
  const invalid:Record<string,string>[]=[{CONTROL_PLANE_API_KEY:'sk-fixture'},{NODE_OPTIONS:'--require=x'},{HOME:'/private/run;whoami'}];
  for(const env of invalid)assert.throws(()=>stdioRuntimeCommand('/usr/bin/node','/private/stdio.mts',env),/invalid_stdio_environment/);
});

test('scope verification uses only exact official GET endpoint and preserves exclusive owner binding',async()=>{
  let calls=0;
  const fake=(async(url: string|URL|Request,options?:RequestInit)=>{
    calls++;assert.equal(url,`https://api.openai.com/v1/tunnels/${scope.tunnel_id}`);assert.equal(options?.method,'GET');assert.equal(options?.redirect,'error');assert.equal(options?.body,undefined);assert.deepEqual(options?.headers,{Authorization:'Bearer sk-fixture',Accept:'application/json'});return new Response(JSON.stringify(metadata));
  }) as typeof fetch;
  await verifyRemoteScope(scope,'sk-fixture',new AbortController().signal,fake);assert.equal(calls,1);
  for(const changed of [{...metadata,id:'tunnel_'+'b'.repeat(32)},{...metadata,organization_ids:[scope.organization_id,'org-other']},{...metadata,workspace_ids:[]},{...metadata,tenant_ids:['other']}])await assert.rejects(verifyRemoteScope(scope,'sk-fixture',new AbortController().signal,(async()=>new Response(JSON.stringify(changed)))as typeof fetch),/tunnel_metadata_invalid/);
});

test('metadata rejects redirects/errors, duplicate keys, oversized content and abort without echoing data',async()=>{
  const fixtures=[new Response('private server detail',{status:403}),new Response(null,{status:302,headers:{Location:'https://other.invalid'}}),new Response('{"id":"a","id":"b"}'),new Response('x'.repeat(65_537))];
  for(const response of fixtures)await assert.rejects(verifyRemoteScope(scope,'sk-fixture',new AbortController().signal,(async()=>response) as typeof fetch),/tunnel_metadata_(invalid|rejected)/);
  await assert.rejects(verifyRemoteScope(scope,'sk-fixture',new AbortController().signal,(async()=>{throw new Error('sensitive error');})as typeof fetch),error=>{assert.equal((error as Error).message,'tunnel_metadata_unavailable');return true;});
  const abort=new AbortController();abort.abort();
  await assert.rejects(verifyRemoteScope(scope,'sk-fixture',abort.signal,(async()=>new Response(JSON.stringify(metadata)))as typeof fetch),/tunnel_metadata_invalid/);
});
