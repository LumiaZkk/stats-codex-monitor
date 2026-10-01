import { createHash } from 'node:crypto';
import { Fault, canonical, digest, object, validate, type Schema } from './core.mts';
import { parseStrictJson } from './json.mts';

export const REAL_MAX_FRAME_BYTES = 16_384;
const FUTURE_CLOCK_SKEW_MS = 120_000;
const OBSERVATION_CLOCK_SKEW_MS = 1_000;
const MAX_REQUEST_LIFETIME_MS = 600_000;
const MAX_RECEIPT_DURATION_MS = 180_000;
const uuid: Schema = { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' };
const hash: Schema = { type: 'string', pattern: '^[0-9a-f]{64}$' };
const instant: Schema = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$' };
const nullable = (schema: Schema): Schema => ({ oneOf: [schema, { const: null }] });
const integer = (minimum: number, maximum: number): Schema => ({ type: 'integer', minimum, maximum });
const bytes = nullable(integer(0, Number.MAX_SAFE_INTEGER));

export const REAL_STREAM_ID = 'global-device-v1';
export const REAL_POLICY_ID = 'local_capabilities_v1';
export type RealSnapshot = {
  host_cpu_basis_points: number | null; cpu_observed_at: string | null;
  memory_pressure: 'normal' | 'warning' | 'critical' | null; swap_used_bytes: number | null; memory_observed_at: string | null;
  disk_free_bytes: number | null; disk_observed_at: string | null;
  disk_read_bytes_per_second: number | null; disk_write_bytes_per_second: number | null; io_observed_at: string | null;
};
export type RealCandidate = {
  candidate_id: string; display_name: string; category: 'ordinary_gui_app'; cpu_basis_points: number; resident_bytes: number;
  interval_ms: number; observed_at: string; measurement_scope: 'main_process_only';
};
export type RealReceiptCandidate = Omit<RealCandidate, 'cpu_basis_points' | 'resident_bytes' | 'interval_ms'> & {
  cpu_basis_points: number | null; resident_bytes: number | null; interval_ms: number | null;
};
export type RealConsumer = {
  consumer_id: string; display_name: string; category: 'ordinary_gui_app' | 'protected_app' | 'system_process' | 'app_helper' | 'unknown_process';
  cpu_basis_points: number; resident_bytes: number; interval_ms: number; observed_at: string;
  measurement_scope: 'single_process'; quit_candidate_id: string | null;
};
export type RealDiagnosticBody = {
  schema_version: 1; kind: 'stats_real_diagnostic'; client_request_id: string; created_at: string; expires_at: string;
  consent: { scope: 'global_diagnostics_v1'; confirmed_at: string }; snapshot: RealSnapshot; candidates: RealCandidate[]; consumers: RealConsumer[];
  coverage: { scope: 'visible_processes_bounded'; pid_limit: 4096; sampled_processes: number; unavailable_processes: number; truncated: boolean; helpers_aggregated: false };
  recent_samples: Array<{ observed_at: string; host_cpu_basis_points: number | null; memory_pressure: RealSnapshot['memory_pressure'] }>;
  capabilities: ['quit_app', 'observe_metrics'];
};
export type RealRequestEnvelope = { schema_version: 1; kind: 'stats_real_request'; client_request_json: string; client_request_hash: string };
export type RealDiagnosticRequest = { schema_version: 2; request_id: string; stream_id: 'global-device-v1'; synthetic: false; created_at: string; expires_at: string; client_request: RealRequestEnvelope };
export type RealPlan = {
  schema_version: 2; request_id: string; request_hash: string; plan_id: string; expires_at: string; dry_run: false;
  requires_local_approval: true; policy_id: 'local_capabilities_v1'; decision: 'recommend_quit' | 'observe' | 'no_action'; summary: string;
  actions: Array<{ type: 'quit_app'; candidate_id: string } | { type: 'observe_metrics' }>;
};
export type RealResultBundle = { schema_version: 1; kind: 'stats_real_result'; request_json: string; request_hash: string; proposal_json: string; proposal_hash: string };
export type RealObservation = { observed_at: string; snapshot: RealSnapshot; candidate: RealReceiptCandidate | null };
export type RealReceipt = {
  schema_version: 1; kind: 'stats_real_receipt'; receipt_id: string; client_request_id: string; request_id: string; request_hash: string;
  plan_id: string; plan_hash: string; candidate_id: string | null; policy_id: 'local_capabilities_v1'; started_at: string; completed_at: string;
  local_approval_at: string | null; outcome: 'no_action' | 'observed' | 'declined' | 'cancelled' | 'precondition_failed' | 'quit_refused_or_timed_out' | 'quit_confirmed';
  quit_requested: boolean; process_exit_confirmed: boolean; before: RealObservation; after: RealObservation | null;
};
export type RealReceiptEnvelope = { schema_version: 1; kind: 'stats_real_receipt_envelope'; receipt_json: string; receipt_hash: string };

const name: Schema = { type: 'string', maxLength: 256 };
const cpu = integer(0, 10_240_000);
const hostCPU = nullable(integer(0, 10_000));
const pressure: Schema = { enum: ['normal', 'warning', 'critical', null] };
const interval = integer(1500, 5000);
const boolean: Schema = { enum: [true, false] };
const jsonText: Schema = { type: 'string', maxLength: REAL_MAX_FRAME_BYTES - 1 };
export const realSnapshotSchema = object({
  host_cpu_basis_points: hostCPU, cpu_observed_at: nullable(instant), memory_pressure: pressure, swap_used_bytes: bytes,
  memory_observed_at: nullable(instant), disk_free_bytes: bytes, disk_observed_at: nullable(instant),
  disk_read_bytes_per_second: bytes, disk_write_bytes_per_second: bytes, io_observed_at: nullable(instant),
});
const candidateProperties = {
  candidate_id: uuid, display_name: name, category: { const: 'ordinary_gui_app' }, cpu_basis_points: cpu,
  resident_bytes: integer(0, Number.MAX_SAFE_INTEGER), interval_ms: interval, observed_at: instant, measurement_scope: { const: 'main_process_only' },
};
export const realCandidateSchema = object(candidateProperties);
export const realReceiptCandidateSchema = object({ ...candidateProperties, cpu_basis_points: nullable(cpu), resident_bytes: bytes, interval_ms: nullable(interval) });
export const realConsumerSchema = object({
  consumer_id: uuid, display_name: name, category: { enum: ['ordinary_gui_app', 'protected_app', 'system_process', 'app_helper', 'unknown_process'] },
  cpu_basis_points: cpu, resident_bytes: integer(0, Number.MAX_SAFE_INTEGER), interval_ms: interval, observed_at: instant,
  measurement_scope: { const: 'single_process' }, quit_candidate_id: nullable(uuid),
});
export const realRequestBodySchema = object({
  schema_version: { const: 1 }, kind: { const: 'stats_real_diagnostic' }, client_request_id: uuid, created_at: instant, expires_at: instant,
  consent: object({ scope: { const: 'global_diagnostics_v1' }, confirmed_at: instant }), snapshot: realSnapshotSchema,
  candidates: { type: 'array', maxItems: 5, items: realCandidateSchema }, consumers: { type: 'array', maxItems: 10, items: realConsumerSchema },
  coverage: object({ scope: { const: 'visible_processes_bounded' }, pid_limit: { const: 4096 }, sampled_processes: integer(0, 4096), unavailable_processes: integer(0, 4096), truncated: boolean, helpers_aggregated: { const: false } }),
  recent_samples: { type: 'array', maxItems: 5, items: object({ observed_at: instant, host_cpu_basis_points: hostCPU, memory_pressure: pressure }) },
  capabilities: { type: 'array', minItems: 2, maxItems: 2, items: { enum: ['quit_app', 'observe_metrics'] } },
});
export const realRequestEnvelopeSchema = object({ schema_version: { const: 1 }, kind: { const: 'stats_real_request' }, client_request_json: jsonText, client_request_hash: hash });
export const realDiagnosticRequestSchema = object({ schema_version: { const: 2 }, request_id: uuid, stream_id: { const: REAL_STREAM_ID }, synthetic: { const: false }, created_at: instant, expires_at: instant, client_request: realRequestEnvelopeSchema });
export const realPlanSchema = object({
  schema_version: { const: 2 }, request_id: uuid, request_hash: hash, plan_id: uuid, expires_at: instant,
  dry_run: { const: false }, requires_local_approval: { const: true }, policy_id: { const: REAL_POLICY_ID },
  decision: { enum: ['recommend_quit', 'observe', 'no_action'] }, summary: { type: 'string', maxLength: 2000 },
  actions: { type: 'array', maxItems: 1, items: { oneOf: [object({ type: { const: 'quit_app' }, candidate_id: uuid }), object({ type: { const: 'observe_metrics' } })] } },
});
export const realResultBundleSchema = object({ schema_version: { const: 1 }, kind: { const: 'stats_real_result' }, request_json: jsonText, request_hash: hash, proposal_json: jsonText, proposal_hash: hash });
export const realObservationSchema = object({ observed_at: instant, snapshot: realSnapshotSchema, candidate: nullable(realReceiptCandidateSchema) });
export const realReceiptSchema = object({
  schema_version: { const: 1 }, kind: { const: 'stats_real_receipt' }, receipt_id: uuid, client_request_id: uuid, request_id: uuid, request_hash: hash,
  plan_id: uuid, plan_hash: hash, candidate_id: nullable(uuid), policy_id: { const: REAL_POLICY_ID }, started_at: instant, completed_at: instant,
  local_approval_at: nullable(instant), outcome: { enum: ['no_action', 'observed', 'declined', 'cancelled', 'precondition_failed', 'quit_refused_or_timed_out', 'quit_confirmed'] },
  quit_requested: boolean, process_exit_confirmed: boolean, before: realObservationSchema, after: nullable(realObservationSchema),
});
export const realReceiptEnvelopeSchema = object({ schema_version: { const: 1 }, kind: { const: 'stats_real_receipt_envelope' }, receipt_json: jsonText, receipt_hash: hash });

/** Hash the exact bytes carried in an envelope, never a quoted/re-encoded string. */
export function realStringHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function fail(reason: string, status = 400): never { throw new Fault(reason, status); }

function bounded(value: unknown): void {
  if (Buffer.byteLength(canonical(value), 'utf8') + 1 > REAL_MAX_FRAME_BYTES) fail('real_payload_too_large', 413);
}

function unicodeScalars(value: string): number {
  let count = 0;
  for (const scalar of value) {
    const point = scalar.codePointAt(0)!;
    if (point >= 0xD800 && point <= 0xDFFF) fail('invalid_unicode');
    count++;
  }
  return count;
}

function realDate(value: string, reason = 'invalid_timestamp'): number {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) fail(reason);
  return milliseconds;
}

