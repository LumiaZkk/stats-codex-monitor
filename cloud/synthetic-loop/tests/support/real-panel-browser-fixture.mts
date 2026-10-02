// Local fixture only. It does not contact a tunnel, native app, event service or live account.
// Start after npm run build:panel: node tests/support/real-panel-browser-fixture.mts
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PANEL_HTML, PANEL_CONTENT_HASH } from '../../ui/panel-bundle.mts';
import { canonical } from '../../ui/panel-contract.mts';
import { readRealInitial, readRealResult, type RealInitial } from '../../ui/real-panel-contract.mts';
import type { RealDiagnosticBody, RealDiagnosticRequest, RealPlan, RealReceipt, RealReceiptEnvelope, RealResultBundle } from '../../bridge/real-contract.mts';

const fixtureFile = async (name: string) => JSON.parse(await readFile(new URL(`../../fixtures/${name}`, import.meta.url), 'utf8'));
const goldenBundle = await fixtureFile('real-result-v1.json') as RealResultBundle;
const goldenReceipt = await fixtureFile('real-receipt-v1.json') as RealReceiptEnvelope;
const goldenRequest = JSON.parse(goldenBundle.request_json) as RealDiagnosticRequest;
const goldenBody = JSON.parse(goldenRequest.client_request.client_request_json) as RealDiagnosticBody;
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const iso = (value: number) => new Date(value).toISOString();
const DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
function shift<T>(value: T, delta: number): T {
  if (typeof value === 'string') return (DATE.test(value) ? iso(Date.parse(value) + delta) : value) as T;
  if (Array.isArray(value)) return value.map(item => shift(item, delta)) as T;
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shift(item, delta)])) as T;
  return value;
}

async function fixtures() {
  const now = Date.now(), anchor = now - 95_000, delta = anchor - Date.parse(goldenBody.created_at);
  const initial: RealInitial = {
    schema_version: 2, kind: 'stats_tunnel_panel', synthetic: false,
    connection: { state: 'online', instance_id: randomUUID(), expires_at: iso(now + 1_800_000) },
    subscription_ready: true, real_enabled: true, real_subscription_ready: true, native_collection_available: true,
  };
  readRealInitial(initial, now);
  const request = shift(goldenRequest, delta), body = shift(goldenBody, delta);
  body.client_request_id = randomUUID(); request.request_id = randomUUID();
  const intent = {
    schema_version: 1 as const, kind: 'stats_global_collection_intent' as const, intent_id: body.client_request_id,
    created_at: body.consent.confirmed_at, expires_at: iso(Date.parse(body.consent.confirmed_at) + 600_000),
    consent_scope: 'global_diagnostics_v1' as const,
  };
  body.expires_at = intent.expires_at; request.expires_at = intent.expires_at;
  request.client_request.client_request_json = canonical(body); request.client_request.client_request_hash = hash(body);
  const requestHash = hash(request), plan = shift(JSON.parse(goldenBundle.proposal_json) as RealPlan, delta);
  plan.plan_id = randomUUID(); plan.request_id = request.request_id; plan.request_hash = requestHash; plan.expires_at = request.expires_at;
  const planHash = hash(plan);
  const bundle: RealResultBundle = { schema_version: 1, kind: 'stats_real_result', request_json: canonical(request), request_hash: requestHash, proposal_json: canonical(plan), proposal_hash: planHash };
  const receipt = shift(JSON.parse(goldenReceipt.receipt_json) as RealReceipt, delta);
  receipt.receipt_id = randomUUID(); receipt.client_request_id = body.client_request_id; receipt.request_id = request.request_id;
  receipt.request_hash = requestHash; receipt.plan_id = plan.plan_id; receipt.plan_hash = planHash;
  const receiptEnvelope: RealReceiptEnvelope = { schema_version: 1, kind: 'stats_real_receipt_envelope', receipt_json: canonical(receipt), receipt_hash: hash(receipt) };
  const common = { schema_version: 1 as const, kind: 'stats_global_panel_result' as const, synthetic: false as const, connection: initial.connection, intent, intent_hash: hash(intent) };
  const data = { request, request_hash: requestHash, event_id: `evt_${randomUUID()}`, status: 'requested' as const,
    proposal: null, proposal_hash: null, receipt: null, receipt_hash: null, execution: 'local_approval_required' as const };
  const proposedData = { ...data, status: 'proposed' as const, proposal: plan, proposal_hash: planHash };
  const normal = {
    native: { ...common, status: 'awaiting_native', data: null, result_bundle: null },
    consent: { ...common, status: 'awaiting_consent', data: null, result_bundle: null },
    request: { ...common, status: 'requested', data, result_bundle: null },
    proposal: { ...common, status: 'proposed', data: proposedData, result_bundle: bundle },
    receipt: { ...common, status: 'proposed', data: { ...proposedData, receipt: receiptEnvelope, receipt_hash: receiptEnvelope.receipt_hash }, result_bundle: bundle },
  };
  const nullBody = structuredClone(body), nullRequest = structuredClone(request);
  nullBody.client_request_id = randomUUID(); nullRequest.request_id = randomUUID();
  nullBody.snapshot = { host_cpu_basis_points: null, cpu_observed_at: null, memory_pressure: null, swap_used_bytes: null, memory_observed_at: null,
    disk_free_bytes: null, disk_observed_at: null, disk_read_bytes_per_second: null, disk_write_bytes_per_second: null, io_observed_at: null };
  nullBody.candidates = []; nullBody.consumers = []; nullBody.recent_samples = [];
  nullBody.coverage.sampled_processes = 0; nullBody.coverage.unavailable_processes = 7;
  nullRequest.client_request.client_request_json = canonical(nullBody); nullRequest.client_request.client_request_hash = hash(nullBody);
  const nullIntent = { ...intent, intent_id: nullBody.client_request_id };
  const nullResult = { ...common, intent: nullIntent, intent_hash: hash(nullIntent), status: 'requested', result_bundle: null,
    data: { ...data, request: nullRequest, request_hash: hash(nullRequest), event_id: `evt_${randomUUID()}` } };
  for (const result of [...Object.values(normal), nullResult]) await readRealResult(result, now, initial.connection, null);
  return { initial, normal, nullResult, generatedAt: iso(now), panelHash: PANEL_CONTENT_HASH };
}

