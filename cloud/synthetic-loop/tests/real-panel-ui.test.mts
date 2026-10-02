import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { canonical, digest } from '../bridge/core.mts';
import type { RealDiagnosticBody, RealDiagnosticRequest, RealPlan, RealReceipt, RealReceiptEnvelope, RealResultBundle } from '../bridge/real-contract.mts';
import { RealPanelController, type RealPanelOptions } from '../ui/real-panel-controller.mts';
import type { RealInitial } from '../ui/real-panel-contract.mts';

const START = Date.parse('2026-10-01T10:01:35.000Z');
const bundleFixture = JSON.parse(readFileSync(new URL('../fixtures/real-result-v1.json', import.meta.url), 'utf8')) as RealResultBundle;
const receiptFixture = JSON.parse(readFileSync(new URL('../fixtures/real-receipt-v1.json', import.meta.url), 'utf8')) as RealReceiptEnvelope;
const iso = (time: number) => new Date(time).toISOString();
class Clock {
  time = START;
  sequence = 0;
  timers = new Map<number, { at: number; fn: () => void }>();
  now = () => this.time;
  set = (fn: () => void, milliseconds: number) => {
    const id = ++this.sequence;
    this.timers.set(id, { at: this.time + milliseconds, fn });
    return id as unknown as ReturnType<typeof setTimeout>;
  };
  clear = (id: ReturnType<typeof setTimeout>) => { this.timers.delete(id as unknown as number); };
  tick(milliseconds: number) {
    const until = this.time + milliseconds;
    while (true) {
      const next = [...this.timers].sort((left, right) => left[1].at - right[1].at)[0];
      if (!next || next[1].at > until) break;
      this.time = next[1].at;
      this.timers.delete(next[0]);
      next[1].fn();
    }
    this.time = until;
  }
}
function initial(lease = 1_200_000): RealInitial {
  return {
    schema_version: 2, kind: 'stats_tunnel_panel', synthetic: false,
    connection: { state: 'online', instance_id: randomUUID(), expires_at: iso(START + lease) },
    subscription_ready: true, real_enabled: true, real_subscription_ready: true, native_collection_available: true,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(init: RealInitial, options: { intentExpiry?: number; requestExpiry?: number; planExpiry?: number } = {}) {
  const request = JSON.parse(bundleFixture.request_json) as RealDiagnosticRequest;
  const body = JSON.parse(request.client_request.client_request_json) as RealDiagnosticBody;
  const intent = {
    schema_version: 1 as const, kind: 'stats_global_collection_intent' as const,
    intent_id: body.client_request_id, created_at: body.consent.confirmed_at,
    expires_at: iso(options.intentExpiry ?? Date.parse(body.consent.confirmed_at) + 600_000),
    consent_scope: 'global_diagnostics_v1' as const,
  };
  body.expires_at = iso(options.requestExpiry ?? Date.parse(intent.expires_at));
  request.expires_at = body.expires_at;
  request.client_request.client_request_json = canonical(body);
  request.client_request.client_request_hash = digest(body);
  const requestHash = digest(request);
  const plan = JSON.parse(bundleFixture.proposal_json) as RealPlan;
  plan.request_hash = requestHash;
  plan.expires_at = iso(options.planExpiry ?? Math.min(Date.parse(plan.expires_at), Date.parse(request.expires_at)));
  const planHash = digest(plan);
  const bundle: RealResultBundle = {
    schema_version: 1, kind: 'stats_real_result', request_json: canonical(request), request_hash: requestHash,
    proposal_json: canonical(plan), proposal_hash: planHash,
  };
  const receipt = JSON.parse(receiptFixture.receipt_json) as RealReceipt;
  receipt.request_hash = requestHash;
  receipt.plan_hash = planHash;
  const receiptEnvelope: RealReceiptEnvelope = { schema_version: 1, kind: 'stats_real_receipt_envelope', receipt_json: canonical(receipt), receipt_hash: digest(receipt) };
  const eventID = `evt_${randomUUID()}`;
  type Status = 'awaiting_native' | 'awaiting_consent' | 'requested' | 'proposed' | 'declined' | 'cancelled' | 'expired';
  const wrap = (status: Status = 'awaiting_native', options: { collected?: boolean; historicalPlan?: boolean; receipt?: boolean } = {}) => {
    const collected = options.collected ?? (status === 'requested' || status === 'proposed');
    const hasPlan = status === 'proposed' || options.historicalPlan || options.receipt;
    return {
      schema_version: 1 as const, kind: 'stats_global_panel_result' as const, synthetic: false as const,
      connection: { ...init.connection }, intent: { ...intent }, intent_hash: digest(intent), status,
      data: collected ? {
        request: structuredClone(request), request_hash: requestHash, event_id: eventID,
        status: status as 'requested' | 'proposed' | 'cancelled' | 'expired',
        proposal: status === 'proposed' ? structuredClone(plan) : null,
        proposal_hash: status === 'proposed' ? planHash : null,
        receipt: options.receipt ? receiptEnvelope : null,
        receipt_hash: options.receipt ? receiptEnvelope.receipt_hash : null,
        execution: 'local_approval_required' as const,
      } : null,
      result_bundle: hasPlan ? structuredClone(bundle) : null,
    };
  };
  return { wrap, intent, request, requestHash, plan, planHash, receipt };
}
type WireResult = ReturnType<ReturnType<typeof fixture>['wrap']>;
function harness(init: RealInitial, callTool: RealPanelOptions['callTool'], clock = new Clock(), options: Partial<RealPanelOptions> = {}) {
  const controller = new RealPanelController({ callTool, render: () => {}, now: clock.now, setTimer: clock.set, clearTimer: clock.clear, ...options });
  controller.receiveInitial({ structuredContent: init });
  controller.connected();
  return { controller, clock };
}
async function eventually(check: () => boolean) {
  // WebCrypto uses the worker pool and must be allowed to finish during concurrent test runs.
  const deadline = Date.now() + 5000;
  while (!check() && Date.now() < deadline) await delay(1);
  assert.ok(check(), 'expected asynchronous real-panel state transition');
}

test('real panel retains the browser timer receiver and clears its startup timer', () => {
  const originalSet = globalThis.setTimeout, originalClear = globalThis.clearTimeout;
  let scheduled = 0, cleared = 0;
  globalThis.setTimeout = function (this: unknown, _callback: () => void, _milliseconds: number) {
    assert.equal(this, globalThis); scheduled++; return 456 as unknown as ReturnType<typeof setTimeout>;
  } as typeof setTimeout;
  globalThis.clearTimeout = function (this: unknown, id: ReturnType<typeof setTimeout>) {
    assert.equal(this, globalThis); assert.equal(id, 456); cleared++;
  } as typeof clearTimeout;
  try {
    const controller = new RealPanelController({ callTool: async () => ({}), render: () => {} });
    controller.dispose(); assert.equal(scheduled, 1); assert.equal(cleared, 1);
  } finally { globalThis.setTimeout = originalSet; globalThis.clearTimeout = originalClear; }
});

test('real collection needs a connected host, initial data and an explicit create action', async () => {
  const clock = new Clock(), init = initial(); let calls = 0;
  const controller = new RealPanelController({ callTool: async () => { calls++; return {}; }, render: () => {}, now: clock.now, setTimer: clock.set, clearTimer: clock.clear });
  controller.receiveInitial({ structuredContent: init });
  await controller.create(); assert.equal(calls, 0); assert.equal(controller.state.canCreate, false);
  controller.connected(); assert.equal(controller.state.phase, 'ready'); assert.equal(controller.state.canCreate, true); assert.equal(calls, 0);
  controller.receiveInitial({ structuredContent: init }); assert.equal(controller.state.phase, 'ready'); assert.equal(calls, 0);
  controller.dispose(); assert.equal(clock.timers.size, 0);
});

test('real collection is gated by real scope, event subscriptions and native availability', async () => {
  for (const field of ['real_enabled', 'real_subscription_ready', 'native_collection_available'] as const) {
    const init = initial(); init[field] = false;
    if (field === 'real_enabled') init.synthetic = true;
    let calls = 0;
    const { controller } = harness(init, async () => { calls++; return {}; });
    await controller.create(); assert.equal(calls, 0, field); assert.equal(controller.state.canCreate, false, field);
    controller.dispose();
  }
});

test('explicit readiness refresh enables collection without extending the runtime lease or starting a request', async () => {
  const init = initial(); init.real_subscription_ready = false; init.native_collection_available = false;
  const fresh = { ...init, real_subscription_ready: true, native_collection_available: true };
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const { controller, clock } = harness(init, async (name, args) => { calls.push({ name, args }); return { structuredContent: fresh }; });
  assert.equal(controller.state.canCreate, false); assert.equal(controller.state.canRefresh, true);
  controller.receiveInitial({ structuredContent: fresh }); assert.equal(controller.state.canCreate, false);
  clock.tick(10_000); assert.equal(calls.length, 0);
  await controller.refresh();
  assert.deepEqual(calls, [{ name: 'open_diagnostic_panel', args: {} }]);
  assert.equal(controller.state.phase, 'ready'); assert.equal(controller.state.canCreate, true); assert.equal(controller.state.refreshing, false);
  assert.deepEqual(controller.state.initial?.connection, init.connection); assert.equal(controller.state.result, null);
  assert.equal(clock.timers.size, 1); clock.tick(10_000); assert.equal(calls.length, 1); controller.dispose();
});

test('duplicate readiness refresh clicks make one request and block creation while pending', async () => {
  const init = initial(), pending = deferred<{ structuredContent: RealInitial }>(); let calls = 0;
  const { controller } = harness(init, async () => { calls++; return pending.promise; });
  const refreshing = controller.refresh();
  assert.equal(controller.state.refreshing, true); assert.equal(controller.state.canRefresh, false); assert.equal(controller.state.canCreate, false);
  await controller.refresh(); await controller.create(); assert.equal(calls, 1);
  pending.resolve({ structuredContent: init }); await refreshing;
  assert.equal(controller.state.refreshing, false); assert.equal(controller.state.canRefresh, true); assert.equal(controller.state.canCreate, true);
  controller.dispose();
});

test('failed readiness refresh can only retry through another explicit refresh', async () => {
  const init = initial(); init.native_collection_available = false;
  const fresh = { ...init, native_collection_available: true }; let calls = 0;
  const { controller, clock } = harness(init, async () => {
    if (++calls === 1) throw new Error('refresh response lost'); return { structuredContent: fresh };
  });
  await controller.refresh();
  assert.equal(controller.state.phase, 'unconfirmed'); assert.equal(controller.state.reason, 'refresh_unconfirmed');
  assert.equal(controller.state.refreshing, false); assert.equal(controller.state.canRefresh, true); assert.equal(controller.state.canRetry, false);
  await controller.retry(); clock.tick(30_000); assert.equal(calls, 1);
  await controller.refresh(); assert.equal(calls, 2); assert.equal(controller.state.phase, 'ready'); assert.equal(controller.state.canCreate, true);
  controller.dispose();
});

test('readiness refresh cannot switch the pinned runtime identity or expiry', async () => {
  for (const field of ['instance_id', 'expires_at'] as const) {
    const init = initial(), changed = structuredClone(init);
    changed.connection[field] = field === 'instance_id' ? randomUUID() : iso(START + 3_600_000);
    const { controller, clock } = harness(init, async () => ({ structuredContent: changed }));
    await controller.refresh();
    assert.equal(controller.state.phase, 'invalid'); assert.equal(controller.state.canCreate, false); assert.equal(controller.state.canRefresh, false);
    assert.deepEqual(controller.state.initial?.connection, init.connection); assert.equal(clock.timers.size, 0); controller.dispose();
  }
});

test('readiness refresh is unavailable throughout an active collection and during creation', async () => {
  for (const status of ['awaiting_native', 'awaiting_consent', 'requested', 'proposed'] as const) {
    const init = initial(), { wrap } = fixture(init); let calls = 0;
    const { controller } = harness(init, async () => { calls++; return { structuredContent: wrap(status) }; });
    await controller.create(); assert.equal(controller.state.canRefresh, false);
    await controller.refresh(); assert.equal(calls, 1); controller.dispose();
  }
  const init = initial(), { wrap } = fixture(init), pending = deferred<{ structuredContent: WireResult }>(); let calls = 0;
  const { controller } = harness(init, async () => { calls++; return pending.promise; });
  const creating = controller.create(); await controller.refresh(); assert.equal(calls, 1);
  pending.resolve({ structuredContent: wrap() }); await creating; controller.dispose();
});

test('late readiness refresh cannot restore the panel after disconnect, teardown or lease expiry', async () => {
  for (const stop of ['disconnect', 'dispose', 'expiry'] as const) {
    const init = initial(3000); init.native_collection_available = false;
    const pending = deferred<{ structuredContent: RealInitial }>();
    const { controller, clock } = harness(init, () => pending.promise);
    const refreshing = controller.refresh();
    if (stop === 'disconnect') controller.offline(); else if (stop === 'dispose') controller.dispose(); else clock.tick(3000);
    pending.resolve({ structuredContent: { ...init, native_collection_available: true } }); await refreshing;
    assert.equal(controller.state.phase, stop === 'dispose' ? 'disposed' : 'offline');
    assert.equal(controller.state.initial?.native_collection_available, false); assert.equal(controller.state.refreshing, false);
    assert.equal(controller.state.canRefresh, false); assert.equal(controller.state.canCreate, false); assert.equal(clock.timers.size, 0);
  }
});

test('missing initial data and a changed initial runtime fail without starting collection', () => {
  const clock = new Clock();
  const controller = new RealPanelController({ callTool: async () => ({}), render: () => {}, now: clock.now, setTimer: clock.set, clearTimer: clock.clear });
  controller.connected(); clock.tick(15_000);
  assert.equal(controller.state.phase, 'offline'); assert.equal(clock.timers.size, 0);
  controller.receiveInitial({ structuredContent: initial() }); assert.equal(controller.state.phase, 'offline');
  const init = initial(), another = harness(init, async () => ({}));
  another.controller.receiveInitial({ structuredContent: { ...init, connection: { ...init.connection, instance_id: randomUUID() } } });
  assert.equal(another.controller.state.phase, 'invalid'); assert.equal(another.clock.timers.size, 0);
});

test('duplicate real collection clicks make one call and uncertain retry reuses the exact key', async () => {
  const init = initial(), { wrap } = fixture(init), pending = deferred<{ structuredContent: WireResult }>();
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  let generated = 0; const key = randomUUID();
  const { controller, clock } = harness(init, async (name, args) => {
    calls.push({ name, args }); return calls.length === 1 ? pending.promise : { structuredContent: wrap() };
  }, new Clock(), { uuid: () => { generated++; return key; } });
  const creating = controller.create(); await controller.create();
  assert.deepEqual(calls, [{ name: 'panel_request_global_diagnostic', args: { expected_instance_id: init.connection.instance_id, idempotency_key: key } }]);
  assert.equal(controller.state.canCancel, false);
  pending.reject(new Error('response lost')); await creating;
  assert.equal(controller.state.phase, 'unconfirmed'); assert.equal(controller.state.canRetry, true); assert.equal(controller.state.canCreate, false);
  clock.tick(10_000); assert.equal(calls.length, 1);
  await controller.retry(); assert.equal(controller.state.phase, 'awaiting_native'); assert.equal(generated, 1);
  assert.deepEqual(calls[1], calls[0]); controller.dispose();
});

test('real panel polls the exact intent through consent, request, proposal and verified receipt', async () => {
  const init = initial(), { wrap, intent } = fixture(init);
  const states = [wrap(), wrap('awaiting_consent'), wrap('requested'), wrap('proposed'), wrap('proposed', { receipt: true })];
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const { controller, clock } = harness(init, async (name, args) => {
    calls.push({ name, args }); return { structuredContent: states[calls.length - 1] };
  });
  await controller.create(); assert.equal(controller.state.phase, 'awaiting_native');
  for (const expected of ['awaiting_consent', 'waiting', 'proposed', 'complete']) {
    const before = calls.length; clock.tick(4999); assert.equal(calls.length, before); clock.tick(1);
    await eventually(() => controller.state.phase === expected);
    assert.deepEqual(calls.at(-1), { name: 'panel_get_global_diagnostic', args: { expected_instance_id: init.connection.instance_id, intent_id: intent.intent_id, intent_hash: digest(intent) } });
    assert.equal(controller.state.canCreate, expected === 'complete');
  }
  assert.equal(controller.state.result?.parsedReceipt?.outcome, 'quit_confirmed');
  assert.equal(controller.state.canCancel, false);
  clock.tick(30_000); assert.equal(calls.length, 5); controller.dispose();
});

test('a verified native receipt stays complete even when the outer request is cancelled or expired', async () => {
  for (const status of ['cancelled', 'expired'] as const) {
    const init = initial(), { wrap } = fixture(init, status === 'expired' ? { planExpiry: START - 1000 } : {});
    let calls = 0;
    const { controller, clock } = harness(init, async () => {
      calls++; return { structuredContent: wrap(status, { collected: true, historicalPlan: true, receipt: true }) };
    });
    await controller.create();
    assert.equal(controller.state.phase, 'complete'); assert.equal(controller.state.result?.status, status);
    assert.equal(controller.state.result?.parsedReceipt?.outcome, 'quit_confirmed');
    assert.equal(controller.state.canCancel, false); assert.equal(controller.state.canRetry, false);
    clock.tick(30_000); assert.equal(calls, 1); controller.dispose();
  }
});

test('an unbound receipt cannot mark a proposed operation complete', async () => {
  const init = initial(), { wrap } = fixture(init), invalid = wrap('proposed', { receipt: true });
  const receipt = JSON.parse(invalid.data!.receipt!.receipt_json) as RealReceipt;
  receipt.request_id = randomUUID();
  invalid.data!.receipt!.receipt_json = canonical(receipt);
  invalid.data!.receipt!.receipt_hash = digest(receipt);
  invalid.data!.receipt_hash = digest(receipt);
  let calls = 0;
  const { controller, clock } = harness(init, async () => ({ structuredContent: ++calls === 1 ? wrap('proposed') : invalid }));
  await controller.create(); clock.tick(5000); await eventually(() => controller.state.phase === 'invalid');
  assert.equal(controller.state.result?.parsedReceipt, null); assert.equal(controller.state.canRetry, false);
  assert.equal(clock.timers.size, 0); controller.dispose();
});

test('a failed bound read stops polling and retry repeats the same read', async () => {
  const init = initial(), { wrap } = fixture(init), calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const { controller, clock } = harness(init, async (name, args) => {
    calls.push({ name, args }); if (calls.length === 2) throw new Error('network unavailable');
    return { structuredContent: wrap(calls.length === 1 ? 'awaiting_native' : 'awaiting_consent') };
  });
  await controller.create(); clock.tick(5000); await eventually(() => controller.state.phase === 'unconfirmed');
  assert.equal(controller.state.canRetry, true); assert.equal(controller.state.canCancel, true);
  clock.tick(20_000); assert.equal(calls.length, 2); await controller.retry();
  assert.deepEqual(calls[2], calls[1]); assert.equal(controller.state.phase, 'awaiting_consent'); controller.dispose();
});

test('runtime, lease and intent changes in tool replies permanently stop the real panel', async () => {
  const init = initial(), { wrap } = fixture(init);
  const mutations = [
    (value: WireResult) => { value.connection.instance_id = randomUUID(); },
    (value: WireResult) => { value.connection.expires_at = iso(START + 3_600_000); },
    (value: WireResult) => { value.intent.intent_id = randomUUID(); value.intent_hash = digest(value.intent); },
    (value: WireResult) => { value.intent_hash = '0'.repeat(64); },
  ];
  for (const mutate of mutations) {
    let calls = 0; const bad = wrap('awaiting_consent'); mutate(bad);
    const { controller, clock } = harness(init, async () => ({ structuredContent: ++calls === 1 ? wrap() : bad }));
    await controller.create(); clock.tick(5000); await eventually(() => controller.state.phase === 'invalid');
    assert.equal(controller.state.canRetry, false); assert.equal(clock.timers.size, 0);
    await controller.retry(); await controller.create(); assert.equal(calls, 2); controller.dispose();
  }
});

test('a collected request and observed proposal cannot disappear or be replaced by later polls', async () => {
  const init = initial(), { wrap } = fixture(init);
  const replacement = wrap('requested');
  replacement.data!.request.request_id = randomUUID(); replacement.data!.request_hash = digest(replacement.data!.request);
  const differentPlan = wrap('proposed');
  differentPlan.data!.proposal!.summary = 'Different content with a valid new hash';
  differentPlan.data!.proposal_hash = digest(differentPlan.data!.proposal);
  differentPlan.result_bundle!.proposal_json = canonical(differentPlan.data!.proposal);
  differentPlan.result_bundle!.proposal_hash = differentPlan.data!.proposal_hash!;
  for (const [first, later] of [
    [wrap('requested'), wrap('awaiting_consent')],
    [wrap('requested'), replacement],
    [wrap('proposed'), wrap('requested')],
    [wrap('proposed'), differentPlan],
  ]) {
    let calls = 0;
    const { controller, clock } = harness(init, async () => ({ structuredContent: ++calls === 1 ? first : later }));
    await controller.create(); assert.notEqual(controller.state.phase, 'invalid');
    clock.tick(5000); await eventually(() => controller.state.phase === 'invalid');
    assert.equal(clock.timers.size, 0); assert.equal(controller.state.canRetry, false); controller.dispose();
  }
});

test('native decline ends collection without reporting an execution receipt', async () => {
  const init = initial(), { wrap } = fixture(init); let calls = 0;
  const { controller, clock } = harness(init, async () => ({ structuredContent: ++calls === 1 ? wrap() : wrap('declined') }));
  await controller.create(); clock.tick(5000); await eventually(() => controller.state.phase === 'declined');
  assert.equal(controller.state.result?.parsedReceipt, null); assert.equal(controller.state.canCreate, true); assert.equal(controller.state.canCancel, false);
  clock.tick(30_000); assert.equal(calls, 2); controller.dispose();
});

test('confirmed cancellation supersedes an in-flight read and late data cannot restore collection', async () => {
  const init = initial(), { wrap, intent } = fixture(init), pending = deferred<{ structuredContent: WireResult }>();
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const { controller, clock } = harness(init, async (name, args) => {
    calls.push({ name, args });
    if (name === 'panel_get_global_diagnostic') return pending.promise;
    return { structuredContent: wrap(name === 'panel_cancel_global_diagnostic' ? 'cancelled' : 'awaiting_native') };
  });
  await controller.create(); clock.tick(5000); assert.equal(calls.length, 2);
  await controller.cancel(); assert.equal(controller.state.phase, 'cancelled');
  assert.deepEqual(calls[2], { name: 'panel_cancel_global_diagnostic', args: { expected_instance_id: init.connection.instance_id, intent_id: intent.intent_id, intent_hash: digest(intent) } });
  pending.resolve({ structuredContent: wrap('requested') }); await delay(10);
  clock.tick(30_000); assert.equal(calls.length, 3); assert.equal(controller.state.phase, 'cancelled'); controller.dispose();
});

test('cancellation after a proposal keeps bounded receipt polling and preserves truthful native observations', async () => {
  const init = initial(), { wrap, intent } = fixture(init, { planExpiry: START + 2000 });
  const cancelled = wrap('cancelled', { collected: true, historicalPlan: true });
  const completed = wrap('cancelled', { collected: true, historicalPlan: true, receipt: true });
  const receipt = JSON.parse(completed.data!.receipt!.receipt_json) as RealReceipt;
  receipt.outcome = 'cancelled';
  completed.data!.receipt!.receipt_json = canonical(receipt);
  completed.data!.receipt!.receipt_hash = digest(receipt);
  completed.data!.receipt_hash = digest(receipt);
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const { controller, clock } = harness(init, async (name, args) => {
    calls.push({ name, args });
    return { structuredContent: name === 'panel_request_global_diagnostic' ? wrap('proposed') : name === 'panel_cancel_global_diagnostic' ? cancelled : completed };
  });
  await controller.create(); await controller.cancel();
  assert.equal(controller.state.phase, 'proposed'); assert.equal(controller.state.result?.status, 'cancelled');
  assert.equal(controller.state.canCreate, false); assert.equal(controller.state.canCancel, false); assert.equal(Boolean(controller.state.result?.parsedReceipt), false);
  await controller.cancel(); assert.equal(calls.length, 2);
  clock.tick(2000); assert.equal(controller.state.phase, 'proposed');
  clock.tick(3000); await eventually(() => controller.state.phase === 'complete');
  const binding = { expected_instance_id: init.connection.instance_id, intent_id: intent.intent_id, intent_hash: digest(intent) };
  assert.deepEqual(calls[1], { name: 'panel_cancel_global_diagnostic', args: binding });
  assert.deepEqual(calls[2], { name: 'panel_get_global_diagnostic', args: binding });
  assert.equal(controller.state.result?.parsedReceipt?.outcome, 'cancelled');
  assert.equal(controller.state.result?.parsedReceipt?.process_exit_confirmed, true);
  assert.ok(controller.state.result?.parsedReceipt?.before); assert.ok(controller.state.result?.parsedReceipt?.after);
  clock.tick(30_000); assert.equal(calls.length, 3); controller.dispose();
});

test('cancellation is unconfirmed on a tool error and retries only the exact cancellation', async () => {
  const init = initial(), { wrap } = fixture(init), calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const { controller, clock } = harness(init, async (name, args) => {
    calls.push({ name, args }); return calls.length === 2 ? { isError: true } : { structuredContent: wrap(calls.length === 1 ? 'awaiting_native' : 'cancelled') };
  });
  await controller.create(); await controller.cancel(); assert.equal(controller.state.phase, 'unconfirmed');
  assert.equal(controller.state.canCancel, false); assert.equal(controller.state.canRetry, true);
  clock.tick(15_000); assert.equal(calls.length, 2); await controller.retry();
  assert.equal(controller.state.phase, 'cancelled'); assert.deepEqual(calls[2], calls[1]); controller.dispose();
  const another = harness(init, async () => ({ structuredContent: wrap() }));
  await another.controller.create(); await another.controller.cancel();
  assert.equal(another.controller.state.phase, 'invalid'); assert.equal(another.clock.timers.size, 0);
});

test('runtime lease expiry rejects a pending collection response and clears all timers', async () => {
  const init = initial(3000), { wrap } = fixture(init, { intentExpiry: START + 3000 }), pending = deferred<{ structuredContent: WireResult }>();
  const { controller, clock } = harness(init, () => pending.promise);
  const creating = controller.create(); clock.tick(3000);
  assert.equal(controller.state.phase, 'offline'); pending.resolve({ structuredContent: wrap() }); await creating;
  assert.equal(controller.state.phase, 'offline'); assert.equal(controller.state.result, null); assert.equal(clock.timers.size, 0);
});

test('collection intent and unplanned request expiry stop polling before the runtime lease', async () => {
  const init = initial();
  for (const stage of ['awaiting_native', 'requested'] as const) {
    const { wrap } = fixture(init, { intentExpiry: START + 2000, requestExpiry: START + 2000 }); let calls = 0;
    const { controller, clock } = harness(init, async () => { calls++; return { structuredContent: wrap(stage) }; });
    await controller.create(); assert.equal(controller.state.phase, stage === 'requested' ? 'waiting' : stage);
    clock.tick(2000); assert.equal(controller.state.phase, 'expired'); assert.equal(controller.state.canCancel, false);
    clock.tick(30_000); assert.equal(calls, 1); assert.equal(controller.state.canCreate, true); controller.dispose();
  }
});

test('a historical plan keeps receipt polling alive after plan expiry and can complete from a bound receipt', async () => {
  const init = initial(), { wrap } = fixture(init, { planExpiry: START + 2000 }); let calls = 0;
  const { controller, clock } = harness(init, async () => {
    calls++;
    return { structuredContent: calls === 1 ? wrap('proposed') : wrap('expired', { collected: true, historicalPlan: true, receipt: calls === 3 }) };
  });
  await controller.create(); assert.equal(controller.state.phase, 'proposed');
  clock.tick(2000); assert.equal(controller.state.phase, 'proposed'); assert.equal(calls, 1);
  clock.tick(3000); await eventually(() => controller.state.result?.status === 'expired');
  assert.equal(controller.state.phase, 'proposed'); assert.ok(controller.state.result?.parsedPlan); assert.equal(controller.state.canCreate, false);
  clock.tick(5000); await eventually(() => controller.state.phase === 'complete');
  assert.equal(controller.state.result?.parsedReceipt?.process_exit_confirmed, true);
  clock.tick(30_000); assert.equal(calls, 3); controller.dispose();
});

test('receipt polling has a finite 180-second grace period and cannot outlive the runtime lease', async () => {
  for (const lease of [60_000, 1_200_000]) {
    const init = initial(lease), { wrap } = fixture(init, { intentExpiry: Math.min(START + lease, START + 500_000), planExpiry: START + 2000 });
    const pending = deferred<{ structuredContent: WireResult }>(); let calls = 0;
    const { controller, clock } = harness(init, async () => ++calls === 1 ? { structuredContent: wrap('proposed') } : pending.promise);
    await controller.create(); const limit = Math.min(lease, 182_000);
    clock.tick(limit - 1); assert.equal(controller.state.phase, 'proposed');
    clock.tick(1); assert.equal(controller.state.phase, lease < 182_000 ? 'offline' : 'expired');
    assert.equal(controller.state.reason, lease < 182_000 ? 'lease_expired' : 'receipt_window_expired');
    pending.resolve({ structuredContent: wrap('expired', { collected: true, historicalPlan: true }) }); await delay(10);
    const terminal = controller.state.phase; clock.tick(30_000); assert.equal(controller.state.phase, terminal); assert.equal(calls, 2);
    controller.dispose(); assert.equal(clock.timers.size, 0);
  }
});

test('host disconnect and teardown stop timers and ignore an outstanding real tool response', async () => {
  for (const terminal of ['offline', 'disposed'] as const) {
    const init = initial(), { wrap } = fixture(init), pending = deferred<{ structuredContent: WireResult }>();
    const { controller, clock } = harness(init, () => pending.promise);
    const creating = controller.create();
    if (terminal === 'offline') controller.offline(); else controller.dispose();
    assert.equal(clock.timers.size, 0); pending.resolve({ structuredContent: wrap('requested') }); await creating;
    assert.equal(controller.state.phase, terminal); assert.equal(controller.state.result, null); assert.equal(controller.state.canCreate, false);
    controller.connected(); controller.receiveInitial({ structuredContent: init });
    assert.equal(controller.state.phase, terminal); assert.equal(clock.timers.size, 0);
  }
});