function clock(now: number): void {
  if (!Number.isFinite(now)) fail('invalid_clock');
}

function validUnicode(value: unknown): void {
  if (typeof value === 'string') unicodeScalars(value);
  else if (Array.isArray(value)) value.forEach(validUnicode);
  else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) { unicodeScalars(key); validUnicode(child); }
  }
}

/** Reject duplicate keys, noncanonical encodings and Unicode replacement ambiguity. */
export function parseRealCanonicalJson(text: string, expectedHash: string): unknown {
  if (Buffer.byteLength(text, 'utf8') + 1 > REAL_MAX_FRAME_BYTES) fail('real_payload_too_large', 413);
  unicodeScalars(text);
  let parsed: unknown;
  try { parsed = parseStrictJson(text); } catch { return fail('invalid_or_duplicate_json'); }
  validUnicode(parsed);
  if (canonical(parsed) !== text) fail('noncanonical_json');
  if (realStringHash(text) !== expectedHash) fail('real_hash_mismatch', 409);
  return parsed;
}

function displayName(value: string): void {
  const length = unicodeScalars(value);
  if (length < 1 || length > 128 || /[\p{Cc}\p{Cf}]/u.test(value)) fail('invalid_display_name');
}

function observedAt(value: string, anchor: number, age: number): number {
  const observed = realDate(value);
  if (observed < anchor - age || observed > anchor + OBSERVATION_CLOCK_SKEW_MS) fail('stale_or_future_observation');
  return observed;
}

