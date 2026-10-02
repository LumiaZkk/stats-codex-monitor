// Browser-only validation. Keep bridge imports type-only: its validators use Node APIs.
import { canonical, digest, instant, UUID, InvalidPanelData } from './panel-contract.mts';
import type { Binding, Connection } from './panel-contract.mts';
import type {
  RealCandidate, RealConsumer, RealDiagnosticBody, RealDiagnosticRequest, RealObservation,
  RealPlan, RealReceipt, RealReceiptCandidate, RealReceiptEnvelope, RealResultBundle, RealSnapshot,
} from '../bridge/real-contract.mts';
export type { RealCandidate, RealConsumer, RealDiagnosticBody, RealDiagnosticRequest, RealPlan, RealReceipt, RealSnapshot } from '../bridge/real-contract.mts';

export type RealInitial = {
  schema_version: 2; kind: 'stats_tunnel_panel'; synthetic: boolean; connection: Connection;
  subscription_ready: boolean; real_enabled: boolean; real_subscription_ready: boolean; native_collection_available: boolean;
};
export type IntentBinding = { intent_id: string; intent_hash: string };
export type RealIntent = {
  schema_version: 1; kind: 'stats_global_collection_intent'; intent_id: string; created_at: string;
  expires_at: string; consent_scope: 'global_diagnostics_v1';
};
export type RealData = {
  request: RealDiagnosticRequest; request_hash: string; event_id: string;
  status: 'requested' | 'proposed' | 'cancelled' | 'expired'; proposal: RealPlan | null; proposal_hash: string | null;
  receipt: RealReceiptEnvelope | null; receipt_hash: string | null; execution: 'local_approval_required';
};
type RealWireResult = {
  schema_version: 1; kind: 'stats_global_panel_result'; synthetic: false; connection: Connection;
  intent: RealIntent; intent_hash: string;
  status: 'awaiting_native' | 'awaiting_consent' | 'requested' | 'proposed' | 'declined' | 'cancelled' | 'expired';
  data: RealData | null; result_bundle: RealResultBundle | null;
};
export type RealResult = RealWireResult & {
  parsedBody: RealDiagnosticBody | null; parsedPlan: RealPlan | null; parsedReceipt: RealReceipt | null;
};

