// Credential-free integration probe of the real official binary's local dev proxy.
// This is NOT a hosted tunnel, authenticated owner test, or current-dot wake test.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Bridge } from '../bridge/core.mts';
type ToolData = Awaited<ReturnType<Bridge['read']>>;

const binary = process.env.TUNNEL_CLIENT_BIN;
if (!binary) throw new Error('Set TUNNEL_CLIENT_BIN to a verified official tunnel-client binary; no automatic install occurs.');
const scratch = await mkdtemp(join(tmpdir(), 'stats-official-probe-'));
const infoPath = join(scratch, 'connection.json');
const fixture = fileURLToPath(new URL('../tests/support/tunnel-fixture.mts', import.meta.url));
assert(/^[a-zA-Z0-9/_.-]+$/.test(fixture) && /^[a-zA-Z0-9/_.-]+$/.test(process.execPath), 'Probe command requires simple absolute paths without shell metacharacters or spaces.');
const child = spawn(resolve(binary), ['dev', 'proxy', '--backend', 'go', '--duration', '45s', '--mcp-command', `${process.execPath} ${fixture}`, '--url-file', infoPath, '--print-json'], {
  env: { PATH: process.env.PATH, HOME: scratch, XDG_CONFIG_HOME: scratch, NODE_ENV: 'test', STATS_OFFICIAL_TUNNEL_PROBE: 'synthetic-only' },
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
let id = 0;
try {
  let info: Record<string, unknown> | undefined;
  const until = Date.now() + 20_000;
  while (!info && Date.now() < until) {
    cancelled.signal.throwIfAborted();
    if (spawnError) throw spawnError;
    if (child.exitCode !== null) throw new Error(`Official dev proxy stopped: ${diagnostic}`);
    try { info = JSON.parse(await readFile(infoPath, 'utf8')); } catch { await new Promise(r => setTimeout(r, 100)); }
  }
  if (!info) throw new Error(`Official dev proxy readiness timed out: ${diagnostic}`);
  // Print only connection field names if a release changes its local contract.
  const candidate = info.mcp_url ?? info.url;
  if (typeof candidate !== 'string') throw new Error(`Unrecognized local proxy fields: ${Object.keys(info)}`);
  const endpoint = new URL(candidate);
  assert.equal(endpoint.protocol, 'http:'); assert.equal(endpoint.hostname, '127.0.0.1');
  async function call<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>): Promise<T> {
    const response = await fetch(endpoint, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2026-07-28' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params: { ...params, _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} } } }), signal: AbortSignal.any([AbortSignal.timeout(10_000), cancelled.signal]) });
    assert.equal(response.status, 200, `${method}: ${await response.clone().text()}`);
    const result = await response.json() as { error?: unknown; result: T };
    assert.equal(result.error, undefined, `${method}: ${JSON.stringify(result.error)}`);
    return result.result;
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
  await rm(scratch, { recursive: true, force: true });
}
