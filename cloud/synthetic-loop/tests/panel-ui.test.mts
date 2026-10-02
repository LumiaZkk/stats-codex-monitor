import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setImmediate, setTimeout as delay } from 'node:timers/promises';
import { Bridge, digest as serverDigest } from '../bridge/core.mts';
import { MemoryStore } from '../bridge/memory-store.mts';
import { PanelController, type PanelOptions } from '../ui/panel-controller.mts';
import { digest, readInitial, readResult, type Initial, type Result, type Data } from '../ui/panel-contract.mts';
import { installPanel, type PanelApp } from '../ui/panel-view.mts';
import { PANEL_SCRIPT, PANEL_BUILD_HASH, PANEL_HTML, PANEL_CONTENT_HASH, PANEL_URI, panelResource } from '../ui/panel-resource.mts';

const START = Date.parse('2026-10-01T15:00:00.000Z');
test('default browser timers retain the global receiver during startup and teardown',()=>{
  const originalSet=globalThis.setTimeout,originalClear=globalThis.clearTimeout;
  let scheduled=0,cleared=0;
  globalThis.setTimeout=function(this:unknown,_callback:()=>void,_delay:number){
    assert.equal(this,globalThis,'Browser timer receiver must be Window, not PanelController');
    scheduled++;return 123 as unknown as ReturnType<typeof setTimeout>;
  } as typeof setTimeout;
  globalThis.clearTimeout=function(this:unknown,id:ReturnType<typeof setTimeout>){
    assert.equal(this,globalThis);assert.equal(id,123);cleared++;
  } as typeof clearTimeout;
  try{
    const panel=new PanelController({callTool:async()=>({}),render:()=>{}});
    assert.equal(panel.state.phase,'booting');panel.dispose();
    assert.equal(scheduled,1);assert.equal(cleared,1);
  }finally{globalThis.setTimeout=originalSet;globalThis.clearTimeout=originalClear;}
});
class Clock {
  time = START; sequence = 0; timers = new Map<number, { at: number; fn: () => void }>();
  now = () => this.time;
  set = (fn: () => void, delay: number) => { const id = ++this.sequence; this.timers.set(id, { at: this.time + delay, fn }); return id as unknown as ReturnType<typeof setTimeout>; };
  clear = (id: ReturnType<typeof setTimeout>) => { this.timers.delete(id as unknown as number); };
  tick(ms: number) {
    const until = this.time + ms;
    while (true) {
      const next = [...this.timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > until) break;
      this.time = next[1].at; this.timers.delete(next[0]); next[1].fn();
    }
    this.time = until;
  }
}
const initial = (lease = 120_000): Initial => ({ schema_version: 1, kind: 'stats_tunnel_panel', synthetic: true, connection: { state: 'online', instance_id: randomUUID(), expires_at: new Date(START + lease).toISOString() }, subscription_ready: true });
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function fixture(init: Initial) {
  const bridge = new Bridge(new MemoryStore(), () => START);
  const data = await bridge.create('test-owner', { idempotency_key: randomUUID(), fixture: 'high-cpu-v1' }) as Data;
  const wrap = (value: Data = data): Result => ({ schema_version: 1, kind: 'stats_tunnel_panel_result', synthetic: true, connection: init.connection, data: value, receipt: null });
  return { data, wrap, bridge };
}
function harness(init: Initial, callTool: PanelOptions['callTool'], clock = new Clock()) {
  const controller = new PanelController({ callTool, render: () => {}, now: clock.now, setTimer: clock.set, clearTimer: clock.clear });
  controller.receiveInitial({ structuredContent: init }); controller.connected(); return { controller, clock };
}
async function eventually(check: () => boolean) {
  // WebCrypto completes on the worker pool; give it wall-clock time under the full concurrent suite.
  const deadline = Date.now() + 5000;
  while (!check() && Date.now() < deadline) await delay(1);
  assert.ok(check(), 'expected asynchronous state transition');
}

