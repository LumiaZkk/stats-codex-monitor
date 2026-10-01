// Browser-only contract. Never import the Node bridge or accept a real diagnostic payload.
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const FIXTURE = { source: 'synthetic', cpu_utilization: 0.92, memory_pressure: 'normal', disk_free_gib: 80 };
export type Connection = { state: 'online'; instance_id: string; expires_at: string };
export type Initial = { schema_version: 1; kind: 'stats_tunnel_panel'; synthetic: true; connection: Connection; subscription_ready: boolean };
export type Binding = { request_id: string; request_hash: string };
export type Request = { schema_version: 1; request_id: string; stream_id: 'synthetic-smoke-v1'; fixture: 'high-cpu-v1'; synthetic: true; snapshot: typeof FIXTURE; created_at: string; expires_at: string };
export type Action = { type: 'open_activity_monitor'; target: 'current_device'; dry_run: true } | { type: 'observe_metrics'; metrics: string[]; duration_seconds: number; dry_run: true };
export type Proposal = { schema_version: 1; request_id: string; request_hash: string; plan_id: string; expires_at: string; dry_run: true; summary: string; actions: Action[] };
export type Data = { request: Request; request_hash: string; event_id: string; status: 'requested' | 'proposed' | 'cancelled' | 'expired'; proposal: Proposal | null; proposal_hash: string | null; execution: 'not_supported' };
export type Result = { schema_version: 1; kind: 'stats_tunnel_panel_result'; synthetic: true; connection: Connection; data: Data; receipt: null };
export class InvalidPanelData extends Error {}
function requireValue(valid: unknown): asserts valid { if (!valid) throw new InvalidPanelData('invalid_synthetic_panel_data'); }
function object(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value));
  requireValue(Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)));
}
function matches(value: unknown, pattern: RegExp): asserts value is string { requireValue(typeof value === 'string' && pattern.test(value)); }
export function instant(value: unknown): number {
  requireValue(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value));
  const time = Date.parse(value); requireValue(Number.isFinite(time) && new Date(time).toISOString() === value); return time;
}
function connection(value: unknown, now: number, expected?: string): asserts value is Connection {
  object(value, ['state', 'instance_id', 'expires_at']);
  requireValue(value.state === 'online'); matches(value.instance_id, UUID);
  requireValue(!expected || value.instance_id === expected); requireValue(instant(value.expires_at) > now);
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key])).join(',') + '}';
  return JSON.stringify(value);
}
export async function digest(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value)));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}
export function readInitial(input: unknown, now: number): Initial {
  const value = structuredClone(input);
  object(value, ['schema_version', 'kind', 'synthetic', 'connection', 'subscription_ready']);
  requireValue(value.schema_version === 1 && value.kind === 'stats_tunnel_panel' && value.synthetic === true && typeof value.subscription_ready === 'boolean');
  connection(value.connection, now); return value as Initial;
}
export async function readResult(input: unknown, now: number, expectedConnection: Connection, binding: Binding | null): Promise<Result> {
  const value = structuredClone(input);
  object(value, ['schema_version', 'kind', 'synthetic', 'connection', 'data', 'receipt']);
  requireValue(value.schema_version === 1 && value.kind === 'stats_tunnel_panel_result' && value.synthetic === true && value.receipt === null);
  connection(value.connection, now, expectedConnection.instance_id);
  requireValue(value.connection.expires_at === expectedConnection.expires_at);
  const data = value.data;
  object(data, ['request', 'request_hash', 'event_id', 'status', 'proposal', 'proposal_hash', 'execution']);
  requireValue(data.execution === 'not_supported'); matches(data.request_hash, HASH);
  requireValue(typeof data.event_id === 'string' && data.event_id.startsWith('evt_') && UUID.test(data.event_id.slice(4)));
  requireValue(['requested', 'proposed', 'cancelled', 'expired'].includes(data.status as string));
  const request = data.request;
  object(request, ['schema_version', 'request_id', 'stream_id', 'fixture', 'synthetic', 'snapshot', 'created_at', 'expires_at']);
  requireValue(request.schema_version === 1 && request.stream_id === 'synthetic-smoke-v1' && request.fixture === 'high-cpu-v1' && request.synthetic === true);
  matches(request.request_id, UUID);
  object(request.snapshot, Object.keys(FIXTURE)); requireValue(canonical(request.snapshot) === canonical(FIXTURE));
  const created = instant(request.created_at), expiry = instant(request.expires_at);
  requireValue(created <= now + 120_000 && expiry > created && expiry - created <= 30 * 60_000);
  requireValue(!binding || (request.request_id === binding.request_id && data.request_hash === binding.request_hash));
  requireValue(await digest(request) === data.request_hash);
  requireValue(data.status === 'expired' || data.status === 'cancelled' || expiry > now);
  if (data.status !== 'proposed') requireValue(data.proposal === null && data.proposal_hash === null);
  else {
    const plan = data.proposal;
    object(plan, ['schema_version', 'request_id', 'request_hash', 'plan_id', 'expires_at', 'dry_run', 'summary', 'actions']);
    requireValue(plan.schema_version === 1 && plan.request_id === request.request_id && plan.request_hash === data.request_hash && plan.dry_run === true);
    matches(plan.plan_id, UUID); matches(data.proposal_hash, HASH);
    const planExpiry = instant(plan.expires_at); requireValue(planExpiry > now && planExpiry <= expiry);
    requireValue(typeof plan.summary === 'string' && plan.summary.length <= 1000);
    requireValue(Array.isArray(plan.actions) && plan.actions.length >= 1 && plan.actions.length <= 2);
    const types = new Set(), metrics = ['cpu_utilization', 'memory_pressure', 'disk_free_gib'];
    for (const action of plan.actions) {
      requireValue(action && typeof action === 'object');
      if (action.type === 'open_activity_monitor') {
        object(action, ['type', 'target', 'dry_run']); requireValue(action.target === 'current_device' && action.dry_run === true);
      } else {
        object(action, ['type', 'metrics', 'duration_seconds', 'dry_run']);
        requireValue(action.type === 'observe_metrics' && action.dry_run === true && Number.isSafeInteger(action.duration_seconds) && (action.duration_seconds as number) >= 60 && (action.duration_seconds as number) <= 120);
        requireValue(Array.isArray(action.metrics) && action.metrics.length >= 1 && action.metrics.length <= 3 && action.metrics.every(metric => metrics.includes(metric)) && new Set(action.metrics).size === action.metrics.length);
      }
      requireValue(!types.has(action.type)); types.add(action.type);
    }
    requireValue(await digest(plan) === data.proposal_hash);
  }
  return value as Result;
}
