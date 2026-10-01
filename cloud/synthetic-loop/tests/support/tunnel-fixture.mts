// TEST ONLY: credential-free MCP fixture for the official runtime-only wire probe.
// Never configure a real tunnel against this file. It intentionally has no user auth.
import { Bridge, Fault } from '../../bridge/core.mts';
import { MemoryStore } from '../../bridge/memory-store.mts';
import { Events } from '../../bridge/events.mts';
import type { Subscription } from '../../bridge/events.mts';
import { parseStrictJson } from '../../bridge/json.mts';
import { rpc } from '../../bridge/mcp.mts';

if (process.env.STATS_OFFICIAL_TUNNEL_PROBE !== 'synthetic-only') {
  process.stderr.write('This isolated fixture requires STATS_OFFICIAL_TUNNEL_PROBE=synthetic-only.\n');
  process.exit(2);
}
const owner = 'isolated-synthetic-test-owner';
const bridge = new Bridge(new MemoryStore());
const subscriptions = new Map<string, Subscription>();
const events = new Events({
  get: async id => subscriptions.get(id) ?? null,
  put: async sub => { subscriptions.set(sub.id, sub); },
  remove: async id => { subscriptions.delete(id); },
}, async (url, body) => {
  if (url !== 'https://fixture.invalid/callback') throw new Fault('fixture_callback_only');
  const request = parseStrictJson(body) as { type?: string; challenge?: string };
  if (request.type !== 'verification') throw new Fault('fixture_verification_only');
  return { status: 200, body: JSON.stringify({ challenge: request.challenge }) };
}, async principal => principal === owner);

// A bounded line reader, including a bound before a newline ever arrives.
let pending = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) {
  pending += chunk.toString('utf8');
  if (Buffer.byteLength(pending) > 16_384) process.exit(3);
  while (pending.includes('\n')) {
    const at = pending.indexOf('\n'), line = pending.slice(0, at); pending = pending.slice(at + 1);
    if (!line.trim()) continue;
    try {
      const request = parseStrictJson(line) as { id?: unknown };
      const response = await rpc(bridge, owner, request, events);
      // JSON-RPC notifications must not produce a response.
      if (Object.hasOwn(request, 'id')) process.stdout.write(JSON.stringify(response) + '\n');
    } catch {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n');
    }
  }
}
