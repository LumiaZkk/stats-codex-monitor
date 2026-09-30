import { createHash, randomUUID } from 'node:crypto';

export const EVENT_NAME = 'diagnostic.requested';
export const STREAM_ID = 'synthetic-smoke-v1';
export const FIXTURE = Object.freeze({ source: 'synthetic', cpu_utilization: 0.92, memory_pressure: 'normal', disk_free_gib: 80 });
export type Schema = { type?: string; const?: unknown; enum?: readonly unknown[]; properties?: Record<string, Schema>; required?: string[]; additionalProperties?: boolean; items?: Schema; minItems?: number; maxItems?: number; minimum?: number; maximum?: number; maxLength?: number; pattern?: string; oneOf?: Schema[] };
const uuid: Schema = { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' };
const hash: Schema = { type: 'string', pattern: '^[0-9a-f]{64}$' };
const instant: Schema = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$' };
const object = (properties: Record<string, Schema>, required = Object.keys(properties)): Schema => ({ type: 'object', properties, required, additionalProperties: false });
export const createSchema = object({ idempotency_key: uuid, fixture: { const: 'high-cpu-v1' } });
export const requestArgsSchema = object({ request_id: uuid });
export const filterSchema = object({ stream_id: { const: STREAM_ID } });
export const planSchema = object({
  schema_version: { const: 1 }, request_id: uuid, request_hash: hash, plan_id: uuid,
  expires_at: instant, dry_run: { const: true }, summary: { type: 'string', maxLength: 1000 },
  actions: { type: 'array', minItems: 1, maxItems: 2, items: { oneOf: [
    object({ type: { const: 'open_activity_monitor' }, target: { const: 'current_device' }, dry_run: { const: true } }),
    object({ type: { const: 'observe_metrics' }, metrics: { type: 'array', minItems: 1, maxItems: 3, items: { enum: ['cpu_utilization', 'memory_pressure', 'disk_free_gib'] } }, duration_seconds: { type: 'integer', minimum: 60, maximum: 300 }, dry_run: { const: true } }),
  ] } },
});
export const eventSchema = object({ request_id: uuid, request_hash: hash, stream_id: { const: STREAM_ID }, synthetic: { const: true }, expires_at: instant });

export class Fault extends Error {
  code: number; status: number; reason: string;
  constructor(reason: string, status = 400, code = -32602) { super(reason); this.reason = reason; this.status = status; this.code = code; }
}
export function validate(schema: Schema, value: unknown): void {
  const fail = () => { throw new Fault('invalid_schema'); };
  if (schema.oneOf) {
    const matches = schema.oneOf.filter(s => { try { validate(s, value); return true; } catch { return false; } });
    if (matches.length !== 1) fail(); return;
  }
  if ('const' in schema && value !== schema.const) fail();
  if (schema.enum && !schema.enum.includes(value)) fail();
  if (schema.type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) fail();
    const obj = value as Record<string, unknown>;
    if (schema.required?.some(k => !Object.hasOwn(obj, k))) fail();
    for (const [k, v] of Object.entries(obj)) {
      if (!Object.hasOwn(schema.properties ?? {}, k)) { if (schema.additionalProperties === false) fail(); }
      else validate(schema.properties![k], v);
    }
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) fail();
    const arr = value as unknown[];
    if (arr.length < (schema.minItems ?? 0) || arr.length > (schema.maxItems ?? Infinity)) fail();
    for (const item of arr) if (schema.items) validate(schema.items, item);
  }
  if (schema.type === 'string') {
    if (typeof value !== 'string') fail();
    if ((value as string).length > (schema.maxLength ?? Infinity) || (schema.pattern && !new RegExp(schema.pattern).test(value as string))) fail();
  }
  if (schema.type === 'integer' && (!Number.isSafeInteger(value) || (value as number) < (schema.minimum ?? -Infinity) || (value as number) > (schema.maximum ?? Infinity))) fail();
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical((value as Record<string, unknown>)[k])).join(',') + '}';
  return JSON.stringify(value);
}
export const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
export type Plan = { schema_version: 1; request_id: string; request_hash: string; plan_id: string; expires_at: string; dry_run: true; summary: string; actions: Array<{ type: 'open_activity_monitor'; target: 'current_device'; dry_run: true } | { type: 'observe_metrics'; metrics: string[]; duration_seconds: number; dry_run: true }> };
export type DiagnosticRequest = { schema_version: 1; request_id: string; stream_id: string; fixture: 'high-cpu-v1'; synthetic: true; snapshot: typeof FIXTURE; created_at: string; expires_at: string };
export type RecordRow = { owner: string; idempotencyKey: string; request: DiagnosticRequest; requestHash: string; eventId: string; cancelled: boolean; plan: Plan | null; planHash: string | null };
export interface Store {
  create(row: RecordRow): Promise<RecordRow>;
  get(owner: string, requestId: string): Promise<RecordRow | null>;
  propose(owner: string, id: string, plan: Plan, planHash: string, now: string): Promise<RecordRow | null>;
  cancel(owner: string, id: string): Promise<RecordRow | null>;
  noteMethod(owner: string, method: string): Promise<void>;
  methods(owner: string): Promise<string[]>;
}
export function principal(owner: string | null | undefined): string {
  if (!owner || owner.length > 200) throw new Fault('authentication_required', 401, -32001);
  return owner;
}
export class Bridge {
  store: Store; clock: () => number;
  constructor(store: Store, clock = Date.now) { this.store = store; this.clock = clock; }
  async create(owner: string, input: unknown) {
    principal(owner); validate(createSchema, input);
    const args = input as { idempotency_key: string; fixture: 'high-cpu-v1' };
    const now = this.clock();
    const request: DiagnosticRequest = { schema_version: 1, request_id: randomUUID(), stream_id: STREAM_ID, fixture: args.fixture, synthetic: true, snapshot: FIXTURE, created_at: new Date(now).toISOString(), expires_at: new Date(now + 30 * 60_000).toISOString() };
    return this.public(await this.store.create({ owner, idempotencyKey: args.idempotency_key, request, requestHash: digest(request), eventId: 'evt_' + randomUUID(), cancelled: false, plan: null, planHash: null }));
  }
  public(row: RecordRow) {
    const expired = Date.parse(row.request.expires_at) <= this.clock() || (row.plan && Date.parse(row.plan.expires_at) <= this.clock());
    return { request: row.request, request_hash: row.requestHash, event_id: row.eventId, status: row.cancelled ? 'cancelled' : expired ? 'expired' : row.plan ? 'proposed' : 'requested', proposal: !row.cancelled && !expired ? row.plan : null, proposal_hash: !row.cancelled && !expired ? row.planHash : null, execution: 'not_supported' };
  }
  async row(owner: string, id: string) {
    principal(owner); validate(requestArgsSchema, { request_id: id });
    const row = await this.store.get(owner, id);
    if (!row) throw new Fault('not_found', 404, -32004); return row;
  }
  async read(owner: string, id: string) { return this.public(await this.row(owner, id)); }
  async submit(owner: string, input: unknown) {
    principal(owner); validate(planSchema, input);
    const plan = input as Plan; const row = await this.row(owner, plan.request_id); const now = this.clock();
    if (plan.request_hash !== row.requestHash) throw new Fault('request_hash_mismatch', 409, -32009);
    if (!Number.isFinite(Date.parse(plan.expires_at)) || Date.parse(plan.expires_at) <= now || Date.parse(plan.expires_at) > Date.parse(row.request.expires_at)) throw new Fault('invalid_plan_expiry');
    const ph = digest(plan);
    const saved = await this.store.propose(owner, plan.request_id, plan, ph, new Date(now).toISOString());
    if (!saved) throw new Fault('not_found', 404, -32004);
    if (saved.cancelled || Date.parse(saved.request.expires_at) <= now) throw new Fault('request_terminal', 409, -32009);
    if (saved.planHash !== ph) throw new Fault('proposal_conflict', 409, -32009);
    return this.public(saved);
  }
  async cancel(owner: string, id: string) { await this.row(owner, id); return this.public((await this.store.cancel(owner, id))!); }
  async event(owner: string, id: string) {
    const row = await this.row(owner, id);
    if (this.public(row).status !== 'requested') throw new Fault('request_terminal', 409, -32009);
    const data = { request_id: id, request_hash: row.requestHash, stream_id: STREAM_ID, synthetic: true, expires_at: row.request.expires_at };
    validate(eventSchema, data);
    return { eventId: row.eventId, name: EVENT_NAME, timestamp: row.request.created_at, data, cursor: null };
  }
}
