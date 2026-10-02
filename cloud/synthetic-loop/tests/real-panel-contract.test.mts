import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { canonical, digest } from '../bridge/core.mts';
import { realStringHash, type RealDiagnosticBody, type RealDiagnosticRequest, type RealPlan, type RealReceipt, type RealReceiptEnvelope } from '../bridge/real-contract.mts';
import { readRealInitial, readRealResult } from '../ui/real-panel-contract.mts';

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'));
const goldenRequest = fixture('real-request-v1.json');
const goldenBundle = fixture('real-result-v1.json');
const goldenReceipt = fixture('real-receipt-v1.json');
const vectors = fixture('real-vectors-v1.json');
const body = JSON.parse(goldenRequest.client_request_json) as RealDiagnosticBody;
// An intent precedes the one-shot consent. Keep the golden metric observations,
// but move consent to collection start so the ten-minute intent contains it.
body.consent.confirmed_at = body.created_at;
const request = JSON.parse(goldenBundle.request_json) as RealDiagnosticRequest;
request.client_request = { ...goldenRequest, client_request_json: canonical(body), client_request_hash: digest(body) };
const plan = { ...JSON.parse(goldenBundle.proposal_json), request_hash: digest(request) } as RealPlan;
const receipt = { ...JSON.parse(goldenReceipt.receipt_json), request_hash: digest(request), plan_hash: digest(plan) } as RealReceipt;
const now = Date.parse(vectors.test_clock), receiptNow = Date.parse(vectors.receipt_clock);
const at = (offset: number) => new Date(Date.parse(body.created_at) + offset).toISOString();
const otherID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const badHash = '0'.repeat(64);
const connection = { state: 'online' as const, instance_id: '00000030-1111-4111-8111-111111111111', expires_at: at(1_800_000) };
const intent = { schema_version: 1 as const, kind: 'stats_global_collection_intent' as const, intent_id: body.client_request_id, created_at: body.created_at, expires_at: body.expires_at, consent_scope: 'global_diagnostics_v1' as const };
const intentBinding = { intent_id: intent.intent_id, intent_hash: digest(intent) };
const requestBinding = { request_id: request.request_id, request_hash: digest(request) };
const initial = () => ({ schema_version: 2, kind: 'stats_tunnel_panel', synthetic: false, connection: structuredClone(connection), subscription_ready: true, real_enabled: true, real_subscription_ready: true, native_collection_available: true });
const wrapReceipt = (value: unknown): RealReceiptEnvelope => ({ schema_version: 1, kind: 'stats_real_receipt_envelope', receipt_json: canonical(value), receipt_hash: digest(value) });
function bundleFor(value: RealDiagnosticRequest, proposal: RealPlan) {
  return { schema_version: 1 as const, kind: 'stats_real_result' as const, request_json: canonical(value), request_hash: digest(value), proposal_json: canonical(proposal), proposal_hash: digest(proposal) };
}
function panel(status: 'requested' | 'proposed' = 'proposed', includeReceipt = false) {
  const proposal = status === 'proposed' ? structuredClone(plan) : null;
  const envelope = includeReceipt ? wrapReceipt(receipt) : null;
  return {
    schema_version: 1 as const, kind: 'stats_global_panel_result' as const, synthetic: false as const,
    connection: structuredClone(connection), intent: structuredClone(intent), intent_hash: digest(intent), status,
    data: { request: structuredClone(request), request_hash: digest(request), event_id: 'evt_00000031-1111-4111-8111-111111111111', status,
      proposal, proposal_hash: proposal ? digest(proposal) : null, receipt: envelope, receipt_hash: envelope?.receipt_hash ?? null, execution: 'local_approval_required' as const },
    result_bundle: proposal ? bundleFor(request, proposal) : null,
  };
}
function beforeCollection(status: 'awaiting_native' | 'awaiting_consent' | 'declined' | 'cancelled' | 'expired' = 'awaiting_native') {
  return { ...panel('requested'), status, data: null, result_bundle: null };
}
function withBody(change: (value: RealDiagnosticBody) => void) {
  const value = structuredClone(body); change(value);
  const input = panel('requested');
  input.data.request.client_request = { ...goldenRequest, client_request_json: canonical(value), client_request_hash: digest(value) };
  input.data.request_hash = digest(input.data.request);
  return input;
}
function withPlan(change: (value: RealPlan) => void) {
  const input = panel(); change(input.data.proposal!);
  input.data.proposal_hash = digest(input.data.proposal);
  input.result_bundle = bundleFor(input.data.request, input.data.proposal!);
  return input;
}
function withReceipt(change: (value: RealReceipt) => void) {
  const value = structuredClone(receipt); change(value);
  const input = panel('proposed', true); input.data.receipt = wrapReceipt(value); input.data.receipt_hash = input.data.receipt.receipt_hash;
  return input;
}
const read = (input: unknown, clock = now) => readRealResult(input, clock, connection, intentBinding);

