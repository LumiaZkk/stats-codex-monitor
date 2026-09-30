import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import https from 'node:https';
import { consumeStdio } from '../tunnel/stdio-input.mts';
import { makePinnedHttpsPost } from '../bridge/node-https.mts';

test('production stdin reader observes EOF during pending lookup and prevents a subsequent callback connection',async(t)=>{
  let connects=0;t.mock.method(https,'request',()=>{connects++;throw new Error('network forbidden');});
  const input=new PassThrough(),lifetime=new AbortController();
  let entered!:()=>void,release!:(value:{address:string;family:number}[])=>void;
  const started=new Promise<void>(r=>entered=r);
  const post=makePinnedHttpsPost(async()=>{entered();return new Promise(r=>release=r);},lifetime.signal);
  const handled:string[]=[];
  const done=consumeStdio(input,async line=>{handled.push(line);await assert.rejects(post('https://receiver.example/callback','fixture',{}));},lifetime);
  input.write('first\n');await started;input.write('queued\n');input.end();
  await done;assert.equal(lifetime.signal.aborted,true);
  release([{address:'8.8.8.8',family:4}]);await new Promise(r=>setImmediate(r));
  assert.deepEqual(handled,['first']);assert.equal(connects,0);
});
test('production stdin reader preserves serial order and bounds queued bytes and request count',async()=>{
  const input=new PassThrough(),lifetime=new AbortController();const handled:string[]=[];
  const done=consumeStdio(input,async line=>{handled.push(line);},lifetime);
  input.write('one\ntw');input.write('o\n');await new Promise(r=>setImmediate(r));input.end();await done;
  assert.deepEqual(handled,['one','two']);
  for(const chunk of ['x'.repeat(16_385),Array.from({length:9},()=> 'x\n').join('')]){
    const stream=new PassThrough(),stop=new AbortController();const bounded=consumeStdio(stream,async()=>{},stop);
    stream.write(chunk);await assert.rejects(bounded,/message_too_large|stdio_queue_limit/);assert.equal(stop.signal.aborted,true);stream.destroy();
  }
});
test('production stdin close or stream error aborts in-flight work without retaining raw errors',async()=>{
  for(const fail of [false,true]){
    const input=new PassThrough(),lifetime=new AbortController();let entered!:()=>void;
    const started=new Promise<void>(r=>entered=r);
    const done=consumeStdio(input,async()=>{entered();await new Promise<void>(r=>lifetime.signal.addEventListener('abort',()=>r(),{once:true}));},lifetime);
    input.write('first\n');await started;input.destroy(fail ? new Error('private raw text') : undefined);
    if(fail)await assert.rejects(done,/stdio_input_failed/);else await done;
    assert.equal(lifetime.signal.aborted,true);
  }
});
