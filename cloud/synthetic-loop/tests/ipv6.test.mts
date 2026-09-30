import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ClientRequest,IncomingMessage } from 'node:http';
import type { RequestOptions } from 'node:https';
import { publicIPv6 } from '../bridge/ipv6.mts';
import { classifyAddresses,makePinnedHttpsPost,selectCallbackAddress } from '../bridge/node-https.mts';

test('ordinary current RIR IPv6 allocations and equivalent spellings are admitted',()=>{
  for(const address of ['2001:4860:4860::8888','2606:4700:4700::1111','2620:fe::fe','2404:6800::1','2410::1','2630::1','2800::1','2a10::1','2c0f::1','2003:3fff::1','2001:200::1','2001:db7::1','2001:db9::1'])assert.equal(publicIPv6(address),true,address);
  for(const address of ['2606:4700:4700:0:0:0:0:1111','2606:4700:4700:0000:0000:0000:0000:1111','2606:4700:4700::1111','2A10:0000:0000:0000:0000:0000:0000:0001','2606:4700::8.8.8.8','2606:4700::808:808'])assert.equal(publicIPv6(address),true,address);
});
test('local, mapped, translated, special, documentation, transitional and reserved IPv6 fail closed',()=>{
  for(const address of ['::','::1','::8.8.8.8','::ffff:8.8.8.8','::ffff:808:808','::ffff:0:808:808','64:ff9b::808:808','64:ff9b:1::1','100::1','100:0:0:1::1','fc00::1','fdff::1','fe80::1','febf::1','fec0::1','ff02::1','2001::1','2001:1::1','2001:2::1','2001:3::1','2001:10::1','2001:20::1','2001:30::1','2001:db8::1','2002:808:808::1','2620:4f:8000::1','3fff::1','3ffe::1','5f00::1','2000::1','2001:1000::1','2001:6000::1','2001:ffff::1','2003:4000::1','2500::1','2d00::1','3000::1','4000::1','2606:4700::5efe:808:808','2001:4860::200:5efe:127.0.0.1'])assert.equal(publicIPv6(address),false,address);
});
test('malformed, bracketed and scope-qualified IPv6 cannot enter the prefix classifier',()=>{
  for(const address of ['', ' 2606:4700::1111','2606:4700::1111 ','[2606:4700::1111]','2606:4700::1111%eth0','2606:::1111','2606:4700::zzzz','2606:4700:0:0:0:0:0:0:1','8.8.8.8'])assert.equal(publicIPv6(address),false,address);
});
test('all DNS answers must pass and a validated IPv4 destination is chosen explicitly',()=>{
  const a={address:'8.8.8.8',family:4},aaaa={address:'2606:4700:4700::1111',family:6};
  assert.deepEqual(selectCallbackAddress([aaaa,a]),a);
  for(const blocked of ['::1','2001:db8::1','::ffff:8.8.8.8','2001:1000::1'])assert.throws(()=>selectCallbackAddress([a,{address:blocked,family:6}]),/non_public_callback/);
  assert.throws(()=>selectCallbackAddress([aaaa]),/callback_ipv4_unavailable/);
  assert.throws(()=>selectCallbackAddress([{...aaaa,family:4},a]),/non_public_callback/);
  assert.deepEqual(classifyAddresses([a,aaaa,{address:'fc00::1',family:6}]),{public_ipv4:1,non_public_ipv4:0,benchmark_ipv4:0,public_ipv6:1,non_public_ipv6:1,invalid_address:0});
});
test('dual-stack callback transport pins the validated A record and never connects after a rejected AAAA',async(t)=>{
  let connects=0,captured:RequestOptions|undefined;
  t.mock.method(https,'request',((_url:unknown,options:RequestOptions,callback:(res:IncomingMessage)=>void)=>{
    connects++;captured=options;const req=new EventEmitter() as ClientRequest;
    req.end=(()=>{queueMicrotask(()=>{const stream=new PassThrough(),res=stream as unknown as IncomingMessage;res.statusCode=200;callback(res);stream.end('{}');});return req;}) as ClientRequest['end'];
    return req;
  }) as typeof https.request);
  const a={address:'8.8.8.8',family:4},aaaa={address:'2606:4700:4700::1111',family:6};
  const result=await makePinnedHttpsPost(async()=>[aaaa,a])('https://receiver.example/callback','fixture',{});
  assert.equal(result.status,200);assert.equal(captured?.family,4);assert.equal(captured?.servername,'receiver.example');assert.equal(captured?.rejectUnauthorized,true);assert.equal(captured?.agent,false);
  const chosen=await new Promise(resolve=>(captured!.lookup as Function)('receiver.example',{},(error:unknown,address:unknown,family:unknown)=>resolve({error,address,family})));
  assert.deepEqual(chosen,{error:null,address:a.address,family:4});
  await assert.rejects(makePinnedHttpsPost(async()=>[a,{address:'::ffff:127.0.0.1',family:6}])('https://receiver.example/callback','fixture',{}),/non_public_callback/);
  assert.equal(connects,1);
});