test('browser canonical WebCrypto hashes match the server and validate a schema-1 dry-run plan', async () => {
  const init = initial(), { data, wrap, bridge } = await fixture(init);
  assert.equal(await digest(data.request), serverDigest(data.request));
  const plan = { schema_version: 1, request_id: data.request.request_id, request_hash: data.request_hash, plan_id: randomUUID(), expires_at: new Date(START + 60_000).toISOString(), dry_run: true, summary: '<script>inert text</script>', actions: [{ type: 'observe_metrics', metrics: ['cpu_utilization'], duration_seconds: 60, dry_run: true }] };
  const proposed = await bridge.submit('test-owner', plan) as Data;
  const parsed = await readResult(wrap(proposed), START, init.connection, { request_id: data.request.request_id, request_hash: data.request_hash });
  assert.equal(parsed.data.proposal?.summary, plan.summary); assert.equal(parsed.receipt, null);
});

test('initial identity, canonical timestamp, lease, schema and unexpected real fields fail closed', () => {
  const good = initial();
  for (const mutate of [
    (value: any) => { value.connection.instance_id = 'other'; },
    (value: any) => { value.connection.expires_at = '2026-10-01T15:10:00Z'; },
    (value: any) => { value.connection.expires_at = new Date(START).toISOString(); },
    (value: any) => { value.schema_version = 2; },
    (value: any) => { value.real_telemetry = {}; },
    (value: any) => { value.synthetic = false; },
  ]) { const input = structuredClone(good); mutate(input); assert.throws(() => readInitial(input, START)); }
});

test('result rejects changed runtime, binding, synthetic fixture, hashes, receipt and extra fields', async () => {
  const init = initial(), { data, wrap } = await fixture(init);
  const binding = { request_id: data.request.request_id, request_hash: data.request_hash };
  const changes = [
    (value: any) => { value.connection.instance_id = randomUUID(); },
    (value: any) => { value.data.request.request_id = randomUUID(); value.data.request_hash = serverDigest(value.data.request); },
    (value: any) => { value.data.request.snapshot.cpu_utilization = 0.4; value.data.request_hash = serverDigest(value.data.request); },
    (value: any) => { value.data.request_hash = '0'.repeat(64); },
    (value: any) => { value.receipt = { executed: true }; },
    (value: any) => { value.data.execution = 'completed'; },
    (value: any) => { value.data.request.client_request = {}; },
    (value: any) => { value.data.real_reading = {}; },
  ];
  for (const change of changes) { const input = structuredClone(wrap()); change(input); await assert.rejects(readResult(input, START, init.connection, binding)); }
});

test('plan allowlist rejects non-dry-run, shell actions, duplicate metrics, wrong binding and bad proposal hash', async () => {
  const init = initial(), { data, wrap, bridge } = await fixture(init);
  const proposal = { schema_version: 1, request_id: data.request.request_id, request_hash: data.request_hash, plan_id: randomUUID(), expires_at: new Date(START + 60_000).toISOString(), dry_run: true, summary: '模拟观察', actions: [{ type: 'observe_metrics', metrics: ['cpu_utilization'], duration_seconds: 60, dry_run: true }] };
  const proposed = await bridge.submit('test-owner', proposal) as Data;
  for (const change of [
    (plan: any) => { plan.dry_run = false; },
    (plan: any) => { plan.actions = [{ type: 'shell', command: 'echo unsafe', dry_run: true }]; },
    (plan: any) => { plan.actions[0].metrics = ['cpu_utilization', 'cpu_utilization']; },
    (plan: any) => { plan.actions[0].duration_seconds = 3600; },
    (plan: any) => { plan.request_hash = '0'.repeat(64); },
    (plan: any) => { plan.request_id = randomUUID(); },
    (plan: any) => { plan.schema_version = 2; },
    (plan: any) => { plan.expires_at = new Date(START).toISOString(); },
  ]) {
    const input = structuredClone(wrap(proposed)); change(input.data.proposal); input.data.proposal_hash = serverDigest(input.data.proposal);
    await assert.rejects(readResult(input, START, init.connection, null));
  }
  const badHash = structuredClone(wrap(proposed)); badHash.data.proposal_hash = 'f'.repeat(64);
  await assert.rejects(readResult(badHash, START, init.connection, null));
});

