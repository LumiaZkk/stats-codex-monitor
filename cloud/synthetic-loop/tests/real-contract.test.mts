import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { canonical, digest } from '../bridge/core.mts';
import {
  parseRealCanonicalJson, realStringHash, validateRealRequest, validateRealDiagnosticRequest, validateRealPlan,
  validateRealResult, validateRealReceipt, type RealDiagnosticBody, type RealRequestEnvelope,
  type RealDiagnosticRequest, type RealPlan, type RealReceipt, type RealReceiptEnvelope,
} from '../bridge/real-contract.mts';

const fixture = (file: string) => JSON.parse(readFileSync(new URL(`../fixtures/${file}`, import.meta.url), 'utf8'));
const envelope = fixture('real-request-v1.json') as RealRequestEnvelope;
const result = fixture('real-result-v1.json');
const receiptEnvelope = fixture('real-receipt-v1.json') as RealReceiptEnvelope;
const vectors = fixture('real-vectors-v1.json');
const body = JSON.parse(envelope.client_request_json) as RealDiagnosticBody;
const request = JSON.parse(result.request_json) as RealDiagnosticRequest;
const plan = JSON.parse(result.proposal_json) as RealPlan;
const receipt = JSON.parse(receiptEnvelope.receipt_json) as RealReceipt;
const now = Date.parse(vectors.test_clock), receiptNow = Date.parse(vectors.receipt_clock);
const at = (milliseconds: number) => new Date(Date.parse(body.created_at) + milliseconds).toISOString();
const requestEnvelope = (body: unknown): RealRequestEnvelope => ({ schema_version: 1, kind: 'stats_real_request', client_request_json: canonical(body), client_request_hash: digest(body) });
const wrapReceipt = (receipt: unknown): RealReceiptEnvelope => ({ schema_version: 1, kind: 'stats_real_receipt_envelope', receipt_json: canonical(receipt), receipt_hash: digest(receipt) });
const checkReceipt = (value: unknown, proposal = plan) => validateRealReceipt(wrapReceipt(value), request, result.request_hash, proposal, digest(proposal), receiptNow);

test('real cross-language golden canonical strings, hashes, byte lengths and semantic bindings match', () => {
  for (const file of ['real-request-v1.json', 'real-result-v1.json', 'real-receipt-v1.json', 'real-vectors-v1.json']) {
    const text = readFileSync(new URL(`../fixtures/${file}`, import.meta.url), 'utf8');
    assert.equal(text, canonical(JSON.parse(text)) + '\n');
  }
  assert.deepEqual(validateRealRequest(envelope, now), body);
  assert.deepEqual(validateRealDiagnosticRequest(request, result.request_hash, now), body);
  assert.deepEqual(validateRealPlan(plan, request, result.request_hash, now), plan);
  assert.deepEqual(validateRealResult(result, now, envelope), { request, body, plan });
  assert.deepEqual(validateRealReceipt(receiptEnvelope, request, result.request_hash, plan, result.proposal_hash, receiptNow), receipt);
  for (const [prefix, text, hash] of [
    ['client_request', envelope.client_request_json, envelope.client_request_hash], ['request', result.request_json, result.request_hash],
    ['proposal', result.proposal_json, result.proposal_hash], ['receipt', receiptEnvelope.receipt_json, receiptEnvelope.receipt_hash],
  ]) {
    assert.equal(realStringHash(text), hash); assert.equal(vectors[`${prefix}_hash`], hash);
    assert.equal(Buffer.byteLength(text), vectors[`${prefix}_utf8_bytes`]);
  }
});

test('real envelope hashes are exact UTF-8 JSON bytes, not JSON string values', () => {
  const value = { app: '演示 Café 🧪', schema_version: 1 };
  const text = canonical(value);
  assert.deepEqual(parseRealCanonicalJson(text, realStringHash(text)), value);
  assert.equal(realStringHash(text), digest(value));
  assert.notEqual(realStringHash(text), digest(text));
  assert.throws(() => parseRealCanonicalJson(text, digest(text)), /real_hash_mismatch/);
});

test('real canonical JSON rejects duplicate keys, alternative encodings and invalid Unicode', () => {
  for (const text of [
    '{"a":1,"a":1}', '{"a":1,"\\u0061":1}', '{"a":{"x":1,"x":1}}',
    '{ "a":1}', '{"z":1,"a":2}', '{"a":1.0}', '{"a":-0}',
    '{"a":"\\u0061"}', '{"a":"\\ud800"}', '{"a":"\\udfff"}',
    '{"a":"\ud800"}', '{"a":1e309}', '{"a":1,}',
  ]) assert.throws(() => parseRealCanonicalJson(text, realStringHash(text)), text);
});