test('real browser initial state validates the capability flags and clones the wire value', () => {
  const input = initial(), parsed = readRealInitial(input, now);
  assert.deepEqual(parsed, input); assert.notEqual(parsed, input); assert.notEqual(parsed.connection, input.connection);
  assert.doesNotThrow(() => readRealInitial({ ...input, synthetic: true, real_enabled: false, real_subscription_ready: false, native_collection_available: false }, now));
  for (const change of [
    (v: any) => { v.schema_version = 1; }, (v: any) => { v.synthetic = true; },
    (v: any) => { v.real_enabled = 'true'; }, (v: any) => { v.real_subscription_ready = 1; },
    (v: any) => { v.native_collection_available = null; }, (v: any) => { delete v.subscription_ready; },
    (v: any) => { v.execute = true; }, (v: any) => { v.connection.instance_id = 'not-a-uuid'; },
    (v: any) => { v.connection.expires_at = at(2_000); }, (v: any) => { v.connection.state = 'offline'; },
    (v: any) => { v.connection.expires_at = '2026-02-30T10:00:00.000Z'; },
    (v: any) => { v.connection.expires_at = '2026-10-01T10:30:00Z'; },
  ]) { const value = initial(); change(value); assert.throws(() => readRealInitial(value, now)); }
  assert.throws(() => readRealInitial(input, Number.NaN));
});

test('real collection metadata states contain no parsed diagnostic, proposal or receipt', async () => {
  for (const status of ['awaiting_native', 'awaiting_consent', 'declined', 'cancelled', 'expired'] as const) {
    const input = beforeCollection(status), parsed = await read(input, status === 'expired' ? Date.parse(intent.expires_at) : now);
    assert.deepEqual(parsed, { ...input, parsedBody: null, parsedPlan: null, parsedReceipt: null });
  }
  const parsed = await readRealResult(beforeCollection(), now, connection, null);
  assert.equal(parsed.intent_hash, digest(intent));
});

test('real requested and proposed results parse the consented golden metrics and exact receipt', async () => {
  const requested = panel('requested'), parsedRequest = await read(requested);
  assert.deepEqual(parsedRequest, { ...requested, parsedBody: body, parsedPlan: null, parsedReceipt: null });
  const proposed = panel('proposed', true);
  const parsed = await readRealResult(proposed, receiptNow, connection, intentBinding, requestBinding, digest(plan));
  assert.deepEqual(parsed, { ...proposed, parsedBody: body, parsedPlan: plan, parsedReceipt: receipt });
  assert.notEqual(parsed.data, proposed.data);
  assert.equal(parsed.parsedBody!.candidates[0].display_name, '演示 Café 🧪');
  assert.equal(parsed.parsedReceipt!.after!.candidate!.cpu_basis_points, null);
  assert.equal(parsed.parsedReceipt!.after!.candidate!.resident_bytes, null);
});

test('real result rejects changed runtime identity, lease, intent, request and proposal pins', async () => {
  const input = panel();
  for (const change of [
    (v: any) => { v.connection.instance_id = otherID; },
    (v: any) => { v.connection.expires_at = at(1_800_001); },
    (v: any) => { v.intent.intent_id = otherID; v.intent_hash = digest(v.intent); },
    (v: any) => { v.intent_hash = badHash; },
    (v: any) => { v.data.request_hash = badHash; },
    (v: any) => { v.data.proposal_hash = badHash; },
  ]) { const value = structuredClone(input); change(value); await assert.rejects(read(value)); }
  await assert.rejects(readRealResult(input, now, connection, { ...intentBinding, intent_hash: badHash }));
  await assert.rejects(readRealResult(input, now, connection, intentBinding, { ...requestBinding, request_id: otherID }));
  await assert.rejects(readRealResult(input, now, connection, intentBinding, { ...requestBinding, request_hash: badHash }));
  await assert.rejects(readRealResult(input, now, connection, intentBinding, requestBinding, badHash));
  await assert.rejects(read(input, Number.NaN));
  await assert.rejects(read(input, Date.parse(connection.expires_at)));
});