const HASH = /^[0-9a-f]{64}$/;
const MAX_FRAME = 16_384;
const MAX_LIFETIME = 600_000;
const FUTURE_SKEW = 120_000;
type Check = (value: unknown) => void;
function requireValue(valid: unknown): asserts valid { if (!valid) throw new InvalidPanelData('invalid_real_panel_data'); }
function object(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value));
  requireValue(Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)));
}
const record = (fields: Record<string, Check>): Check => value => {
  object(value, Object.keys(fields));
  for (const [key, check] of Object.entries(fields)) check(value[key]);
};
const oneOf = (...allowed: unknown[]): Check => value => requireValue(allowed.includes(value));
const number = (min: number, max: number): Check => value => requireValue(Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max);
const nullable = (check: Check): Check => value => { if (value !== null) check(value); };
const list = (check: Check, max: number, min = 0): Check => value => {
  requireValue(Array.isArray(value) && value.length >= min && value.length <= max);
  value.forEach(check);
};
const matches = (pattern: RegExp): Check => value => requireValue(typeof value === 'string' && pattern.test(value));
const uuid = matches(UUID), hash = matches(HASH), date: Check = value => { instant(value); };
const bool = oneOf(true, false), bytes = number(0, Number.MAX_SAFE_INTEGER);
const cpu = number(0, 10_240_000), hostCPU = nullable(number(0, 10_000)), interval = number(1500, 5000);
const pressure = oneOf('normal', 'warning', 'critical', null);
const text = (max: number): Check => value => requireValue(typeof value === 'string' && value.length <= max);
const jsonText = text(MAX_FRAME - 1);
const snapshotSchema = record({
  host_cpu_basis_points: hostCPU, cpu_observed_at: nullable(date), memory_pressure: pressure,
  swap_used_bytes: nullable(bytes), memory_observed_at: nullable(date), disk_free_bytes: nullable(bytes), disk_observed_at: nullable(date),
  disk_read_bytes_per_second: nullable(bytes), disk_write_bytes_per_second: nullable(bytes), io_observed_at: nullable(date),
});
const candidateFields = {
  candidate_id: uuid, display_name: text(256), category: oneOf('ordinary_gui_app'), cpu_basis_points: cpu,
  resident_bytes: bytes, interval_ms: interval, observed_at: date, measurement_scope: oneOf('main_process_only'),
};
const candidateSchema = record(candidateFields);
const receiptCandidateSchema = record({ ...candidateFields, cpu_basis_points: nullable(cpu), resident_bytes: nullable(bytes), interval_ms: nullable(interval) });
const consumerSchema = record({
  consumer_id: uuid, display_name: text(256), category: oneOf('ordinary_gui_app', 'protected_app', 'system_process', 'app_helper', 'unknown_process'),
  cpu_basis_points: cpu, resident_bytes: bytes, interval_ms: interval, observed_at: date,
  measurement_scope: oneOf('single_process'), quit_candidate_id: nullable(uuid),
});
const bodySchema = record({
  schema_version: oneOf(1), kind: oneOf('stats_real_diagnostic'), client_request_id: uuid, created_at: date, expires_at: date,
  consent: record({ scope: oneOf('global_diagnostics_v1'), confirmed_at: date }), snapshot: snapshotSchema,
  candidates: list(candidateSchema, 5), consumers: list(consumerSchema, 10),
  coverage: record({ scope: oneOf('visible_processes_bounded'), pid_limit: oneOf(4096), sampled_processes: number(0, 4096), unavailable_processes: number(0, 4096), truncated: bool, helpers_aggregated: oneOf(false) }),
  recent_samples: list(record({ observed_at: date, host_cpu_basis_points: hostCPU, memory_pressure: pressure }), 5),
  capabilities: list(oneOf('quit_app', 'observe_metrics'), 2, 2),
});
const requestSchema = record({
  schema_version: oneOf(2), request_id: uuid, stream_id: oneOf('global-device-v1'), synthetic: oneOf(false), created_at: date, expires_at: date,
  client_request: record({ schema_version: oneOf(1), kind: oneOf('stats_real_request'), client_request_json: jsonText, client_request_hash: hash }),
});
const actionSchema: Check = value => {
  requireValue(value !== null && typeof value === 'object');
  if ((value as { type?: unknown }).type === 'quit_app') record({ type: oneOf('quit_app'), candidate_id: uuid })(value);
  else record({ type: oneOf('observe_metrics') })(value);
};
const planSchema = record({
  schema_version: oneOf(2), request_id: uuid, request_hash: hash, plan_id: uuid, expires_at: date,
  dry_run: oneOf(false), requires_local_approval: oneOf(true), policy_id: oneOf('local_capabilities_v1'),
  decision: oneOf('recommend_quit', 'observe', 'no_action'), summary: text(2000), actions: list(actionSchema, 1),
});
const observationSchema = record({ observed_at: date, snapshot: snapshotSchema, candidate: nullable(receiptCandidateSchema) });
const receiptSchema = record({
  schema_version: oneOf(1), kind: oneOf('stats_real_receipt'), receipt_id: uuid, client_request_id: uuid, request_id: uuid,
  request_hash: hash, plan_id: uuid, plan_hash: hash, candidate_id: nullable(uuid), policy_id: oneOf('local_capabilities_v1'),
  started_at: date, completed_at: date, local_approval_at: nullable(date),
  outcome: oneOf('no_action', 'observed', 'declined', 'cancelled', 'precondition_failed', 'quit_refused_or_timed_out', 'quit_confirmed'),
  quit_requested: bool, process_exit_confirmed: bool, before: observationSchema, after: nullable(observationSchema),
});
const receiptEnvelopeSchema = record({ schema_version: oneOf(1), kind: oneOf('stats_real_receipt_envelope'), receipt_json: jsonText, receipt_hash: hash });
const bundleSchema = record({ schema_version: oneOf(1), kind: oneOf('stats_real_result'), request_json: jsonText, request_hash: hash, proposal_json: jsonText, proposal_hash: hash });
const connectionSchema = record({ state: oneOf('online'), instance_id: uuid, expires_at: date });
const intentSchema = record({ schema_version: oneOf(1), kind: oneOf('stats_global_collection_intent'), intent_id: uuid, created_at: date, expires_at: date, consent_scope: oneOf('global_diagnostics_v1') });
const dataSchema = record({
  request: requestSchema, request_hash: hash, event_id: matches(/^evt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
  status: oneOf('requested', 'proposed', 'cancelled', 'expired'), proposal: nullable(planSchema), proposal_hash: nullable(hash),
  receipt: nullable(receiptEnvelopeSchema), receipt_hash: nullable(hash), execution: oneOf('local_approval_required'),
});

function scalars(value: string): number {
  let count = 0;
  for (const scalar of value) { const point = scalar.codePointAt(0)!; requireValue(point < 0xD800 || point > 0xDFFF); count++; }
  return count;
}
function unicode(value: unknown): void {
  if (typeof value === 'string') scalars(value);
  else if (Array.isArray(value)) value.forEach(unicode);
  else if (value !== null && typeof value === 'object') for (const [key, child] of Object.entries(value)) { scalars(key); unicode(child); }
}
const size = (value: string) => new TextEncoder().encode(value).length;
function bounded(value: unknown, maximum = MAX_FRAME - 1): void { requireValue(size(canonical(value)) <= maximum); unicode(value); }
async function parseCanonical(value: string, expectedHash: string): Promise<unknown> {
  requireValue(size(value) + 1 <= MAX_FRAME); scalars(value);
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new InvalidPanelData('invalid_real_panel_data'); }
  unicode(parsed);
  // Re-encoding also rejects duplicate keys, numeric aliases and escaped-key aliases.
  requireValue(canonical(parsed) === value && await digest(parsed) === expectedHash);
  return parsed;
}
function connection(value: Connection, now: number, expected?: Connection): void {
  requireValue(instant(value.expires_at) > now);
  if (expected) requireValue(value.instance_id === expected.instance_id && value.expires_at === expected.expires_at);
}
function lifetime(created: number, expiry: number, now: number, allowExpired: boolean): void {
  requireValue(created <= now + FUTURE_SKEW && expiry > created && expiry - created <= MAX_LIFETIME && (allowExpired || expiry > now));
}
function observedAt(value: string, anchor: number, age: number): number {
  const observed = instant(value); requireValue(observed >= anchor - age && observed <= anchor + 1000); return observed;
}
function snapshot(value: RealSnapshot, anchor: number): void {
  const group = (values: Array<number | string | null>, timestamp: string | null, age: number) => {
    requireValue(values.every(value => value === null) === (timestamp === null));
    if (timestamp !== null) observedAt(timestamp, anchor, age);
  };
  group([value.host_cpu_basis_points], value.cpu_observed_at, 120_000);
  group([value.memory_pressure, value.swap_used_bytes], value.memory_observed_at, 120_000);
  group([value.disk_free_bytes], value.disk_observed_at, 600_000);
  group([value.disk_read_bytes_per_second, value.disk_write_bytes_per_second], value.io_observed_at, 120_000);
}
function displayName(value: string): void { const length = scalars(value); requireValue(length >= 1 && length <= 128 && !/[\p{Cc}\p{Cf}]/u.test(value)); }
async function requestBody(request: RealDiagnosticRequest, requestHash: string, now: number, allowExpired: boolean): Promise<RealDiagnosticBody> {
  bounded(request, 14_000); bounded(request.client_request);
  requireValue(await digest(request) === requestHash);
  const parsed = await parseCanonical(request.client_request.client_request_json, request.client_request.client_request_hash);
  bodySchema(parsed);
  const body = parsed as RealDiagnosticBody;
  const created = instant(body.created_at), expiry = instant(body.expires_at), consent = instant(body.consent.confirmed_at);
  lifetime(created, expiry, now, allowExpired);
  requireValue(consent <= created && consent >= created - MAX_LIFETIME);
  snapshot(body.snapshot, created);
  requireValue(body.capabilities[0] === 'quit_app' && body.capabilities[1] === 'observe_metrics');
  const candidates = new Map<string, RealCandidate>();
  for (const candidate of body.candidates) {
    requireValue(!candidates.has(candidate.candidate_id)); candidates.set(candidate.candidate_id, candidate);
    displayName(candidate.display_name); observedAt(candidate.observed_at, created, 30_000);
  }
  const consumerIDs = new Set<string>(), targetIDs = new Set<string>();
  const labels = { protected_app: 'Protected app', system_process: 'System process', app_helper: 'App helper', unknown_process: 'Other process' };
  for (const consumer of body.consumers) {
    requireValue(!consumerIDs.has(consumer.consumer_id)); consumerIDs.add(consumer.consumer_id);
    displayName(consumer.display_name); observedAt(consumer.observed_at, created, 30_000);
    requireValue(consumer.category === 'ordinary_gui_app' || consumer.display_name === labels[consumer.category]);
    if (consumer.quit_candidate_id !== null) {
      const candidate = candidates.get(consumer.quit_candidate_id);
      requireValue(candidate && !targetIDs.has(consumer.quit_candidate_id) && consumer.category === 'ordinary_gui_app' &&
        consumer.display_name === candidate.display_name && consumer.cpu_basis_points === candidate.cpu_basis_points &&
        consumer.resident_bytes === candidate.resident_bytes && consumer.interval_ms === candidate.interval_ms && consumer.observed_at === candidate.observed_at);
      targetIDs.add(consumer.quit_candidate_id);
    }
  }
  requireValue(body.coverage.sampled_processes + body.coverage.unavailable_processes <= body.coverage.pid_limit && body.coverage.sampled_processes >= Math.max(body.candidates.length, body.consumers.length));
  let last = -Infinity;
  for (const sample of body.recent_samples) { const observed = observedAt(sample.observed_at, created, 300_000); requireValue(observed > last); last = observed; }
  const serverCreated = instant(request.created_at), serverExpiry = instant(request.expires_at);
  lifetime(serverCreated, serverExpiry, now, allowExpired);
  requireValue(serverExpiry <= expiry && serverCreated >= created - FUTURE_SKEW);
  return body;
}
async function plan(value: RealPlan, request: RealDiagnosticRequest, requestHash: string, body: RealDiagnosticBody, planHash: string, now: number, allowExpired: boolean): Promise<void> {
  bounded(value, 4096);
  requireValue(value.request_id === request.request_id && value.request_hash === requestHash && await digest(value) === planHash);
  requireValue(scalars(value.summary) <= 1000);
  const expiry = instant(value.expires_at);
  requireValue(expiry > instant(request.created_at) && expiry <= instant(request.expires_at) && (allowExpired || expiry > now));
  const action = value.actions[0];
  if (value.decision === 'no_action') requireValue(value.actions.length === 0);
  else if (value.decision === 'observe') requireValue(value.actions.length === 1 && action?.type === 'observe_metrics');
  else {
    requireValue(value.actions.length === 1 && action?.type === 'quit_app');
    const target = body.candidates.find(candidate => candidate.candidate_id === action.candidate_id);
    requireValue(target && (target.cpu_basis_points >= 2500 || target.resident_bytes >= 536_870_912));
  }
}
function stableCandidate(value: RealReceiptCandidate, target: RealCandidate): void {
  displayName(value.display_name);
  requireValue(value.candidate_id === target.candidate_id && value.display_name === target.display_name && value.category === target.category && value.measurement_scope === target.measurement_scope);
}
async function receipt(envelope: RealReceiptEnvelope, request: RealDiagnosticRequest, requestHash: string, body: RealDiagnosticBody, proposal: RealPlan, proposalHash: string, now: number): Promise<RealReceipt> {
  bounded(envelope);
  const parsed = await parseCanonical(envelope.receipt_json, envelope.receipt_hash); receiptSchema(parsed);
  const value = parsed as RealReceipt, action = proposal.actions[0];
  const target = action?.type === 'quit_app' ? body.candidates.find(candidate => candidate.candidate_id === action.candidate_id)! : null;
  requireValue(value.client_request_id === body.client_request_id && value.request_id === request.request_id && value.request_hash === requestHash &&
    value.plan_id === proposal.plan_id && value.plan_hash === proposalHash && value.candidate_id === (target?.candidate_id ?? null));
  const started = instant(value.started_at), completed = instant(value.completed_at), expiry = instant(proposal.expires_at), created = instant(body.created_at);
  requireValue(started >= created && completed >= started && completed - started <= 180_000 && completed <= now + FUTURE_SKEW && completed <= expiry + 180_000);
  const approval = value.local_approval_at === null ? null : instant(value.local_approval_at);
  requireValue(approval === null || (approval >= created && approval <= started));
  const attempted = value.quit_requested, observed = value.outcome === 'observed', confirmed = value.outcome === 'quit_confirmed';
  const refused = value.outcome === 'quit_refused_or_timed_out', cancelled = value.outcome === 'cancelled';
  requireValue(!((confirmed || refused) && !attempted) && !(attempted && !confirmed && !refused && !cancelled) &&
    !(confirmed && !value.process_exit_confirmed) && !(value.process_exit_confirmed && (!attempted || (!confirmed && !cancelled))));
  requireValue(!(attempted && proposal.decision !== 'recommend_quit') && !(observed && proposal.decision !== 'observe') &&
    !(value.outcome === 'no_action' && proposal.decision !== 'no_action') && !(proposal.decision === 'no_action' && value.outcome !== 'no_action' && !cancelled));
  requireValue(!(attempted || observed) || (approval !== null && started <= expiry));
  requireValue((value.outcome !== 'declined' && value.outcome !== 'no_action') || approval === null);
  requireValue(!((confirmed || observed) && value.after === null) && !(!confirmed && !observed && !refused && !cancelled && value.after !== null));
  requireValue(!(confirmed || observed) || completed - started >= 60_000);
  const observation = (item: RealObservation, after: boolean) => {
    const timestamp = instant(item.observed_at);
    requireValue(after ? timestamp === completed : timestamp <= started + 1000); snapshot(item.snapshot, timestamp);
    if (target === null) requireValue(item.candidate === null);
    else {
      requireValue(item.candidate !== null); stableCandidate(item.candidate, target); observedAt(item.candidate.observed_at, timestamp, 30_000);
      const unavailable = item.candidate.cpu_basis_points === null && item.candidate.resident_bytes === null && item.candidate.interval_ms === null;
      const available = item.candidate.cpu_basis_points !== null && item.candidate.resident_bytes !== null && item.candidate.interval_ms !== null;
      if (after && value.process_exit_confirmed) requireValue(unavailable && item.candidate.observed_at === value.completed_at);
      else if (after && unavailable) requireValue(item.candidate.observed_at === value.completed_at);
      else requireValue(available);
    }
    if (!after && attempted) {
      observedAt(item.observed_at, started, 5000); requireValue(item.candidate !== null); observedAt(item.candidate.observed_at, started, 5000);
      requireValue((item.candidate.cpu_basis_points ?? 0) >= 2500 || (item.candidate.resident_bytes ?? 0) >= 536_870_912);
    }
  };
  observation(value.before, false); if (value.after !== null) observation(value.after, true);
  return value;
}