function snapshot(value: RealSnapshot, anchor: number): void {
  const group = (values: Array<number | string | null>, timestamp: string | null, maximumAge: number) => {
    if (values.every(value => value === null) !== (timestamp === null)) fail('invalid_metric_availability');
    if (timestamp !== null) observedAt(timestamp, anchor, maximumAge);
  };
  group([value.host_cpu_basis_points], value.cpu_observed_at, 120_000);
  group([value.memory_pressure, value.swap_used_bytes], value.memory_observed_at, 120_000);
  group([value.disk_free_bytes], value.disk_observed_at, 600_000);
  group([value.disk_read_bytes_per_second, value.disk_write_bytes_per_second], value.io_observed_at, 120_000);
}

function requestLifetime(created: number, expires: number, now: number, allowExpired = false): void {
  if (created > now + FUTURE_CLOCK_SKEW_MS || expires <= created || expires - created > MAX_REQUEST_LIFETIME_MS || (!allowExpired && expires <= now)) fail('invalid_real_request_expiry');
}

export function validateRealRequest(value: unknown, now: number, options: { allowExpired?: boolean } = {}): RealDiagnosticBody {
  clock(now); validate(realRequestEnvelopeSchema, value); bounded(value);
  const envelope = value as RealRequestEnvelope;
  const parsed = parseRealCanonicalJson(envelope.client_request_json, envelope.client_request_hash);
  validate(realRequestBodySchema, parsed);
  const body = parsed as RealDiagnosticBody;
  const created = realDate(body.created_at), expires = realDate(body.expires_at);
  requestLifetime(created, expires, now, options.allowExpired);
  const consent = realDate(body.consent.confirmed_at);
  if (consent > created || consent < created - MAX_REQUEST_LIFETIME_MS) fail('invalid_consent_time');
  snapshot(body.snapshot, created);
  if (body.capabilities[0] !== 'quit_app' || body.capabilities[1] !== 'observe_metrics') fail('invalid_capabilities');
  const candidates = new Map<string, RealCandidate>();
  for (const candidate of body.candidates) {
    if (candidates.has(candidate.candidate_id)) fail('duplicate_candidate_id');
    candidates.set(candidate.candidate_id, candidate);
    displayName(candidate.display_name); observedAt(candidate.observed_at, created, 30_000);
  }
  const consumerIDs = new Set<string>(), targetIDs = new Set<string>();
  const categoryNames = { protected_app: 'Protected app', system_process: 'System process', app_helper: 'App helper', unknown_process: 'Other process' };
  for (const consumer of body.consumers) {
    if (consumerIDs.has(consumer.consumer_id)) fail('duplicate_consumer_id');
    consumerIDs.add(consumer.consumer_id);
    displayName(consumer.display_name); observedAt(consumer.observed_at, created, 30_000);
    if (consumer.category !== 'ordinary_gui_app' && consumer.display_name !== categoryNames[consumer.category]) fail('invalid_consumer_label');
    if (consumer.quit_candidate_id !== null) {
      const candidate = candidates.get(consumer.quit_candidate_id);
      if (!candidate || targetIDs.has(consumer.quit_candidate_id) || consumer.category !== 'ordinary_gui_app' ||
          consumer.display_name !== candidate.display_name || consumer.cpu_basis_points !== candidate.cpu_basis_points ||
          consumer.resident_bytes !== candidate.resident_bytes || consumer.interval_ms !== candidate.interval_ms || consumer.observed_at !== candidate.observed_at) fail('invalid_consumer_target');
      targetIDs.add(consumer.quit_candidate_id);
    }
  }
  const coverage = body.coverage;
  if (coverage.sampled_processes + coverage.unavailable_processes > coverage.pid_limit || coverage.sampled_processes < Math.max(body.candidates.length, body.consumers.length)) fail('invalid_coverage');
  let last = -Infinity;
  for (const sample of body.recent_samples) {
    const observed = observedAt(sample.observed_at, created, 300_000);
    if (observed <= last) fail('invalid_recent_sample_order');
    last = observed;
  }
  return body;
}