const serialized = (value: unknown) => JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
function hostPage(payload: Awaited<ReturnType<typeof fixtures>>): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Stats panel · Local browser fixture</title>
<style>body{margin:0;background:#edf1f4;color:#163243;font:14px system-ui,sans-serif}header{padding:16px 24px;background:#fff;border-bottom:1px solid #cdd7dd}h1{font-size:19px;margin:0 0 8px}.notice{color:#9b3d13;font-weight:700}.controls{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}button{cursor:pointer;border:1px solid #a8bac6;border-radius:7px;background:white;padding:8px 12px;color:#163243}button[aria-pressed=true]{background:#163243;color:white}#fixture-phase{font-weight:700}#panel-frame{width:calc(100% - 32px);margin:16px;border:1px solid #cbd8dc;border-radius:14px;background:white;min-height:780px;display:block}details{margin:12px 24px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:white;padding:16px;max-height:260px;overflow:auto}small{display:block;color:#506672;margin-top:7px}</style></head><body>
<header><h1>Stats real diagnostics panel — browser fixture</h1><div class="notice">FIXTURE ONLY · generated sample data · no live Mac, tunnel, upload, approval or execution</div>
<div class="controls"><button data-phase="consent">Consent</button><button data-phase="request">Request</button><button data-phase="proposal">Proposal</button><button data-phase="receipt">Receipt</button><button data-phase="null">Null metrics · fresh run</button><button data-phase="corrupt">Corrupt hash</button><button data-phase="offline">Offline · SDK error</button><button id="reset">Reset fixture</button></div>
<div>Next tool reply: <span id="fixture-phase">consent</span> · <span id="fixture-handshake">SDK handshake pending</span></div><small>Choose a reply, then start diagnostics in the panel. Active requests poll every 5 seconds. Null metrics reloads the iframe with a separate immutable request. Offline injects a transport protocol error. Reset refreshes timestamps and bindings.</small></header>
<iframe id="panel-frame" title="Production Stats diagnostics panel" sandbox="allow-scripts allow-same-origin"></iframe>
<details open><summary>Fixture protocol log · inert text</summary><pre id="fixture-log"></pre></details>
<script>
'use strict';
const fixtures = ${serialized(payload)};
const origin = location.origin, frame = document.getElementById('panel-frame'), logNode = document.getElementById('fixture-log');
let phase = 'consent', variant = 'normal', current = null, initialized = false;
function log(message, value) { const line = new Date().toISOString() + ' ' + message + (value === undefined ? '' : ' ' + JSON.stringify(value)); logNode.textContent += line + '\\n'; logNode.scrollTop = logNode.scrollHeight; }
function send(message) { if (frame.contentWindow) frame.contentWindow.postMessage(message, origin); }
function toolResult(value) { return { content: [], structuredContent: value }; }
function resetFrame(nextVariant) { variant = nextVariant; current = null; initialized = false; document.getElementById('fixture-handshake').textContent = 'SDK handshake pending'; frame.src = '/panel?run=' + encodeURIComponent(crypto.randomUUID()); }
function select(next) {
  phase = next; document.getElementById('fixture-phase').textContent = next;
  for (const button of document.querySelectorAll('[data-phase]')) button.setAttribute('aria-pressed', String(button.dataset.phase === next));
  log('fixture phase selected', next);
  if (next === 'null') resetFrame('null');
  else if (next === 'offline' && initialized) { log('injecting invalid JSON-RPC transport frame'); send({ jsonrpc: '2.0', id: null }); }
}
for (const button of document.querySelectorAll('[data-phase]')) button.addEventListener('click', () => select(button.dataset.phase));
document.getElementById('reset').addEventListener('click', () => location.reload());
window.addEventListener('message', event => {
  if (event.source !== frame.contentWindow || event.origin !== origin) return;
  const message = event.data;
  if (!message || message.jsonrpc !== '2.0') return;
  if (message.method === 'ui/initialize') {
    log('ui/initialize', message.params);
    if (message.params?.protocolVersion !== '2026-01-26') { send({jsonrpc:'2.0',id:message.id,error:{code:-32602,message:'Unexpected fixture SDK protocol version'}}); return; }
    send({ jsonrpc:'2.0',id:message.id,result:{protocolVersion:'2026-01-26',hostInfo:{name:'stats-local-browser-fixture',version:'1.0.0'},hostCapabilities:{serverTools:{}},hostContext:{theme:'light',displayMode:'inline',availableDisplayModes:['inline','fullscreen'],locale:'zh-CN',timeZone:'Etc/UTC',platform:'web'}} });
  } else if (message.method === 'ui/notifications/initialized') {
    initialized = true; document.getElementById('fixture-handshake').textContent = 'Production SDK connected · 2026-01-26';
    log('SDK initialized; sending validated initial tool result');
    send({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:toolResult(fixtures.initial)});
    if (phase === 'offline') send({jsonrpc:'2.0',id:null});
  } else if (message.method === 'tools/call') {
    const tool = message.params?.name, args = message.params?.arguments ?? {};
    log('tools/call', {name:tool,arguments:args,fixturePhase:phase});
    if (!initialized) { send({jsonrpc:'2.0',id:message.id,error:{code:-32000,message:'Fixture host not initialized'}}); return; }
    if (tool === 'open_diagnostic_panel') { send({jsonrpc:'2.0',id:message.id,result:toolResult(fixtures.initial)}); return; }
    if (!['panel_request_global_diagnostic','panel_get_global_diagnostic','panel_cancel_global_diagnostic'].includes(tool)) { send({jsonrpc:'2.0',id:message.id,error:{code:-32601,message:'Tool unavailable in local fixture'}}); return; }
    if (args.expected_instance_id !== fixtures.initial.connection.instance_id) { send({jsonrpc:'2.0',id:message.id,error:{code:-32602,message:'Fixture runtime binding mismatch'}}); return; }
    const source = variant === 'null' ? fixtures.nullResult : fixtures.normal[['consent','request','proposal','receipt'].includes(phase) ? phase : 'proposal'];
    if (tool !== 'panel_request_global_diagnostic' && (!current || args.intent_id !== current.intent.intent_id || args.intent_hash !== current.intent_hash)) { send({jsonrpc:'2.0',id:message.id,error:{code:-32602,message:'Fixture intent binding mismatch'}}); return; }
    if (phase === 'offline') { send({jsonrpc:'2.0',id:null}); return; }
    let value = structuredClone(source);
    if (tool === 'panel_cancel_global_diagnostic') {
      value = structuredClone(current); value.status = 'cancelled';
      if (value.data) { value.data.status = 'cancelled'; value.data.proposal = null; value.data.proposal_hash = null; }
    } else if (phase === 'corrupt') value.intent_hash = '0'.repeat(64);
    current = value;
    send({jsonrpc:'2.0',id:message.id,result:toolResult(value)});
  } else if (message.method === 'ui/notifications/size-changed') {
    const height = message.params?.height;
    if (Number.isFinite(height)) frame.style.height = Math.max(780, Math.min(height + 8, 8000)) + 'px';
  } else if (message.id !== undefined && !message.method) log('app response', message);
});
log('fixture ready', {generatedAt:fixtures.generatedAt,panelHash:fixtures.panelHash});
select('consent'); resetFrame('normal');
</script></body></html>`;
}

const port = Number(process.env.PORT ?? 8767);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid_fixture_port');
const server = createServer(async (request, response) => {
  try {
    if (request.method !== 'GET') { response.writeHead(405); response.end('GET only'); return; }
    const path = new URL(request.url ?? '/', `http://127.0.0.1:${port}`).pathname;
    if (!['/', '/panel', '/health'].includes(path)) { response.writeHead(404); response.end('Not found'); return; }
    response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Content-Type-Options', 'nosniff');
    if (path === '/health') { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({fixture:true,panelHash:PANEL_CONTENT_HASH})); return; }
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(path === '/panel' ? PANEL_HTML : hostPage(await fixtures()));
  } catch (error) {
    response.writeHead(500, {'Content-Type':'text/plain'}); response.end('Fixture generation failed'); console.error(error);
  }
});
server.listen(port, '127.0.0.1', () => console.log(`Fixture only: http://127.0.0.1:${port}/`));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => server.close(() => process.exit(0)));
