import { exportNativeResult, importNativeRequest } from './transfer.mts';
import { Bridge, Fault, EVENT_NAME, STREAM_ID, filterSchema, eventSchema, requestArgsSchema, planSchema, createSchema, nativeRequestSchema, principal, validate } from './core.mts';
import type { Schema } from './core.mts';
export const CALLBACK_GATE = 'callback_transport_unverified';
const tool = (name: string, description: string, inputSchema: Schema, readOnly: boolean) => ({ name, description, inputSchema, annotations: { readOnlyHint: readOnly, destructiveHint: false, idempotentHint: true, openWorldHint: false } });
export const TOOLS = [
  tool('get_bridge_status', 'Read synthetic bridge readiness and methods observed for your account. A proposal is never executed.', { type: 'object', properties: {}, additionalProperties: false }, true),
  tool('get_diagnostic_request', 'Read one synthetic request owned by the connected account, including its immutable hash and expiry.', requestArgsSchema, true),
  tool('import_synthetic_request', 'Import the fixed synthetic request file exported by the app. No real metrics, credentials or extra fields are accepted. This is an explicit manual transfer, not native authentication or automatic upload.', nativeRequestSchema, false),
  tool('get_native_result_bundle', 'Read the unsigned synthetic result file for an owned native import/export request. File hashes bind content; they do not authenticate its origin or authorize local execution.', requestArgsSchema, true),
  tool('get_diagnostic_result', 'Read an owned synthetic proposal result. This does not prove event delivery or execute anything.', requestArgsSchema, true),
  tool('create_synthetic_request', 'Create a fixed synthetic high-CPU fixture for a dry-run protocol test. Accepts no real telemetry.', createSchema, false),
  tool('submit_diagnostic_plan', 'Store an immutable, schema-validated dry-run proposal for an owned unexpired request. Only open_activity_monitor and observe_metrics are allowed; neither executes.', planSchema, false),
];
export const EVENT = { name: EVENT_NAME, description: 'A fixed synthetic diagnostic request was created in the synthetic test stream. Hosted callback delivery is gated until a verified transport is available.', delivery: ['webhook'], inputSchema: filterSchema, payloadSchema: eventSchema };
export interface EventProtocol { subscribe(owner: string, params: unknown): Promise<unknown>; unsubscribe(owner: string, params: unknown): Promise<unknown>; }
export async function rpc(bridge: Bridge, owner: string | null, body: unknown, events?: EventProtocol) {
  const call = body as { jsonrpc?: string; id?: unknown; method?: string; params?: unknown };
  const id = call?.id ?? null;
  try {
    if (!call || call.jsonrpc !== '2.0' || typeof call.method !== 'string' || (typeof id !== 'number' && typeof id !== 'string' && id !== null)) throw new Fault('invalid_request', 400, -32600);
    const method = call.method;
    if (owner) await bridge.store.noteMethod(principal(owner), method);
    let result: unknown;
    if (method === 'server/discover') result = { resultType: 'complete', supportedVersions: ['2026-07-28'], capabilities: { tools: {}, events: {} }, serverInfo: { name: 'stats-synthetic-loop', version: '0.1.0' } };
    else if (method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'stats-synthetic-loop', version: '0.1.0' } };
    else if (method === 'notifications/initialized' || method === 'ping') result = {};
    else if (method === 'tools/list') result = { tools: TOOLS };
    else {
      const user = principal(owner);
      if (method === 'events/list') result = { events: [EVENT] };
      else if (method === 'events/subscribe' || method === 'events/unsubscribe') {
        if (!events) throw new Fault(CALLBACK_GATE, 503, -32014);
        result = method === 'events/subscribe' ? await events.subscribe(user, call.params) : await events.unsubscribe(user, call.params);
      } else if (method === 'tools/call') {
        const p = call.params as { name?: string; arguments?: unknown };
        const t = TOOLS.find(t => t.name === p?.name); if (!t) throw new Fault('unknown_tool');
        validate(t.inputSchema, p.arguments ?? {});
        const args = p.arguments as { request_id: string };
        let data: unknown;
        if (p.name === 'get_bridge_status') data = { synthetic_only: true, stream_id: STREAM_ID, callback_delivery: events ? 'test_adapter' : 'blocked', blocker: events ? null : CALLBACK_GATE, same_dot_roundtrip: 'not_verified', execution: 'not_supported', transfer_mode: 'signed_in_browser_files', native_pairing: 'not_supported', observed_methods: await bridge.store.methods(user) };
        else if (p.name === 'create_synthetic_request') data = await bridge.create(user, p.arguments);
        else if (p.name === 'import_synthetic_request') data = await importNativeRequest(bridge, user, p.arguments);
        else if (p.name === 'get_native_result_bundle') data = await exportNativeResult(bridge, user, args.request_id);
        else if (p.name === 'submit_diagnostic_plan') data = await bridge.submit(user, p.arguments);
        else data = await bridge.read(user, args.request_id);
        result = { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data, isError: false };
      } else throw new Fault('method_not_found', 404, -32601);
    }
    return { jsonrpc: '2.0', id, result };
  } catch (error) {
    const fault = error instanceof Fault ? error : new Fault('storage_unavailable', 503, -32603);
    return { jsonrpc: '2.0', id, error: { code: fault.code, message: fault.code === -32014 ? 'Unsupported' : fault.reason, data: { reason: fault.reason, ...(fault.code === -32014 ? { feature: 'callbackTransport' } : {}) } } };
  }
}
