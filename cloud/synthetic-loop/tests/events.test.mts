import test from 'node:test';
import assert from 'node:assert/strict';
import { Events, signingKey } from '../bridge/events.mts';
import type { Subscription, SafePost } from '../bridge/events.mts';
import { Bridge, EVENT_NAME, STREAM_ID } from '../bridge/core.mts';
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