test('real canonical JSON is bounded in UTF-8 bytes', () => {
  const text = canonical({ value: '🧪'.repeat(4_096) });
  assert.ok(text.length < 16_384);
  assert.throws(() => parseRealCanonicalJson(text, realStringHash(text)), /real_payload_too_large/);
});

test('real requests reject unknown fields at every level and malformed envelope hashes', () => {
  assert.throws(() => validateRealRequest({ ...envelope, pid: 1234 }, now), /invalid_schema/);
  assert.throws(() => validateRealRequest({ ...envelope, client_request_hash: '0'.repeat(64) }, now), /real_hash_mismatch/);
  const paths = [[], ['consent'], ['snapshot'], ['candidates', 0], ['consumers', 0], ['coverage'], ['recent_samples', 0]];
  for (const path of paths) {
    const changed = structuredClone(body);
    let object: any = changed;
    for (const key of path) object = object[key];
    object.bundle_id = 'forbidden.fake.bundle';
    assert.throws(() => validateRealRequest(requestEnvelope(changed), now), /invalid_schema/, path.join('.'));
  }
  const duplicate = envelope.client_request_json.replace('"schema_version":1', '"schema_version":1,"schema_version":1');
  assert.throws(() => validateRealRequest({ ...envelope, client_request_json: duplicate, client_request_hash: realStringHash(duplicate) }, now), /invalid_or_duplicate_json/);
});

test('real request calendar, lifetime, client clock, consent and freshness constraints are enforced', () => {
  const cases: Array<(value: RealDiagnosticBody) => void> = [
    v => { v.created_at = '2026-02-30T10:00:00.000Z'; }, v => { v.expires_at = '2026-02-30T10:00:00.000Z'; },
    v => { v.created_at = at(122001); v.expires_at = at(500000); }, v => { v.expires_at = at(600001); },
    v => { v.expires_at = v.created_at; }, v => { v.expires_at = at(2000); },
    v => { v.consent.confirmed_at = at(1); }, v => { v.consent.confirmed_at = at(-600001); },
    v => { v.snapshot.cpu_observed_at = at(-120001); }, v => { v.snapshot.memory_observed_at = at(-120001); },
    v => { v.snapshot.disk_observed_at = at(-600001); }, v => { v.snapshot.cpu_observed_at = at(1001); },
    v => { v.snapshot.disk_read_bytes_per_second = 1; v.snapshot.io_observed_at = at(-120001); },
    v => { v.candidates[0].observed_at = at(-30001); }, v => { v.consumers[0].observed_at = at(1001); },
    v => { v.recent_samples[0].observed_at = at(-300001); }, v => { v.recent_samples[0].observed_at = '2026-09-31T10:00:00.000Z'; },
  ];
  for (const change of cases) { const value = structuredClone(body); change(value); assert.throws(() => validateRealRequest(requestEnvelope(value), now)); }
  assert.throws(() => validateRealRequest(envelope, Number.NaN), /invalid_clock/);
  assert.throws(() => validateRealRequest(envelope, Date.parse(body.expires_at)), /invalid_real_request_expiry/);
  assert.deepEqual(validateRealRequest(envelope, Date.parse(body.expires_at), { allowExpired: true }), body);
});

test('host metric groups support honest nulls and partial availability but reject fabricated timestamps', () => {
  const unavailable = structuredClone(body);
  for (const key of Object.keys(unavailable.snapshot)) (unavailable.snapshot as any)[key] = null;
  assert.doesNotThrow(() => validateRealRequest(requestEnvelope(unavailable), now));
  unavailable.snapshot.swap_used_bytes = 0; unavailable.snapshot.memory_observed_at = at(-120000);
  unavailable.snapshot.disk_read_bytes_per_second = 0; unavailable.snapshot.io_observed_at = at(-120000);
  assert.doesNotThrow(() => validateRealRequest(requestEnvelope(unavailable), now));
  for (const change of [
    (v: any) => { v.snapshot.cpu_observed_at = at(0); },
    (v: any) => { v.snapshot.memory_observed_at = null; },
    (v: any) => { v.candidates[0].cpu_basis_points = null; },
    (v: any) => { v.candidates[0].resident_bytes = null; },
  ]) { const value = structuredClone(unavailable); change(value); assert.throws(() => validateRealRequest(requestEnvelope(value), now)); }
});

