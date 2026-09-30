import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { randomUUID, createHmac } from 'node:crypto';
import { Bridge, STREAM_ID, EVENT_NAME, digest, validate, planSchema } from '../bridge/core.mts';
import type { Plan } from '../bridge/core.mts';
import { MemoryStore } from '../bridge/memory-store.mts';
import { rpc, TOOLS } from '../bridge/mcp.mts';
import { Events, signingKey } from '../bridge/events.mts';
import type { Subscription } from '../bridge/events.mts';
import { classifyAddresses, makePinnedHttpsPost, publicIPv4 } from '../bridge/node-https.mts';
const A = 'test-owner-a', B = 'test-owner-b';
const now = Date.parse('2026-09-30T08:00:00.000Z');
const fixture = () => ({ idempotency_key: randomUUID(), fixture: 'high-cpu-v1' });
const setup = () => { const store = new MemoryStore(); return { store, bridge: new Bridge(store, () => now) }; };
const planFor = (r: Awaited<ReturnType<Bridge['create']>>): Plan => ({ schema_version: 1, request_id: r.request.request_id, request_hash: r.request_hash, plan_id: randomUUID(), expires_at: r.request.expires_at, dry_run: true, summary: 'Synthetic sustained CPU load; inspect activity and observe the trend.', actions: [{ type: 'open_activity_monitor', target: 'current_device', dry_run: true }, { type: 'observe_metrics', metrics: ['cpu_utilization'], duration_seconds: 60, dry_run: true }] });
test('synthetic request → signed mock event → read → valid proposal → client result', async () => {
  const { bridge } = setup(); const subscriptions = new Map<string, Subscription>();
  const secret = 'whsec_' + Buffer.alloc(32, 7).toString('base64'); // Non-production deterministic test fixture.
  let eventCount = 0;
  const events = new Events({ get: async id => subscriptions.get(id) ?? null, put: async s => { subscriptions.set(s.id, s); }, remove: async id => { subscriptions.delete(id); } }, async (_url, body, headers) => {
    const expected = 'v1,' + createHmac('sha256', signingKey(secret)).update(`${headers['webhook-id']}.${headers['webhook-timestamp']}.${body}`).digest('base64');
    assert.equal(headers['webhook-signature'], expected);
    const data = JSON.parse(body);
    if (data.type === 'verification') return { status: 200, body: JSON.stringify({ challenge: data.challenge }) };
    eventCount++;
    const response = await rpc(bridge, A, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_diagnostic_request', arguments: { request_id: data.data.request_id } } });
    assert.ok('result' in response);
    const r = await bridge.read(A, data.data.request_id);
    await bridge.submit(A, planFor(r));
    return { status: 202, body: '{}' };
  }, async () => true, () => now);
  const sub = await events.subscribe(A, { name: EVENT_NAME, arguments: { stream_id: STREAM_ID }, delivery: { mode: 'webhook', url: 'https://receiver.example/callback', secret } });
  const r = await bridge.create(A, fixture()); const event = await bridge.event(A, r.request.request_id);
  const delivery = await events.deliver(A, sub.id, event, async () => true);
  const result = await bridge.read(A, r.request.request_id);
  assert.equal(eventCount, 1); assert.equal(delivery.analysis_complete, false); assert.equal(result.status, 'proposed'); assert.equal(result.execution, 'not_supported');
  assert.equal(result.proposal_hash, digest(result.proposal));
});
test('idempotency, repeated event ID, same proposal replay and conflicting proposal', async () => {
  const { bridge } = setup(); const input = fixture(); const r = await bridge.create(A, input);
  assert.deepEqual(await bridge.create(A, input), r);
  assert.deepEqual(await bridge.event(A, r.request.request_id), await bridge.event(A, r.request.request_id));
  const plan = planFor(r); const first = await bridge.submit(A, plan);
  assert.deepEqual(await bridge.submit(A, plan), first);
  await assert.rejects(bridge.submit(A, { ...plan, summary: 'Changed' }), /proposal_conflict/);
});
test('ownership rejects reads, writes, cancellation and guessed requests', async () => {
  const { bridge } = setup(); const r = await bridge.create(A, fixture());
  for (const op of [() => bridge.read(B, r.request.request_id), () => bridge.submit(B, planFor(r)), () => bridge.cancel(B, r.request.request_id)]) await assert.rejects(op(), /not_found/);
  await assert.rejects(bridge.create('', fixture()), /authentication_required/);
});
test('immutable hashes, dry-run allowlist, extra keys and arbitrary shell are rejected', async () => {
  const { bridge } = setup(); const r = await bridge.create(A, fixture()); const p = planFor(r);
  await assert.rejects(bridge.submit(A, { ...p, request_hash: '0'.repeat(64) }), /request_hash_mismatch/);
  for (const bad of [{ ...p, dry_run: false }, { ...p, command: 'rm -rf /' }, { ...p, actions: [{ type: 'shell', command: 'id' }] }, { ...p, actions: [{ type: 'open_activity_monitor', target: 'other-device', dry_run: true }] }]) assert.throws(() => validate(planSchema, bad), /invalid_schema/);
  await assert.rejects(bridge.create(A, { ...fixture(), metrics: { cpu: 0.9 } }), /invalid_schema/);
});
test('cancel and expiry fail closed', async () => {
  const { bridge, store } = setup(); const r = await bridge.create(A, fixture());
  await bridge.cancel(A, r.request.request_id);
  await assert.rejects(bridge.submit(A, planFor(r)), /request_terminal/);
  await assert.rejects(bridge.event(A, r.request.request_id), /request_terminal/);
  const r2 = await bridge.create(A, fixture()); const later = new Bridge(store, () => now + 31 * 60_000);
  assert.equal((await later.read(A, r2.request.request_id)).status, 'expired');
  await assert.rejects(later.submit(A, planFor(r2)), /invalid_plan_expiry/);
});
test('MCP discovery, auth and hosted callback gate accurately report readiness', async () => {
  const { bridge } = setup(); const call = (method: string, owner: string | null = A) => rpc(bridge, owner, { jsonrpc: '2.0', id: 1, method });
  assert.ok('result' in await call('server/discover', null));
  assert.ok('error' in await call('events/list', null));
  const blocked = await call('events/subscribe'); assert.equal(blocked.error?.code, -32014); assert.equal(blocked.error?.data.reason, 'callback_transport_unverified');
  assert.equal(TOOLS.find(t => t.name === 'submit_diagnostic_plan')?.annotations.readOnlyHint, false);
  assert.ok(!TOOLS.some(t => t.name.includes('execute')));
});
test('callback classifier rejects local, special, multicast, documentation and all IPv6', () => {
  for (const address of ['127.0.0.1','10.0.0.1','169.254.169.254','172.16.0.1','192.168.1.1','100.64.0.1','198.18.0.1','192.0.2.1','198.51.100.1','203.0.113.1','224.0.0.1','255.255.255.255','::1','::ffff:127.0.0.1','2001:4860:4860::8888']) assert.equal(publicIPv4(address), false, address);
  assert.equal(publicIPv4('8.8.8.8'), true);
});
test('DNS categories distinguish unsupported IPv6 from blocked and benchmark IPv4 without weakening rejection', () => {
  assert.deepEqual(classifyAddresses([{address:'8.8.8.8',family:4},{address:'198.18.1.1',family:4},{address:'127.0.0.1',family:4},{address:'2001:4860:4860::8888',family:6},{address:'::1',family:6},{address:'invalid',family:4}]),{public_ipv4:1,non_public_ipv4:2,benchmark_ipv4:1,unsupported_ipv6:2,invalid_address:1});
  assert.deepEqual(classifyAddresses([]),{public_ipv4:0,non_public_ipv4:0,benchmark_ipv4:0,unsupported_ipv6:0,invalid_address:0});
});
test('a custom resolver receives hostname only and cannot bypass whole-answer public-address rejection',async()=>{
  let observed='';
  const post=makePinnedHttpsPost(async(hostname)=>{observed=hostname;return [{address:'8.8.8.8',family:4},{address:'198.18.1.1',family:4}];});
  await assert.rejects(post('https://receiver.example/private/callback?opaque=fixture','fixture body',{'webhook-signature':'fixture'}),/non_public_callback/);
  assert.equal(observed,'receiver.example');
  for(const addresses of [[],[{address:'2001:4860:4860::8888',family:6}],[{address:'127.0.0.1',family:4}]])await assert.rejects(makePinnedHttpsPost(async()=>addresses)('https://receiver.example','fixture',{}),/non_public_callback/);
});
test('runtime stop aborts pending DNS and rejects later resolved public addresses before callback connection',async(t)=>{
  let connects=0;t.mock.method(https,'request',()=>{connects++;throw new Error('unexpected network request');});
  const lifetime=new AbortController();let release!:(value:{address:string;family:number}[])=>void;let observedSignal:AbortSignal|undefined;
  const post=makePinnedHttpsPost(async(_hostname,signal)=>{observedSignal=signal;return new Promise(resolve=>{release=resolve;});},lifetime.signal);
  const pending=post('https://receiver.example/private','fixture',{});
  lifetime.abort();await assert.rejects(pending);assert.equal(observedSignal?.aborted,true);
  release([{address:'8.8.8.8',family:4}]);await new Promise(resolve=>setImmediate(resolve));
  await assert.rejects(post('https://receiver.example/private','fixture',{}));
  assert.equal(connects,0);
});
