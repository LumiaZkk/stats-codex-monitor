import test from 'node:test';
import assert from 'node:assert/strict';
import { CallbackAddressFault, Events, signingKey } from '../bridge/events.mts';
import type { Subscription, SafePost } from '../bridge/events.mts';
import { Bridge, Fault, EVENT_NAME, STREAM_ID } from '../bridge/core.mts';
import { MemoryStore } from '../bridge/memory-store.mts';
import { randomUUID } from 'node:crypto';
const secret = 'whsec_' + Buffer.alloc(32, 6).toString('base64');
const params = { name: EVENT_NAME, arguments: { stream_id: STREAM_ID }, delivery: { mode: 'webhook', url: 'https://receiver.example/callback', secret } };
function setup(post?: SafePost) {
  let now = Date.parse('2026-09-30T08:00:00.000Z'), allowed = true;
  const subscriptions = new Map<string, Subscription>(); let verifications = 0;
  const store = { get: async (id: string) => subscriptions.get(id) ?? null, put: async (s: Subscription) => { subscriptions.set(s.id, s); }, remove: async (id: string) => { subscriptions.delete(id); } };
  const transport: SafePost = post ?? (async (_u,b) => { verifications++; return { status: 200, body: JSON.stringify({ challenge: JSON.parse(b).challenge }) }; });
  const events = new Events(store, transport, async () => allowed, () => now);
  return { events, store, subscriptions, time: (n: number) => { now += n; }, revoke: () => { allowed = false; }, verifies: () => verifications };
}
test('subscription refresh is deterministic, finite and survives service reconstruction', async () => {
  const s = setup(); const first = await s.events.subscribe('a', params);
  const second = await s.events.subscribe('a', { ...params, ttlMs: 60_000 }); assert.equal(second.id, first.id); assert.equal(s.verifies(), 1);
  assert.equal(s.subscriptions.size, 1); assert.equal(second.refreshBefore, '2026-09-30T08:01:00.000Z');
  const recreated = new Events(s.store, async () => { throw new Error('not expected'); }, async () => true, () => Date.parse('2026-09-30T08:00:00.000Z'));
  assert.equal((await recreated.subscribe('a', params)).id, first.id);
  await recreated.unsubscribe('a', params); await recreated.unsubscribe('a', params); assert.equal(s.subscriptions.size, 0);
});
test('invalid secret, callback, failed verification and unauthorized owner never activate', async () => {
  const s = setup(async () => ({ status: 200, body: '{"challenge":"wrong"}' }));
  await assert.rejects(s.events.subscribe('a', params), /challenge_failed/); assert.equal(s.subscriptions.size, 0);
  for (const value of ['whsec_abc','plain','whsec_'+Buffer.alloc(16).toString('base64')]) assert.throws(() => signingKey(value));
  for (const url of ['http://receiver.example','https://user:pass@receiver.example','https://receiver.example:8443']) await assert.rejects(s.events.subscribe('a', { ...params, delivery: { ...params.delivery, url } }), /invalid_callback/);
  s.revoke(); await assert.rejects(s.events.subscribe('a', params), /access_revoked/);
});
test('retry preserves event ID, refreshes timestamp, filters events and stops on revocation', async () => {
  const ids: string[] = [], times: string[] = []; let calls = 0;
  const s = setup(async (_u,b,h) => { const data = JSON.parse(b); if (data.type === 'verification') return { status: 200, body: JSON.stringify({ challenge: data.challenge }) }; ids.push(h['webhook-id']); times.push(h['webhook-timestamp']); return { status: ++calls === 1 ? 503 : 202, body: '{}' }; });
  const sub = await s.events.subscribe('a', params);
  const bridge = new Bridge(new MemoryStore(), () => Date.parse('2026-09-30T08:00:00.000Z'));
  const r = await bridge.create('a', { idempotency_key: randomUUID(), fixture: 'high-cpu-v1' }); const event = await bridge.event('a', r.request.request_id);
  assert.equal((await s.events.deliver('a', sub.id, event, async () => true, async () => { s.time(2000); })).attempts, 2);
  assert.equal(ids[0], ids[1]); assert.notEqual(times[0], times[1]);
  await assert.rejects(s.events.deliver('b', sub.id, event, async () => true), /subscription_not_found/);
  await assert.rejects(s.events.deliver('a', sub.id, { ...event, data: { ...event.data, stream_id: 'wrong' } }, async () => true), /invalid_schema/);
  s.revoke(); await assert.rejects(s.events.deliver('a', sub.id, event, async () => true), /subscription_inactive/); assert.equal(s.subscriptions.size, 0);
});
test('410, 413, cancellation and expiration never retry', async () => {
  for (const status of [410,413]) {
    let sends = 0; const s = setup(async (_u,b) => { const data = JSON.parse(b); if (data.type === 'verification') return { status: 200, body: JSON.stringify({ challenge: data.challenge }) }; sends++; return { status, body: '{}' }; });
    const sub = await s.events.subscribe('a', params); const event = { eventId: 'evt_test', name: EVENT_NAME, data: { stream_id: STREAM_ID, request_id: randomUUID(), request_hash: '1'.repeat(64), synthetic: true, expires_at: '2026-09-30T08:30:00.000Z' } };
    await assert.rejects(s.events.deliver('a', sub.id, event, async () => true)); assert.equal(sends, 1);
  }
  const s = setup(); const sub = await s.events.subscribe('a', { ...params, ttlMs: 1000 }); const event = { eventId: 'evt_test', name: EVENT_NAME, data: { stream_id: STREAM_ID, request_id: randomUUID(), request_hash: '1'.repeat(64), synthetic: true, expires_at: '2026-09-30T08:30:00.000Z' } };
  await assert.rejects(s.events.deliver('a', sub.id, event, async () => false), /request_terminal/);
  s.time(1000); await assert.rejects(s.events.deliver('a', sub.id, event, async () => true), /subscription_inactive/);
});
test('subscription diagnostics expose only categorized failures, never request or response secrets', async () => {
  const cases: [unknown,string][] = [
    [new Fault('non_public_callback'),'non_public_callback'],
    [new Fault('callback_dns_failed'),'callback_dns_failed'],
    [new Fault('callback_tls_failed'),'callback_tls_failed'],
    [Object.assign(new Error(params.delivery.url+secret),{code:'ENOTFOUND'}),'callback_dns_failed'],
    [Object.assign(new Error(secret),{code:'ABORT_ERR'}),'callback_timeout'],
    [Object.assign(new Error(secret),{code:'ERR_TLS_CERT_ALTNAME_INVALID'}),'callback_tls_failed'],
    [Object.assign(new Error(secret),{code:'ECONNRESET'}),'callback_connection_failed'],
    [new Error(params.delivery.url+secret),'callback_transport_error'],
  ];
  for (const [error,reason] of cases) {
    const s=setup(async()=>{throw error;});
    await assert.rejects(s.events.subscribe('a',params),e=>e instanceof Fault && e.code===-32015 && e.reason===reason);
    assert.deepEqual(s.events.lastSubscription,{stage:'failed',reason});assert.equal(s.subscriptions.size,0);
    const diagnostic=JSON.stringify(s.events.lastSubscription);assert.ok(!diagnostic.includes(secret));assert.ok(!diagnostic.includes(params.delivery.url));
  }
});
test('HTTP, malformed JSON, mismatch and successful verification have distinct safe diagnostics', async () => {
  for (const [status,body,reason] of [[403,secret,'callback_http_error'],[200,secret,'invalid_challenge_response'],[200,'{"challenge":"wrong"}','challenge_failed']] as const) {
    const s=setup(async()=>({status,body}));await assert.rejects(s.events.subscribe('a',params));
    assert.deepEqual(s.events.lastSubscription,{stage:'failed',reason,http_status:status});
  }
  const s=setup();await s.events.subscribe('a',params);assert.deepEqual(s.events.lastSubscription,{stage:'accepted',http_status:200});
  await s.events.unsubscribe('a',params);assert.equal(s.subscriptions.size,0);assert.equal(s.events.lastSubscription?.stage,'accepted'); // Outcome evidence is retained after rollback, not an active-count claim.
  await assert.rejects(s.events.subscribe('a',{...params,delivery:{...params.delivery,secret:'bad'}}));assert.deepEqual(s.events.lastSubscription,{stage:'failed',reason:'invalid_signing_secret'});
});
test('address-policy diagnostics retain bounded category counts without address or hostname data', async () => {
  const counts={public_ipv4:1,non_public_ipv4:2,benchmark_ipv4:1,public_ipv6:2,non_public_ipv6:1,invalid_address:0};
  const e=new CallbackAddressFault({...counts,hostname:'private.invalid',address:'198.18.1.1'} as typeof counts);
  const s=setup(async()=>{throw e;});await assert.rejects(s.events.subscribe('a',params));
  assert.deepEqual(s.events.lastSubscription,{stage:'failed',reason:'non_public_callback',address_categories:counts});
  assert.ok(!JSON.stringify(s.events.lastSubscription).includes('private.invalid'));assert.ok(!JSON.stringify(s.events.lastSubscription).includes('198.18.1.1'));
  assert.equal(new CallbackAddressFault({...counts,public_ipv4:99999,non_public_ipv4:-1}).addressCategories.public_ipv4,1000);
  assert.equal(new CallbackAddressFault({...counts,non_public_ipv4:-1}).addressCategories.non_public_ipv4,0);
});