test('real request numeric, Unicode and collection bounds reject unsafe or concealed values', () => {
  const cases: Array<(value: any) => void> = [
    v => { v.snapshot.host_cpu_basis_points = 10001; }, v => { v.snapshot.swap_used_bytes = Number.MAX_SAFE_INTEGER + 1; },
    v => { v.snapshot.disk_free_bytes = -1; }, v => { v.snapshot.disk_read_bytes_per_second = 0.5; },
    v => { v.candidates[0].cpu_basis_points = 10240001; }, v => { v.candidates[0].interval_ms = 1499; },
    v => { v.candidates[0].interval_ms = 5001; }, v => { v.candidates[0].display_name = ''; },
    v => { v.candidates[0].display_name = '🧪'.repeat(129); }, v => { v.candidates[0].display_name = 'hidden\u202e'; },
    v => { v.candidates[0].display_name = 'control\u0085'; }, v => { v.candidates[0].display_name = 'line\n'; },
    v => { v.candidates.push(v.candidates[0]); }, v => { v.consumers.push(v.consumers[0]); },
    v => { v.candidates = Array(6).fill(v.candidates[0]); }, v => { v.consumers = Array(11).fill(v.consumers[0]); },
    v => { v.coverage.sampled_processes = 4096; }, v => { v.coverage.sampled_processes = 0; },
    v => { v.coverage.truncated = 1; }, v => { v.coverage.helpers_aggregated = true; },
    v => { v.capabilities.reverse(); }, v => { v.capabilities[1] = 'quit_app'; },
    v => { v.recent_samples.push(v.recent_samples[0]); }, v => { v.recent_samples.reverse(); },
    v => { v.recent_samples[1].observed_at = v.recent_samples[0].observed_at; },
    v => { v.consumers[2].display_name = 'private custom process name'; },
    v => { v.consumers[2].quit_candidate_id = v.candidates[0].candidate_id; },
    v => { v.consumers[0].quit_candidate_id = 'ffffffff-ffff-4fff-8fff-ffffffffffff'; },
    v => { v.consumers[0].resident_bytes += 1; },
  ];
  for (const change of cases) { const value = structuredClone(body); change(value); assert.throws(() => validateRealRequest(requestEnvelope(value), now)); }
  const maximumName = structuredClone(body);
  maximumName.candidates[0].display_name = '🧪'.repeat(128); maximumName.consumers[0].display_name = maximumName.candidates[0].display_name;
  assert.doesNotThrow(() => validateRealRequest(requestEnvelope(maximumName), now));
});

test('real server requests and result bundles bind exact immutable envelopes', () => {
  assert.throws(() => validateRealDiagnosticRequest({ ...request, request_id: plan.plan_id }, result.request_hash, now), /request_hash_mismatch/);
  const modified = { ...request, client_request: { ...envelope, client_request_hash: '0'.repeat(64) } };
  assert.throws(() => validateRealDiagnosticRequest(modified, digest(modified), now), /real_hash_mismatch/);
  for (const change of [{ expires_at: at(600001) }, { created_at: at(-120001) }, { stream_id: 'synthetic-smoke-v1' }, { synthetic: true }, { pid: 1234 }]) {
    const modified = { ...request, ...change };
    assert.throws(() => validateRealDiagnosticRequest(modified, digest(modified), now));
  }
  const other = requestEnvelope({ ...body, client_request_id: plan.plan_id });
  assert.throws(() => validateRealResult(result, now, other), /client_request_mismatch/);
  assert.throws(() => validateRealResult({ ...result, proposal_hash: '0'.repeat(64) }, now), /real_hash_mismatch/);
  assert.throws(() => validateRealResult({ ...result, request_json: ' ' + result.request_json }, now), /noncanonical_json/);
  assert.throws(() => validateRealResult({ ...result, execution: 'allowed' }, now), /invalid_schema/);
});