test('initial result before connect is retained and no request happens automatically', () => {
  const init = initial(), clock = new Clock(); let calls = 0;
  const controller = new PanelController({ callTool: async () => { calls++; return {}; }, render: () => {}, now: clock.now, setTimer: clock.set, clearTimer: clock.clear });
  controller.receiveInitial({ structuredContent: init }); assert.equal(controller.state.canCreate, false);
  controller.connected(); assert.equal(controller.state.canCreate, true); assert.equal(calls, 0);
  controller.dispose(); assert.equal(clock.timers.size, 0);
});

test('subscription not ready disables create and repeated initial notifications cannot switch runtime', async () => {
  const init = initial(); init.subscription_ready = false; let calls = 0;
  const { controller } = harness(init, async () => { calls++; return {}; });
  await controller.create(); assert.equal(calls, 0); assert.equal(controller.state.canCreate, false);
  controller.receiveInitial({ structuredContent: initial() }); assert.equal(controller.state.phase, 'invalid');
});

test('a completed host handshake without the initial runtime result expires honestly', () => {
  const clock = new Clock();
  const controller = new PanelController({ callTool: async () => ({}), render: () => {}, now: clock.now, setTimer: clock.set, clearTimer: clock.clear });
  controller.connected(); clock.tick(15000);
  assert.equal(controller.state.phase, 'offline'); assert.equal(controller.state.canCreate, false); assert.equal(clock.timers.size, 0);
});

test('double clicks make one request; network-uncertain retry reuses the exact idempotency key', async () => {
  const init = initial(), { wrap } = await fixture(init), pending = deferred<{ structuredContent: Result }>();
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const { controller, clock } = harness(init, async (name, args) => { calls.push({ name, args }); return calls.length === 1 ? pending.promise : { structuredContent: wrap() }; });
  const first = controller.create(); await controller.create(); assert.equal(calls.length, 1);
  assert.equal(controller.state.canCancel, false); pending.reject(new Error('network response lost')); await first;
  assert.equal(controller.state.phase, 'unconfirmed'); assert.equal(controller.state.canCreate, false);
  clock.tick(10_000); assert.equal(calls.length, 1);
  await controller.retry(); assert.equal(calls.length, 2); assert.deepEqual(calls[0], calls[1]);
  assert.equal(controller.state.phase, 'waiting'); controller.dispose();
});

test('polls only the bound active request every five seconds and stops on a validated proposal', async () => {
  const init = initial(), { data, wrap, bridge } = await fixture(init); let calls = 0;
  const proposed = await bridge.submit('test-owner', { schema_version: 1, request_id: data.request.request_id, request_hash: data.request_hash, plan_id: randomUUID(), expires_at: new Date(START + 60_000).toISOString(), dry_run: true, summary: '仅模拟', actions: [{ type: 'open_activity_monitor', target: 'current_device', dry_run: true }] }) as Data;
  const { controller, clock } = harness(init, async (name, args) => {
    calls++; if (calls === 1) return { structuredContent: wrap() };
    assert.equal(name, 'panel_get_synthetic_result'); assert.deepEqual(args, { expected_instance_id: init.connection.instance_id, request_id: data.request.request_id, request_hash: data.request_hash });
    return { structuredContent: wrap(proposed) };
  });
  await controller.create(); clock.tick(4999); assert.equal(calls, 1); clock.tick(1);
  await eventually(() => controller.state.phase === 'proposed'); clock.tick(20_000); assert.equal(calls, 2); controller.dispose();
});

test('poll failure becomes unconfirmed and stops automatic work', async () => {
  const init = initial(), { wrap } = await fixture(init); let calls = 0;
  const { controller, clock } = harness(init, async () => { if (++calls === 1) return { structuredContent: wrap() }; throw new Error('offline'); });
  await controller.create(); clock.tick(5000); await eventually(() => controller.state.phase === 'unconfirmed');
  clock.tick(50_000); assert.equal(calls, 2); assert.equal(controller.state.canRetry, true); controller.dispose();
});