/** Validate the immutable server wrapper before trusting IDs or plan bindings. */
export function validateRealDiagnosticRequest(value: unknown, requestHash: string, now: number, options: { allowExpired?: boolean } = {}): RealDiagnosticBody {
  clock(now); validate(realDiagnosticRequestSchema, value); validate(hash, requestHash); bounded(value);
  if (Buffer.byteLength(canonical(value), 'utf8') > 14_000) fail('server_request_too_large', 413);
  const request = value as RealDiagnosticRequest;
  if (digest(request) !== requestHash) fail('request_hash_mismatch', 409);
  const body = validateRealRequest(request.client_request, now, options);
  const created = realDate(request.created_at), expires = realDate(request.expires_at);
  requestLifetime(created, expires, now, options.allowExpired);
  if (expires > realDate(body.expires_at) || created < realDate(body.created_at) - FUTURE_CLOCK_SKEW_MS) fail('invalid_server_request_time');
  return body;
}

export function validateRealPlan(value: unknown, request: RealDiagnosticRequest, requestHash: string, now: number, options: { allowExpired?: boolean } = {}): RealPlan {
  const body = validateRealDiagnosticRequest(request, requestHash, now, options);
  validate(realPlanSchema, value); bounded(value);
  if (Buffer.byteLength(canonical(value), 'utf8') > 4096) fail('plan_json_too_large', 413);
  const plan = value as RealPlan;
  if (plan.request_id !== request.request_id || plan.request_hash !== requestHash) fail('request_hash_mismatch', 409);
  if (unicodeScalars(plan.summary) > 1000) fail('invalid_plan_summary');
  const expires = realDate(plan.expires_at, 'invalid_plan_expiry');
  if (expires <= realDate(request.created_at) || expires > realDate(request.expires_at) || (!options.allowExpired && expires <= now)) fail('invalid_plan_expiry');
  const action = plan.actions[0];
  if (plan.decision === 'no_action') {
    if (plan.actions.length !== 0) fail('invalid_plan_actions');
  } else if (plan.decision === 'observe') {
    if (plan.actions.length !== 1 || action?.type !== 'observe_metrics') fail('invalid_plan_actions');
  } else {
    if (plan.actions.length !== 1 || action?.type !== 'quit_app') fail('invalid_plan_actions');
    const candidate = body.candidates.find(candidate => candidate.candidate_id === action.candidate_id);
    if (!candidate) fail('invalid_plan_target');
    if (candidate.cpu_basis_points < 2500 && candidate.resident_bytes < 536_870_912) fail('plan_precondition_failed');
  }
  return plan;
}

