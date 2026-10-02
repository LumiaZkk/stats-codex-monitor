import assert from 'node:assert/strict';
import test from 'node:test';
import { createLoopbackControlPlane, FIXTURE_API_KEY, FIXTURE_TUNNEL_ID } from '../scripts/official-runtime-fixture.mts';

const authorization = { Authorization: `Bearer ${FIXTURE_API_KEY}` };
type Command = { request_id: string; shard_token: string; channel: string; jsonrpc: { id: string; method: string; params: Record<string, unknown> } };
async function poll(url: string): Promise<Command> {
  const response = await fetch(`${url}/v1/tunnels/${FIXTURE_TUNNEL_ID}/poll?limit=1&timeout_ms=1000`, { headers: authorization });
  assert.equal(response.status, 200);
  const body = await response.json() as { commands: Command[] };
  assert.equal(body.commands.length, 1);
  return body.commands[0];
}
function payload(command: Command, result: unknown) {
  return { request_id: command.request_id, channel: command.channel, resp_code: 200, resp_type: 'jsonrpc_response', resp_json: { jsonrpc: '2.0', id: command.jsonrpc.id, result } };
}
async function post(url: string, command: Command, body: unknown, token = command.shard_token) {
  return fetch(`${url}/v1/tunnels/${FIXTURE_TUNNEL_ID}/response`, {
    method: 'POST', headers: { ...authorization, 'Content-Type': 'application/json', 'X-Tunnel-Shard-Token': token }, body: JSON.stringify(body),
  });
}

test('loopback fixture preserves full resource bytes and request correlation over official poll/response wire', async t => {
  const fixture = await createLoopbackControlPlane(); t.after(() => fixture.close());
  const waiting = fixture.call<{ contents: { text: string }[] }>('resources/read', { uri: 'ui://fixture/full.html' });
  const command = await poll(fixture.url);
  assert.equal(command.jsonrpc.method, 'resources/read');
  assert.deepEqual(command.jsonrpc.params._meta, { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} });
  const result = { contents: [{ text: '<html>' + 'x'.repeat(300_000) + '</html>' }] };
  assert.equal((await post(fixture.url, command, payload(command, result))).status, 200);
  assert.deepEqual((await waiting).result, result);
  fixture.assertHealthy();
});

test('loopback fixture notifications do not consume the terminal response', async t => {
  const fixture = await createLoopbackControlPlane(); t.after(() => fixture.close());
  const waiting = fixture.call('tools/list'); const command = await poll(fixture.url);
  const notify = { request_id: command.request_id, channel: 'main', resp_code: 200, resp_type: 'jsonrpc_notify', resp_json: { jsonrpc: '2.0', method: 'notifications/progress', params: {} } };
  assert.equal((await post(fixture.url, command, notify)).status, 200);
  assert.equal((await post(fixture.url, command, payload(command, { tools: [] }))).status, 200);
  assert.deepEqual((await waiting).result, { tools: [] });
});

for (const violation of ['shard_token', 'rpc_id', 'channel', 'request_id'] as const) {
  test(`loopback fixture rejects mismatched ${violation}`, async t => {
    const fixture = await createLoopbackControlPlane(); t.after(() => fixture.close());
    const waiting = fixture.call('tools/list');
    const rejected = assert.rejects(waiting);
    const command = await poll(fixture.url), body = payload(command, { tools: [] });
    if (violation === 'rpc_id') body.resp_json.id = 'another-rpc';
    if (violation === 'channel') body.channel = 'another-channel';
    if (violation === 'request_id') body.request_id = 'another-request';
    assert.equal((await post(fixture.url, command, body, violation === 'shard_token' ? 'another-token' : command.shard_token)).status, 400);
    await rejected;
    assert.throws(() => fixture.assertHealthy());
  });
}

test('loopback fixture cancels pending work before delivery and closes outstanding polls', async () => {
  const fixture = await createLoopbackControlPlane();
  try {
    const abort = new AbortController();
    const waiting = fixture.call('tools/list', {}, abort.signal);
    const rejected = assert.rejects(waiting, /cancelled/);
    abort.abort(new Error('cancelled')); await rejected;
    const response = await fetch(`${fixture.url}/v1/tunnels/${FIXTURE_TUNNEL_ID}/poll?limit=1`, { headers: authorization });
    assert.equal(response.status, 204);
    fixture.assertHealthy();
  } finally { await fixture.close(); }
});