test('earliest runtime lease expiry stops calls and rejects a late create response', async () => {
  const init = initial(3000), { wrap } = await fixture(init), pending = deferred<{ structuredContent: Result }>();
  const { controller, clock } = harness(init, () => pending.promise);
  const creating = controller.create(); clock.tick(3000); assert.equal(controller.state.phase, 'offline');
  pending.resolve({ structuredContent: wrap() }); await creating;
  assert.equal(controller.state.phase, 'offline'); assert.equal(controller.state.data, null); assert.equal(clock.timers.size, 0);
});

test('the initial immutable runtime lease cannot be extended by a same-instance tool result', async () => {
  const init = initial(3000), { wrap } = await fixture(init), changed = structuredClone(wrap());
  changed.connection.expires_at = new Date(START + 600_000).toISOString();
  const { controller, clock } = harness(init, async () => ({ structuredContent: changed }));
  await controller.create();
  assert.equal(controller.state.phase, 'invalid'); assert.equal(controller.state.initial?.connection.expires_at, init.connection.expires_at);
  assert.equal(controller.state.canRetry, false); assert.equal(clock.timers.size, 0);
});

test('request expiry stops polling before the later lease and removes any proposal', async () => {
  const init = initial(60_000), { data, wrap } = await fixture(init);
  data.request.expires_at = new Date(START + 2000).toISOString(); data.request_hash = serverDigest(data.request);
  let calls = 0; const { controller, clock } = harness(init, async () => { calls++; return { structuredContent: wrap() }; });
  await controller.create(); clock.tick(2000); assert.equal(controller.state.phase, 'expired'); assert.equal(controller.state.data?.proposal, null);
  clock.tick(10_000); assert.equal(calls, 1); assert.equal(controller.state.canCreate, true); controller.dispose();
});

test('cancel supersedes an in-flight read; late read cannot restore a plan or resume polling', async () => {
  const init = initial(), { data, wrap, bridge } = await fixture(init), pending = deferred<{ structuredContent: Result }>(); let calls = 0;
  const { controller, clock } = harness(init, async name => {
    calls++; if (name === 'panel_get_synthetic_result') return pending.promise;
    if (name === 'panel_cancel_synthetic_request') return { structuredContent: wrap(await bridge.cancel('test-owner', data.request.request_id) as Data) };
    return { structuredContent: wrap() };
  });
  await controller.create(); clock.tick(5000); assert.equal(calls, 2); await controller.cancel(); assert.equal(controller.state.phase, 'cancelled');
  pending.resolve({ structuredContent: wrap() }); await setImmediate(); await setImmediate();
  clock.tick(20_000); assert.equal(calls, 3); assert.equal(controller.state.phase, 'cancelled'); controller.dispose();
});

test('cancel is not acknowledged on an error or non-cancelled response', async () => {
  const init = initial(), { wrap } = await fixture(init); let calls = 0;
  const { controller } = harness(init, async () => ++calls === 1 ? { structuredContent: wrap() } : { isError: true });
  await controller.create(); await controller.cancel(); assert.equal(controller.state.phase, 'unconfirmed'); assert.equal(controller.state.canRetry, true);
  controller.dispose();
  const another = harness(init, async () => ({ structuredContent: wrap() })).controller;
  await another.create(); await another.cancel(); assert.equal(another.state.phase, 'invalid');
});

test('teardown invalidates outstanding create and cancels every timer', async () => {
  const init = initial(), { wrap } = await fixture(init), pending = deferred<{ structuredContent: Result }>();
  const { controller, clock } = harness(init, () => pending.promise); const creating = controller.create();
  controller.dispose(); pending.resolve({ structuredContent: wrap() }); await creating;
  assert.equal(controller.state.phase, 'disposed'); assert.equal(controller.state.data, null); assert.equal(clock.timers.size, 0);
});

test('changed result identity or hash halts permanently with no retry', async () => {
  const init = initial(), { wrap } = await fixture(init), bad = wrap(); bad.data.request_hash = '0'.repeat(64);
  const { controller, clock } = harness(init, async () => ({ structuredContent: bad }));
  await controller.create(); assert.equal(controller.state.phase, 'invalid'); assert.equal(controller.state.canRetry, false); assert.equal(clock.timers.size, 0);
});