export function validateRealResult(value: unknown, now: number, expectedClientRequest?: RealRequestEnvelope): { request: RealDiagnosticRequest; body: RealDiagnosticBody; plan: RealPlan } {
  validate(realResultBundleSchema, value); bounded(value);
  const bundle = value as RealResultBundle;
  const request = parseRealCanonicalJson(bundle.request_json, bundle.request_hash) as RealDiagnosticRequest;
  const body = validateRealDiagnosticRequest(request, bundle.request_hash, now);
  if (expectedClientRequest && canonical(request.client_request) !== canonical(expectedClientRequest)) fail('client_request_mismatch', 409);
  const parsed = parseRealCanonicalJson(bundle.proposal_json, bundle.proposal_hash);
  const plan = validateRealPlan(parsed, request, bundle.request_hash, now);
  return { request, body, plan };
}

function stableCandidate(candidate: RealReceiptCandidate, expected: RealCandidate): void {
  displayName(candidate.display_name);
  if (candidate.candidate_id !== expected.candidate_id || candidate.display_name !== expected.display_name || candidate.category !== expected.category || candidate.measurement_scope !== expected.measurement_scope) fail('receipt_target_mismatch', 409);
}

export function validateRealReceipt(value: unknown, request: RealDiagnosticRequest, requestHash: string, plan: RealPlan, planHash: string, now: number): RealReceipt {
  const body = validateRealDiagnosticRequest(request, requestHash, now, { allowExpired: true });
  validateRealPlan(plan, request, requestHash, now, { allowExpired: true });
  validate(hash, planHash);
  if (digest(plan) !== planHash) fail('plan_hash_mismatch', 409);
  validate(realReceiptEnvelopeSchema, value); bounded(value);
  const envelope = value as RealReceiptEnvelope;
  const parsed = parseRealCanonicalJson(envelope.receipt_json, envelope.receipt_hash);
  validate(realReceiptSchema, parsed);
  const receipt = parsed as RealReceipt;
  const action = plan.actions[0];
  const target = action?.type === 'quit_app' ? body.candidates.find(candidate => candidate.candidate_id === action.candidate_id)! : null;
  if (receipt.client_request_id !== body.client_request_id || receipt.request_id !== request.request_id || receipt.request_hash !== requestHash ||
      receipt.plan_id !== plan.plan_id || receipt.plan_hash !== planHash || receipt.candidate_id !== (target?.candidate_id ?? null)) fail('receipt_binding_mismatch', 409);
  const started = realDate(receipt.started_at), completed = realDate(receipt.completed_at), expires = realDate(plan.expires_at);
  if (started < realDate(body.created_at) || completed < started || completed - started > MAX_RECEIPT_DURATION_MS ||
      completed > now + FUTURE_CLOCK_SKEW_MS || completed > expires + MAX_RECEIPT_DURATION_MS) fail('invalid_receipt_time');
  const approval = receipt.local_approval_at === null ? null : realDate(receipt.local_approval_at);
  if (approval !== null && (approval < realDate(body.created_at) || approval > started)) fail('invalid_local_approval_time');
  const attemptedQuit = receipt.quit_requested;
  const observed = receipt.outcome === 'observed';
  const confirmed = receipt.outcome === 'quit_confirmed', refused = receipt.outcome === 'quit_refused_or_timed_out', cancelled = receipt.outcome === 'cancelled';
  if (((confirmed || refused) && !attemptedQuit) || (attemptedQuit && !confirmed && !refused && !cancelled) ||
      (confirmed && !receipt.process_exit_confirmed) || (receipt.process_exit_confirmed && (!attemptedQuit || (!confirmed && !cancelled)))) fail('invalid_receipt_outcome');
  if ((attemptedQuit && plan.decision !== 'recommend_quit') || (observed && plan.decision !== 'observe') ||
      (receipt.outcome === 'no_action' && plan.decision !== 'no_action') ||
      (plan.decision === 'no_action' && receipt.outcome !== 'no_action' && receipt.outcome !== 'cancelled')) fail('invalid_receipt_outcome');
  if ((attemptedQuit || observed) && (approval === null || started > expires)) fail('missing_or_expired_local_approval');
  if ((receipt.outcome === 'declined' || receipt.outcome === 'no_action') && approval !== null) fail('invalid_local_approval_time');
  if (((confirmed || observed) && receipt.after === null) || (!confirmed && !observed && !refused && !cancelled && receipt.after !== null)) fail('invalid_receipt_after');
  if ((confirmed || observed) && completed - started < 60_000) fail('incomplete_observation_window');
  const observation = (value: RealObservation, after: boolean) => {
    const timestamp = realDate(value.observed_at);
    if (after ? timestamp !== completed : timestamp > started + OBSERVATION_CLOCK_SKEW_MS) fail('invalid_receipt_observation_time');
    snapshot(value.snapshot, timestamp);
    if (target === null) {
      if (value.candidate !== null) fail('receipt_target_mismatch', 409);
    } else {
      if (value.candidate === null) fail('receipt_target_mismatch', 409);
      stableCandidate(value.candidate, target);
      observedAt(value.candidate.observed_at, timestamp, 30_000);
      const unavailable = value.candidate.cpu_basis_points === null && value.candidate.resident_bytes === null && value.candidate.interval_ms === null;
      const available = value.candidate.cpu_basis_points !== null && value.candidate.resident_bytes !== null && value.candidate.interval_ms !== null;
      if (after && receipt.process_exit_confirmed) {
        if (!unavailable || value.candidate.observed_at !== receipt.completed_at) fail('invalid_exited_process_metrics');
      } else if (after && unavailable) {
        if (value.candidate.observed_at !== receipt.completed_at) fail('invalid_receipt_observation_time');
      } else if (!available) fail('invalid_live_process_metrics');
    }
    if (!after && attemptedQuit) {
      observedAt(value.observed_at, started, 5_000);
      if (!value.candidate) fail('receipt_target_mismatch', 409);
      observedAt(value.candidate.observed_at, started, 5_000);
      if ((value.candidate.cpu_basis_points ?? 0) < 2500 && (value.candidate.resident_bytes ?? 0) < 536_870_912) fail('receipt_precondition_failed');
    }
  };
  observation(receipt.before, false);
  if (receipt.after !== null) observation(receipt.after, true);
  return receipt;
}