test('real plans require a finite capability, matching eligible target and resource precondition', () => {
  for (const change of [
    { request_id: body.client_request_id }, { request_hash: '0'.repeat(64) }, { dry_run: true }, { requires_local_approval: false },
    { policy_id: 'cooperative_quit_v1' }, { actions: [{ type: 'kill', candidate_id: body.candidates[0].candidate_id }] },
    { actions: [] }, { actions: [...plan.actions, ...plan.actions] }, { actions: [{ type: 'quit_app', candidate_id: body.consumers[2].consumer_id }] },
    { expires_at: at(600001) }, { expires_at: at(2000) }, { expires_at: '2026-02-30T10:00:00.000Z' },
    { summary: '🧪'.repeat(1001) }, { summary: '\ud800' }, { command: 'arbitrary shell text' },
    { decision: 'observe', actions: plan.actions }, { decision: 'no_action', actions: plan.actions },
  ]) assert.throws(() => validateRealPlan({ ...plan, ...change }, request, result.request_hash, now));
  assert.doesNotThrow(() => validateRealPlan({ ...plan, decision: 'observe', actions: [{ type: 'observe_metrics' }] }, request, result.request_hash, now));
  assert.doesNotThrow(() => validateRealPlan({ ...plan, decision: 'no_action', actions: [] }, request, result.request_hash, now));
  const low = structuredClone(body); low.candidates[0].cpu_basis_points = 2499; low.candidates[0].resident_bytes = 536870911;
  low.consumers[0].cpu_basis_points = 2499; low.consumers[0].resident_bytes = 536870911;
  const lowRequest = { ...request, client_request: requestEnvelope(low) }, lowHash = digest(lowRequest);
  assert.throws(() => validateRealPlan({ ...plan, request_hash: lowHash }, lowRequest, lowHash, now), /plan_precondition_failed/);
  for (const [cpu, rss] of [[2500, 0], [0, 536870912]]) {
    low.candidates[0].cpu_basis_points = low.consumers[0].cpu_basis_points = cpu;
    low.candidates[0].resident_bytes = low.consumers[0].resident_bytes = rss;
    const thresholdRequest = { ...request, client_request: requestEnvelope(low) }, thresholdHash = digest(thresholdRequest);
    assert.doesNotThrow(() => validateRealPlan({ ...plan, request_hash: thresholdHash }, thresholdRequest, thresholdHash, now));
  }
});

test('real receipts reject cross-request, cross-plan and cross-target substitution', () => {
  for (const key of ['client_request_id', 'request_id', 'request_hash', 'plan_id', 'plan_hash', 'candidate_id'] as const) {
    const changed = { ...receipt, [key]: key.includes('hash') ? '0'.repeat(64) : 'ffffffff-ffff-4fff-8fff-ffffffffffff' };
    assert.throws(() => checkReceipt(changed), /receipt_binding_mismatch/);
  }
  assert.throws(() => validateRealReceipt(receiptEnvelope, request, result.request_hash, plan, '0'.repeat(64), receiptNow), /plan_hash_mismatch/);
  assert.throws(() => validateRealReceipt({ ...receiptEnvelope, receipt_hash: '0'.repeat(64) }, request, result.request_hash, plan, result.proposal_hash, receiptNow), /real_hash_mismatch/);
  for (const side of ['before', 'after'] as const) {
    for (const change of [{ candidate_id: body.candidates[1].candidate_id }, { display_name: 'Different app' }, { category: 'protected_app' }, { measurement_scope: 'all_processes' }]) {
      const value = structuredClone(receipt); Object.assign(value[side]!.candidate!, change);
      assert.throws(() => checkReceipt(value));
    }
    const value = structuredClone(receipt); (value[side]!.candidate! as any).pid = 123;
    assert.throws(() => checkReceipt(value), /invalid_schema/);
  }
});

test('real receipts reject dishonest success, nulls, stale preconditions and invalid timing', () => {
  const cases: Array<(value: any) => void> = [
    v => { v.outcome = 'observed'; }, v => { v.quit_requested = false; }, v => { v.process_exit_confirmed = false; },
    v => { v.quit_requested = 1; }, v => { v.local_approval_at = null; }, v => { v.local_approval_at = at(30001); },
    v => { v.local_approval_at = at(-1); }, v => { v.completed_at = at(29999); }, v => { v.completed_at = at(210001); },
    v => { v.completed_at = '2026-02-30T10:01:30.000Z'; }, v => { v.started_at = at(600001); v.completed_at = at(660001); },
    v => { v.completed_at = at(89999); v.after.observed_at = v.completed_at; v.after.candidate.observed_at = v.completed_at; },
    v => { v.after = null; }, v => { v.after.observed_at = at(90001); }, v => { v.after.candidate.observed_at = at(89999); },
    v => { v.after.candidate.cpu_basis_points = 0; }, v => { v.after.candidate.resident_bytes = 0; }, v => { v.after.candidate.interval_ms = 2000; },
    v => { v.before.candidate.cpu_basis_points = null; }, v => { v.before.candidate.cpu_basis_points = 2499; v.before.candidate.resident_bytes = 536870911; },
    v => { v.before.observed_at = at(24999); v.before.candidate.observed_at = at(24999); },
    v => { v.before.candidate.observed_at = at(24999); }, v => { v.before.snapshot.cpu_observed_at = at(-100000); },
    v => { v.after.snapshot.cpu_observed_at = at(91001); }, v => { v.executed_command = 'unexpected'; },
  ];
  for (const change of cases) { const value = structuredClone(receipt); change(value); assert.throws(() => checkReceipt(value)); }
  assert.throws(() => validateRealReceipt(receiptEnvelope, request, result.request_hash, plan, result.proposal_hash, Date.parse(at(-30001))), /invalid_receipt_time/);
});