test('real wire schemas reject unexpected fields and inconsistent states', async () => {
  const paths = [[], ['connection'], ['intent'], ['data'], ['data', 'request'], ['data', 'request', 'client_request'], ['data', 'proposal'], ['data', 'receipt'], ['result_bundle']];
  for (const path of paths) {
    const input = panel('proposed', true); let value: any = input;
    for (const key of path) value = value[key];
    value.command = 'forbidden';
    await assert.rejects(read(input, receiptNow), path.join('.'));
  }
  for (const change of [
    (v: any) => { v.kind = 'stats_tunnel_panel_result'; }, (v: any) => { v.synthetic = true; },
    (v: any) => { v.status = 'executed'; }, (v: any) => { v.status = 'requested'; },
    (v: any) => { v.data.execution = 'completed'; }, (v: any) => { v.data.event_id = 'evt_' + otherID.replace('-4', '-1'); },
    (v: any) => { v.data.status = 'requested'; }, (v: any) => { v.data.receipt_hash = badHash; },
    (v: any) => { v.data.receipt = null; }, (v: any) => { v.data = null; },
  ]) { const input = panel('proposed', true); change(input); await assert.rejects(read(input, receiptNow)); }
  for (const status of ['requested', 'proposed'] as const) await assert.rejects(read({ ...beforeCollection(), status }));
  await assert.rejects(read({ ...beforeCollection(), result_bundle: panel().result_bundle }));
});

test('real intent bounds and native consent must describe the same collection', async () => {
  for (const change of [
    (v: any) => { v.intent.consent_scope = 'all_data'; },
    (v: any) => { v.intent.expires_at = at(600_001); },
    (v: any) => { v.intent.expires_at = v.intent.created_at; },
    (v: any) => { v.intent.created_at = at(122_001); },
    (v: any) => { v.intent.created_at = '2026-02-30T10:00:00.000Z'; },
  ]) { const input = beforeCollection(); change(input); input.intent_hash = digest(input.intent); await assert.rejects(read(input)); }
  for (const change of [
    (v: RealDiagnosticBody) => { v.client_request_id = otherID; },
    (v: RealDiagnosticBody) => { v.consent.confirmed_at = at(-1); },
    (v: RealDiagnosticBody) => { v.created_at = at(-1); v.consent.confirmed_at = at(-1); v.expires_at = at(599_999); },
  ]) await assert.rejects(read(withBody(change)));
  const shorterIntent = panel('requested'); shorterIntent.intent.expires_at = at(599_999); shorterIntent.intent_hash = digest(shorterIntent.intent);
  await assert.rejects(readRealResult(shorterIntent, now, connection, null));
  await assert.rejects(read(beforeCollection(), Date.parse(intent.expires_at)));
});

test('real browser parses canonical bytes strictly even when every enclosing hash is recomputed', async () => {
  const original = canonical(body);
  for (const text of [
    ' ' + original,
    original.replace('"schema_version":1', '"schema_version":1,"schema_version":1'),
    original.replace('"schema_version":1', '"schema_version":1,"\\u0073chema_version":1'),
    original.replace('"schema_version":1', '"schema_version":1.0'),
    original.replace('Café', 'Caf\\u00e9'),
    original.replace('Café', '\ud800'),
    original.replace('Café', '\\ud800'),
    original.replace('"interval_ms":2000', '"interval_ms":1e309'),
  ]) {
    const input = panel('requested');
    input.data.request.client_request.client_request_json = text;
    input.data.request.client_request.client_request_hash = realStringHash(text);
    input.data.request_hash = digest(input.data.request);
    await assert.rejects(read(input));
  }
  const tooLarge = withBody(v => { v.candidates[0].display_name = '🧪'.repeat(4_096); });
  await assert.rejects(read(tooLarge));
});