function fakeDom() {
  const nodes = new Map<string, any>();
  for (const id of ['create', 'retry', 'cancel', 'status', 'connection', 'instance', 'lease', 'request-section', 'request-id', 'request-hash', 'request-expiry', 'proposal-section', 'proposal', 'proposal-hash', 'receipt']) nodes.set(id, { textContent: '', disabled: true, hidden: false, onclick: null, setAttribute() {} });
  const handlers: Record<string, () => void> = {};
  const doc = { getElementById: (id: string) => nodes.get(id) } as unknown as Document;
  const win = { parent: {}, addEventListener: (name: string, callback: () => void) => { handlers[name] = callback; } } as unknown as Window;
  return { doc, win, nodes, handlers };
}
test('SDK mount registers handlers before connect, requires tool capability, and blocks untrusted clicks', async () => {
  const dom = fakeDom(); let calls = 0, closed = false;
  const init = initial(); init.connection.expires_at = new Date(Date.now() + 60_000).toISOString();
  const app: PanelApp = { callServerTool: async () => { calls++; return {}; }, getHostCapabilities: () => ({ serverTools: {} }), close: async () => { closed = true; }, connect: async () => { assert.equal(typeof app.ontoolresult, 'function'); app.ontoolresult!({ structuredContent: init }); } };
  const mounted = installPanel(app, dom.doc, dom.win); await mounted.ready;
  assert.equal(dom.nodes.get('create').disabled, false); dom.nodes.get('create').onclick({ isTrusted: false }); assert.equal(calls, 0);
  dom.handlers.pagehide(); assert.equal(closed, true); assert.equal(mounted.controller.state.phase, 'disposed');
  const noTools = installPanel({ ...app, getHostCapabilities: () => ({}) }, dom.doc, dom.win); await noTools.ready;
  assert.equal(noTools.controller.state.phase, 'offline');
});

test('SDK teardown while handshake is pending never re-enables the panel', async () => {
  const dom = fakeDom(), handshake = deferred<void>();
  const app: PanelApp = { callServerTool: async () => ({}), getHostCapabilities: () => ({ serverTools: {} }), connect: () => handshake.promise };
  const mounted = installPanel(app, dom.doc, dom.win); await app.onteardown!({} as never, {} as never); handshake.resolve(); await mounted.ready;
  assert.equal(mounted.controller.state.phase, 'disposed'); assert.equal(dom.nodes.get('create').disabled, true);
});

test('immutable resource hashes the exact inline script and HTML; no runtime dependency or network domains', async () => {
  const hash = (text: string) => createHash('sha256').update(text).digest('hex');
  assert.equal(hash(PANEL_SCRIPT), PANEL_BUILD_HASH); assert.equal(hash(PANEL_HTML), PANEL_CONTENT_HASH);
  assert.equal(PANEL_URI, `ui://stats-synthetic-loop/tunnel-panel-${PANEL_CONTENT_HASH}.html`);
  assert.ok(PANEL_HTML.includes(`<script>${PANEL_SCRIPT}</script>`)); assert.equal((PANEL_HTML.match(/<script>/g) ?? []).length, 1);
  assert.deepEqual(panelResource()._meta.ui.csp, { connectDomains: [], resourceDomains: [] });
  assert.match(PANEL_HTML, /main\{[^}]*background:#fff/); assert.match(PANEL_HTML, /永不执行本地操作/);
  assert.match(PANEL_SCRIPT, /Third-party notices/); assert.match(PANEL_SCRIPT, /Copyright \(c\) 2024 Anthropic/);
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.dependencies, undefined); assert.equal(pkg.devDependencies['@modelcontextprotocol/ext-apps'], '1.7.5'); assert.equal(pkg.devDependencies['@modelcontextprotocol/sdk'], '1.30.0');
  const source = await readFile(new URL('../ui/panel-view.mts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /sendMessage|message\.send|updateModelContext|localStorage|sessionStorage|innerHTML|eval\(/);
});