test('real receipts honestly represent no action, observation, rejection, cancellation and refusal', () => {
  for (const outcome of ['declined', 'cancelled', 'precondition_failed'] as const) {
    const value: RealReceipt = { ...structuredClone(receipt), outcome, local_approval_at: null, quit_requested: false, process_exit_confirmed: false, after: null, completed_at: receipt.started_at,
      before: { observed_at: body.created_at, snapshot: body.snapshot, candidate: body.candidates[0] } };
    assert.doesNotThrow(() => checkReceipt(value));
    assert.throws(() => checkReceipt({ ...value, quit_requested: true }));
  }
  const refused = structuredClone(receipt); refused.outcome = 'quit_refused_or_timed_out'; refused.process_exit_confirmed = false;
  refused.after!.candidate = { ...body.candidates[0], observed_at: refused.completed_at };
  assert.doesNotThrow(() => checkReceipt(refused));
  assert.doesNotThrow(() => checkReceipt({ ...refused, after: null, completed_at: at(45000) }));
  const unavailableAfter = structuredClone(refused);
  Object.assign(unavailableAfter.after!.candidate!, { cpu_basis_points: null, resident_bytes: null, interval_ms: null });
  assert.doesNotThrow(() => checkReceipt(unavailableAfter));
  for (const field of ['cpu_basis_points', 'resident_bytes', 'interval_ms'] as const) {
    const mixed = structuredClone(unavailableAfter); mixed.after!.candidate![field] = field === 'interval_ms' ? 2000 : 0;
    assert.throws(() => checkReceipt(mixed), /invalid_live_process_metrics/);
  }
  assert.doesNotThrow(() => checkReceipt({ ...unavailableAfter, outcome: 'cancelled' }));
  for (const process_exit_confirmed of [false, true]) {
    const cancelled: RealReceipt = { ...structuredClone(receipt), outcome: 'cancelled', process_exit_confirmed, after: null, completed_at: at(35000) };
    assert.doesNotThrow(() => checkReceipt(cancelled));
    assert.throws(() => checkReceipt({ ...cancelled, local_approval_at: null }), /missing_or_expired_local_approval/);
    assert.throws(() => checkReceipt({ ...cancelled, quit_requested: false, process_exit_confirmed: true }), /invalid_receipt_outcome/);
  }
  const observePlan: RealPlan = { ...plan, decision: 'observe', actions: [{ type: 'observe_metrics' }] };
  const observed: RealReceipt = { ...structuredClone(receipt), plan_hash: digest(observePlan), candidate_id: null, outcome: 'observed', quit_requested: false, process_exit_confirmed: false };
  observed.before.candidate = null; observed.after!.candidate = null;
  assert.doesNotThrow(() => checkReceipt(observed, observePlan));
  assert.throws(() => checkReceipt({ ...observed, local_approval_at: null }, observePlan), /missing_or_expired_local_approval/);
  const noActionPlan: RealPlan = { ...plan, decision: 'no_action', actions: [] };
  const noAction: RealReceipt = { ...observed, plan_hash: digest(noActionPlan), outcome: 'no_action', local_approval_at: null, completed_at: observed.started_at, after: null,
    before: { observed_at: body.created_at, snapshot: body.snapshot, candidate: null } };
  assert.doesNotThrow(() => checkReceipt(noAction, noActionPlan));
  assert.throws(() => checkReceipt({ ...noAction, outcome: 'observed' }, noActionPlan), /invalid_receipt_outcome/);
  assert.doesNotThrow(() => validateRealReceipt(receiptEnvelope, request, result.request_hash, plan, result.proposal_hash, Date.parse(at(720001))));
});