test('real metric and candidate validation rejects concealed labels, fabricated availability and unsafe values', async () => {
  for (const change of [
    (v: any) => { v.snapshot.host_cpu_basis_points = 10_001; },
    (v: any) => { v.snapshot.swap_used_bytes = Number.MAX_SAFE_INTEGER + 1; },
    (v: any) => { v.snapshot.disk_free_bytes = -1; },
    (v: any) => { v.snapshot.disk_read_bytes_per_second = 0.5; },
    (v: any) => { v.snapshot.cpu_observed_at = null; },
    (v: any) => { v.snapshot.cpu_observed_at = at(-120_001); },
    (v: any) => { v.snapshot.io_observed_at = body.created_at; },
    (v: any) => { v.candidates[0].display_name = 'hidden\u202e'; },
    (v: any) => { v.candidates[0].display_name = 'line\n'; },
    (v: any) => { v.candidates[0].display_name = '🧪'.repeat(129); },
    (v: any) => { v.candidates[0].pid = 123; },
    (v: any) => { v.candidates[0].cpu_basis_points = null; },
    (v: any) => { v.candidates[0].category = 'protected_app'; },
    (v: any) => { v.candidates[0].measurement_scope = 'all_processes'; },
    (v: any) => { v.candidates[0].interval_ms = 1_499; },
    (v: any) => { v.candidates[0].observed_at = at(-30_001); },
    (v: any) => { v.candidates.push(v.candidates[0]); },
    (v: any) => { v.consumers[2].display_name = 'Private protected application'; },
    (v: any) => { v.consumers[2].quit_candidate_id = v.candidates[0].candidate_id; },
    (v: any) => { v.consumers[0].resident_bytes++; },
    (v: any) => { v.consumers[0].quit_candidate_id = otherID; },
    (v: any) => { v.coverage.helpers_aggregated = true; },
    (v: any) => { v.coverage.sampled_processes = 4_096; },
    (v: any) => { v.capabilities.reverse(); },
    (v: any) => { v.recent_samples.reverse(); },
  ]) await assert.rejects(read(withBody(change)));
  const unavailable = withBody(v => { for (const key of Object.keys(v.snapshot)) (v.snapshot as any)[key] = null; });
  assert.deepEqual((await read(unavailable)).parsedBody!.snapshot, JSON.parse(unavailable.data.request.client_request.client_request_json).snapshot);
});

test('real plans allow only one matching eligible quit target, observation or no action', async () => {
  for (const change of [
    (v: any) => { v.actions = [{ type: 'shell', command: 'arbitrary shell text' }]; },
    (v: any) => { v.actions = [{ type: 'quit_app', candidate_id: body.consumers[2].consumer_id }]; },
    (v: any) => { v.actions = [{ type: 'quit_app', candidate_id: otherID }]; },
    (v: any) => { v.actions.push(v.actions[0]); },
    (v: any) => { v.actions = []; },
    (v: any) => { v.dry_run = true; },
    (v: any) => { v.requires_local_approval = false; },
    (v: any) => { v.policy_id = 'cooperative_quit_v1'; },
    (v: any) => { v.decision = 'observe'; },
    (v: any) => { v.decision = 'no_action'; },
    (v: any) => { v.request_id = otherID; },
    (v: any) => { v.request_hash = badHash; },
    (v: any) => { v.expires_at = at(600_001); },
    (v: any) => { v.expires_at = at(2_000); },
    (v: any) => { v.summary = '🧪'.repeat(1_001); },
  ]) await assert.rejects(read(withPlan(change)));
  for (const [decision, actions] of [['observe', [{ type: 'observe_metrics' }]], ['no_action', []]] as const) {
    const input = withPlan(v => { v.decision = decision; v.actions = actions.map(action => ({ ...action })); });
    assert.equal((await read(input)).parsedPlan!.decision, decision);
  }
  for (const [cpu, memory, allowed] of [[2_499, 536_870_911, false], [2_500, 0, true], [0, 536_870_912, true]] as const) {
    const input: any = withBody(v => { v.candidates[0].cpu_basis_points = v.consumers[0].cpu_basis_points = cpu; v.candidates[0].resident_bytes = v.consumers[0].resident_bytes = memory; });
    input.status = input.data.status = 'proposed'; input.data.proposal = { ...plan, request_hash: input.data.request_hash };
    input.data.proposal_hash = digest(input.data.proposal); input.result_bundle = bundleFor(input.data.request, input.data.proposal);
    if (allowed) assert.equal((await read(input)).parsedPlan!.decision, 'recommend_quit');
    else await assert.rejects(read(input));
  }
});

test('real result bundles bind canonical request and proposal bytes to the visible result', async () => {
  await assert.rejects(read({ ...panel(), result_bundle: null }));
  for (const change of [
    (v: any) => { v.result_bundle.request_hash = badHash; },
    (v: any) => { v.result_bundle.proposal_hash = badHash; },
    (v: any) => { v.result_bundle.request_json = ' ' + v.result_bundle.request_json; v.result_bundle.request_hash = realStringHash(v.result_bundle.request_json); },
    (v: any) => { v.result_bundle.proposal_json = ' ' + v.result_bundle.proposal_json; v.result_bundle.proposal_hash = realStringHash(v.result_bundle.proposal_json); },
    (v: any) => { const p = { ...plan, summary: 'Different immutable proposal' }; v.result_bundle.proposal_json = canonical(p); v.result_bundle.proposal_hash = digest(p); },
    (v: any) => { const r = { ...request, request_id: otherID }; v.result_bundle.request_json = canonical(r); v.result_bundle.request_hash = digest(r); },
  ]) { const input = panel(); change(input); await assert.rejects(read(input)); }
});