export function readRealInitial(input: unknown, now: number): RealInitial {
  requireValue(Number.isFinite(now)); const value = structuredClone(input);
  record({ schema_version: oneOf(2), kind: oneOf('stats_tunnel_panel'), synthetic: bool, connection: connectionSchema, subscription_ready: bool,
    real_enabled: bool, real_subscription_ready: bool, native_collection_available: bool })(value);
  const initial = value as RealInitial;
  requireValue(initial.synthetic === !initial.real_enabled); connection(initial.connection, now);
  return initial;
}

export async function readRealResult(input: unknown, now: number, expectedConnection: Connection, binding: IntentBinding | null, requestBinding: Binding | null = null, proposalHash: string | null = null): Promise<RealResult> {
  requireValue(Number.isFinite(now)); const value = structuredClone(input);
  record({ schema_version: oneOf(1), kind: oneOf('stats_global_panel_result'), synthetic: oneOf(false), connection: connectionSchema,
    intent: intentSchema, intent_hash: hash, status: oneOf('awaiting_native', 'awaiting_consent', 'requested', 'proposed', 'declined', 'cancelled', 'expired'),
    data: nullable(dataSchema), result_bundle: nullable(bundleSchema) })(value);
  const result = value as RealWireResult;
  connection(result.connection, now, expectedConnection);
  const intent = result.intent, created = instant(intent.created_at), expiry = instant(intent.expires_at);
  lifetime(created, expiry, now, true); requireValue(expiry <= instant(result.connection.expires_at));
  requireValue(await digest(intent) === result.intent_hash);
  requireValue(!binding || (intent.intent_id === binding.intent_id && result.intent_hash === binding.intent_hash));
  const data = result.data;
  if (data === null) {
    requireValue(result.result_bundle === null && requestBinding === null && proposalHash === null && !['requested', 'proposed'].includes(result.status));
    requireValue(!['awaiting_native', 'awaiting_consent'].includes(result.status) || expiry > now);
    requireValue(result.status !== 'expired' || expiry <= now);
    return { ...result, parsedBody: null, parsedPlan: null, parsedReceipt: null };
  }
  requireValue(result.status === data.status);
  requireValue(!requestBinding || (data.request.request_id === requestBinding.request_id && data.request_hash === requestBinding.request_hash));
  const historical = data.status === 'expired' || data.status === 'cancelled';
  const body = await requestBody(data.request, data.request_hash, now, historical);
  requireValue(body.client_request_id === intent.intent_id && instant(body.created_at) >= created && instant(body.consent.confirmed_at) >= created && instant(body.expires_at) <= expiry);
  let parsedPlan: RealPlan | null = null, verifiedPlanHash: string | null = null;
  if (data.status === 'proposed') {
    requireValue(data.proposal !== null && data.proposal_hash !== null && result.result_bundle !== null);
    await plan(data.proposal, data.request, data.request_hash, body, data.proposal_hash, now, false);
    parsedPlan = data.proposal; verifiedPlanHash = data.proposal_hash;
  } else requireValue(data.proposal === null && data.proposal_hash === null);
  if (result.result_bundle !== null) {
    requireValue(data.status !== 'requested'); bounded(result.result_bundle);
    const bundle = result.result_bundle;
    const bundledRequest = await parseCanonical(bundle.request_json, bundle.request_hash);
    requireValue(bundle.request_hash === data.request_hash && canonical(bundledRequest) === canonical(data.request));
    const bundledPlan = await parseCanonical(bundle.proposal_json, bundle.proposal_hash); planSchema(bundledPlan);
    await plan(bundledPlan as RealPlan, data.request, data.request_hash, body, bundle.proposal_hash, now, historical);
    requireValue(parsedPlan === null || (verifiedPlanHash === bundle.proposal_hash && canonical(parsedPlan) === canonical(bundledPlan)));
    parsedPlan = bundledPlan as RealPlan; verifiedPlanHash = bundle.proposal_hash;
  }
  requireValue(!proposalHash || proposalHash === verifiedPlanHash);
  if (data.status === 'expired') requireValue(instant(data.request.expires_at) <= now || (parsedPlan !== null && instant(parsedPlan.expires_at) <= now));
  let parsedReceipt: RealReceipt | null = null;
  if (data.receipt !== null) {
    requireValue(parsedPlan !== null && verifiedPlanHash !== null && data.receipt_hash === data.receipt.receipt_hash);
    parsedReceipt = await receipt(data.receipt, data.request, data.request_hash, body, parsedPlan, verifiedPlanHash, now);
  } else requireValue(data.receipt_hash === null);
  return { ...result, parsedBody: body, parsedPlan, parsedReceipt };
}
