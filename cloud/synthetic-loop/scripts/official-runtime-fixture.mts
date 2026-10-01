// TEST ONLY: local control-plane wire fixture for the verified runtime-only binary.
// It accepts no real credentials and has no hosted ingress or identity authority.
// Contract: openai/tunnel-client a390c168ff1b2d14e73a95991c186c6aba3ff5a0,
// docs/protocol.md (poll commands and response correlation), pkg/controlplane/wiretypes/wire.go.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseStrictJson } from '../bridge/json.mts';

export const FIXTURE_TUNNEL_ID = 'tunnel_' + 'a'.repeat(32);
export const FIXTURE_API_KEY = 'sk-isolated-runtime-fixture-not-a-credential';
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export type FixtureRPC<T = unknown> = {
  jsonrpc: '2.0'; id: string;
  result?: T; error?: { code: number; message: string; data?: unknown };
};
type Pending = {
  requestId: string; shardToken: string; rpcId: string;
  command: Record<string, unknown>; delivered: boolean;
  finish: (error: Error | undefined, result?: FixtureRPC) => void;
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export async function createLoopbackControlPlane(tunnelId = FIXTURE_TUNNEL_ID, unavailable = false) {
  assert(/^tunnel_[a-f0-9]{32}$/.test(tunnelId));
  const basePath = `/v1/tunnels/${tunnelId}`;
  const pending = new Map<string, Pending>();
  const polls = new Set<ServerResponse>();
  let failure: Error | undefined;
  let closed = false;
  const json = (response: ServerResponse, status: number, value: unknown) => {
    response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(value));
  };
  const flush = () => {
    for (const response of polls) {
      const next = [...pending.values()].find(item => !item.delivered);
      if (!next) break;
      polls.delete(response);
      next.delivered = true;
      json(response, 200, { commands: [next.command] });
    }
  };
  const fail = (error: Error) => {
    failure ??= error;
    for (const item of [...pending.values()]) item.finish(failure);
  };
  async function handle(request: IncomingMessage, response: ServerResponse) {
    assert.equal(request.socket.remoteAddress, '127.0.0.1', 'Fixture accepts loopback peers only');
    assert.equal(request.headers.authorization, `Bearer ${FIXTURE_API_KEY}`, 'Fixture credential must be the public fake key');
    const url = new URL(request.url!, 'http://127.0.0.1');
    if (unavailable) { json(response, 503, { error: 'isolated unavailable control plane' }); return; }
    if (request.method === 'GET' && url.pathname === basePath) {
      json(response, 200, { id: tunnelId, name: 'isolated runtime fixture', description: 'No hosted access or identity verification' });
      return;
    }
    if (request.method === 'GET' && url.pathname === `${basePath}/poll`) {
      assert(Number(url.searchParams.get('limit')) > 0, 'Runtime poll must request a positive batch limit');
      polls.add(response);
      const timeout = setTimeout(() => {
        if (polls.delete(response)) { response.writeHead(204); response.end(); }
      }, 250);
      response.once('close', () => { clearTimeout(timeout); polls.delete(response); });
      flush();
      return;
    }
    if (request.method === 'POST' && url.pathname === `${basePath}/response`) {
      assert.match(request.headers['content-type'] ?? '', /^application\/json(?:;|$)/);
      let size = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        assert(size <= MAX_RESPONSE_BYTES, 'Runtime response exceeds fixture bound');
        chunks.push(bytes);
      }
      const body = parseStrictJson(Buffer.concat(chunks).toString('utf8'));
      assert(record(body), 'Runtime response must be an object');
      assert.equal(typeof body.request_id, 'string');
      const item = pending.get(body.request_id as string);
      assert(item?.delivered, 'Response must match one delivered, pending command');
      assert.equal(request.headers['x-tunnel-shard-token'], item.shardToken, 'Response shard token must match the command');
      assert.equal(body.channel, 'main', 'Response channel must match the command');
      assert.equal(Object.hasOwn(body, 'shard_token'), false, 'Shard token belongs only in the HTTP header');
      assert(record(body.resp_json), 'Runtime response must contain JSON-RPC');
      assert.equal(body.resp_json.jsonrpc, '2.0');
      if (body.resp_type === 'jsonrpc_notify') {
        assert.equal(Object.hasOwn(body.resp_json, 'id'), false, 'Notification must not complete the request');
        json(response, 200, { status: 'ok' });
        return;
      }
      assert.equal(body.resp_type, 'jsonrpc_response');
      assert.equal(body.resp_code, 200, `Runtime ${body.request_id} transport status: ${body.resp_code}`);
      assert.equal(body.resp_json.id, item.rpcId, 'JSON-RPC id must match the original request');
      assert.notEqual(Object.hasOwn(body.resp_json, 'result'), Object.hasOwn(body.resp_json, 'error'), 'JSON-RPC requires exactly one result or error');
      json(response, 200, { status: 'ok' });
      item.finish(undefined, body.resp_json as FixtureRPC);
      return;
    }
    throw new Error(`Unexpected local control-plane request: ${request.method} ${url.pathname}`);
  }
  const server = createServer((request, response) => {
    void handle(request, response).catch(error => {
      fail(error instanceof Error ? error : new Error(String(error)));
      if (!response.headersSent && !response.destroyed) json(response, 400, { error: 'fixture_contract_violation' });
      else response.destroy();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  server.on('error', fail);
  const address = server.address();
  assert(address && typeof address !== 'string');
  return {
    url: `http://127.0.0.1:${address.port}`,
    apiKey: FIXTURE_API_KEY,
    assertHealthy() { if (failure) throw failure; },
    call<T = unknown>(method: string, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<FixtureRPC<T>> {
      if (failure) return Promise.reject(failure);
      if (closed) return Promise.reject(new Error('fixture_closed'));
      if (signal?.aborted) return Promise.reject(signal.reason);
      const requestId = randomUUID(), shardToken = randomUUID(), rpcId = randomUUID();
      return new Promise<FixtureRPC<T>>((resolve, reject) => {
        const abort = () => finish(signal?.reason instanceof Error ? signal.reason : new Error('fixture_call_aborted'));
        const deadline = setTimeout(() => finish(new Error(`Runtime response timed out: ${method}`)), 10_000);
        const finish = (error: Error | undefined, result?: FixtureRPC) => {
          if (!pending.delete(requestId)) return;
          clearTimeout(deadline);
          signal?.removeEventListener('abort', abort);
          if (error) reject(error); else resolve(result as FixtureRPC<T>);
        };
        pending.set(requestId, {
          requestId, shardToken, rpcId, delivered: false, finish,
          command: {
            request_id: requestId, shard_token: shardToken, command_type: 'jsonrpc', channel: 'main',
            created_at: new Date().toISOString(), response_timeout: '10s',
            headers: { 'MCP-Protocol-Version': ['2026-07-28'] },
            jsonrpc: { jsonrpc: '2.0', id: rpcId, method, params: { ...params, _meta: {
              'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {},
            } } },
          },
        });
        signal?.addEventListener('abort', abort, { once: true });
        flush();
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const item of [...pending.values()]) item.finish(new Error('fixture_closed'));
      for (const response of polls) { response.writeHead(204); response.end(); }
      polls.clear();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}