test('real receipt hashes, identities and before/after targets cannot be substituted', async () => {
  for (const key of ['client_request_id', 'request_id', 'request_hash', 'plan_id', 'plan_hash', 'candidate_id'] as const) {
    await assert.rejects(read(withReceipt(v => { v[key] = key.includes('hash') ? badHash : otherID; }), receiptNow));
  }
  for (const side of ['before', 'after'] as const) {
    for (const change of [
      (v: any) => { v[side].candidate.candidate_id = body.candidates[1].candidate_id; },
      (v: any) => { v[side].candidate.display_name = 'Different app'; },
      (v: any) => { v[side].candidate.category = 'protected_app'; },
      (v: any) => { v[side].candidate.pid = 123; },
    ]) await assert.rejects(read(withReceipt(change), receiptNow));
  }
  for (const mutate of [
    (v: any) => { v.data.receipt.receipt_hash = badHash; v.data.receipt_hash = badHash; },
    (v: any) => { v.data.receipt_hash = digest(v.data.receipt); },
    (v: any) => { const e = v.data.receipt; e.receipt_json = e.receipt_json.replace('"schema_version":1', '"schema_version":1,"schema_version":1'); e.receipt_hash = realStringHash(e.receipt_json); v.data.receipt_hash = e.receipt_hash; },
  ]) { const input = panel('proposed', true); mutate(input); await assert.rejects(read(input, receiptNow)); }
});

test('real receipt validation rejects dishonest success, missing approval and fabricated after metrics', async () => {
  for (const change of [
    (v: any) => { v.outcome = 'observed'; },
    (v: any) => { v.quit_requested = false; },
    (v: any) => { v.process_exit_confirmed = false; },
    (v: any) => { v.local_approval_at = null; },
    (v: any) => { v.local_approval_at = at(30_001); },
    (v: any) => { v.completed_at = at(29_999); },
    (v: any) => { v.completed_at = at(210_001); },
    (v: any) => { v.after = null; },
    (v: any) => { v.after.candidate.cpu_basis_points = 0; },
    (v: any) => { v.after.candidate.resident_bytes = 0; },
    (v: any) => { v.after.candidate.interval_ms = 2_000; },
    (v: any) => { v.after.observed_at = at(90_001); },
    (v: any) => { v.before.observed_at = at(24_999); v.before.candidate.observed_at = at(24_999); },
    (v: any) => { v.before.candidate.cpu_basis_points = 2_499; v.before.candidate.resident_bytes = 536_870_911; },
    (v: any) => { v.before.snapshot.cpu_observed_at = at(-100_000); },
    (v: any) => { v.executed_command = 'forbidden'; },
  ]) await assert.rejects(read(withReceipt(change), receiptNow));
  const declined = withReceipt(v => { v.outcome = 'declined'; v.local_approval_at = null; v.quit_requested = false; v.process_exit_confirmed = false; v.after = null; v.completed_at = v.started_at; });
  assert.equal((await read(declined, receiptNow)).parsedReceipt!.outcome, 'declined');
});

test('expired and cancelled results retain a validated historical plan and receipt without an active proposal', async () => {
  for (const status of ['expired', 'cancelled'] as const) {
    const input: any = panel('proposed', true); input.status = input.data.status = status;
    input.data.proposal = null; input.data.proposal_hash = null;
    const parsed = await readRealResult(input, Date.parse(at(720_001)), connection, intentBinding, requestBinding, digest(plan));
    assert.equal(parsed.status, status); assert.equal(parsed.data!.proposal, null);
    assert.deepEqual(parsed.parsedBody, body); assert.deepEqual(parsed.parsedPlan, plan); assert.deepEqual(parsed.parsedReceipt, receipt);
    await assert.rejects(readRealResult(input, Date.parse(at(720_001)), connection, intentBinding, requestBinding, badHash));
    const missingHistory = structuredClone(input); missingHistory.result_bundle = null;
    await assert.rejects(read(missingHistory, Date.parse(at(720_001))));
    const changedHistory = structuredClone(input), otherPlan = { ...plan, summary: 'Replaced historical recommendation' };
    changedHistory.result_bundle.proposal_json = canonical(otherPlan); changedHistory.result_bundle.proposal_hash = digest(otherPlan);
    await assert.rejects(read(changedHistory, Date.parse(at(720_001))));
  }
});
