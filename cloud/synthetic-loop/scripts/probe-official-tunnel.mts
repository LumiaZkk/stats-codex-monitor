// Credential-free integration probe of the verified official runtime-only binary.
// This is NOT a hosted tunnel, authenticated owner test, or current-dot wake test.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Bridge } from '../bridge/core.mts';
import { prepareRuntimeBinary } from '../tunnel/runtime-binary.mts';
import { prepareContainment } from './runtime-probe-containment.mts';
import { createLoopbackControlPlane, FIXTURE_TUNNEL_ID } from './official-runtime-fixture.mts';
type ToolData = Awaited<ReturnType<Bridge['read']>>;

const binary = process.env.TUNNEL_CLIENT_BIN;
if (!binary) throw new Error('Set TUNNEL_CLIENT_BIN to a verified official tunnel-client-runtime binary; no automatic install occurs.');
const scratch = await mkdtemp(join(tmpdir(), 'stats-official-probe-'));
const runtimeBinary = await prepareRuntimeBinary(binary, scratch);
const controlPlane = await createLoopbackControlPlane();
const fixture = fileURLToPath(new URL('../tests/support/contained-fixture.mts', import.meta.url));
assert(/^[a-zA-Z0-9/_.-]+$/.test(fixture) && /^[a-zA-Z0-9/_.-]+$/.test(process.execPath), 'Probe command requires simple absolute paths without shell metacharacters or spaces.');
const containment=await prepareContainment(scratch,fixture,controlPlane.apiKey);
const child = spawn(runtimeBinary, ['run', '--control-plane.tunnel-id', FIXTURE_TUNNEL_ID, '--control-plane.api-key', 'env:CONTROL_PLANE_API_KEY', '--control-plane.base-url', controlPlane.url, '--mcp.command', containment.command, '--health.listen-addr', '127.0.0.1:0'], {
  env: containment.env,
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: process.platform !== 'win32',
});
let diagnostic = '';
let spawnError: Error | undefined;
child.on('error', error => { spawnError = error; });
const cancelled = new AbortController();
const cancel = () => cancelled.abort();
process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { diagnostic = (diagnostic + chunk.toString()).slice(-16_384); });
try {
  async function call<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>): Promise<T> {
    cancelled.signal.throwIfAborted();
    if (spawnError) throw spawnError;
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Official runtime stopped: ${diagnostic}`);
    const result = await controlPlane.call<T>(method, params, cancelled.signal);
    assert.equal(result.error, undefined, `${method}: ${JSON.stringify(result.error)} ${diagnostic}`);
    assert(Object.hasOwn(result, 'result'), `${method}: missing JSON-RPC result`);
    return result.result as T;
  }
  const discovery = await call<{ supportedVersions: string[]; capabilities: { events?: object } }>('server/discover'); assert(discovery.supportedVersions.includes('2026-07-28')); assert(discovery.capabilities.events);
  const list = await call<{ events: { name: string }[] }>('events/list'); assert.equal(list.events[0].name, 'diagnostic.requested');
  const subscription = { name: 'diagnostic.requested', arguments: { stream_id: 'synthetic-smoke-v1' }, delivery: { mode: 'webhook', url: 'https://fixture.invalid/callback', secret: 'whsec_' + Buffer.alloc(32, 6).toString('base64') }, ttlMs: 60_000 };
  const first = await call('events/subscribe', subscription); const repeated = await call('events/subscribe', subscription); assert.equal(first.id, repeated.id);
  const tool = async (name: string, args: unknown) => (await call<{ structuredContent: ToolData }>('tools/call', { name, arguments: args })).structuredContent;
  const input = { idempotency_key: randomUUID(), fixture: 'high-cpu-v1' };
  const created = await tool('create_synthetic_request', input);
  const duplicate = await tool('create_synthetic_request', input); assert.equal(created.request_hash, duplicate.request_hash);
  const request = await tool('get_diagnostic_request', { request_id: created.request.request_id }); assert.equal(request.request_hash, created.request_hash);
  const plan = { schema_version: 1, request_id: request.request.request_id, request_hash: request.request_hash, plan_id: randomUUID(), expires_at: request.request.expires_at, dry_run: true, summary: 'Isolated official-client transport test; no native execution.', actions: [{ type: 'observe_metrics', metrics: ['cpu_utilization'], duration_seconds: 60, dry_run: true }] };
  const proposed = await tool('submit_diagnostic_plan', plan); assert.equal(proposed.status, 'proposed');
  const replay = await tool('submit_diagnostic_plan', plan); assert.equal(replay.proposal_hash, proposed.proposal_hash);
  const result = await tool('get_diagnostic_result', { request_id: request.request.request_id }); assert.equal(result.proposal_hash, proposed.proposal_hash); assert.equal(result.execution, 'not_supported');
  await call('events/unsubscribe', subscription); await call('events/unsubscribe', subscription);
  controlPlane.assertHealthy();await containment.assertPassed();
  process.stdout.write(JSON.stringify({ local_official_transport: 'passed', server_discover: true, events_list_subscribe_unsubscribe: true, request_read_plan_return: true, idempotency: true, hosted_tunnel: 'not_tested', authenticated_owner: 'not_tested', real_callback: 'not_tested', current_dot_wake: 'not_tested', native_execution: 'not_tested' }, null, 2) + '\n');
} finally {
  process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
  const stop = (signal: NodeJS.Signals) => {
    try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  };
  stop('SIGTERM');
  await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 1500))]);
  if (child.exitCode === null && child.signalCode === null) {
    stop('SIGKILL');
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 500))]);
  }
  await controlPlane.close();
  await rm(scratch, { recursive: true, force: true });
}
