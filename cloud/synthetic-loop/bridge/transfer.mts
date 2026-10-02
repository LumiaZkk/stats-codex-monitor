import { parseStrictJson } from './json.mts';
import { Bridge, Fault, canonical, digest } from './core.mts';
import type { NativeTransferRequest } from './core.mts';
export const TRANSFER_MAX_BYTES = 16_384;
// Import/export is an explicit signed-in browser step, never native OAuth pairing.
export async function importNativeRequest(bridge: Bridge, owner: string, payload: unknown) {
  return bridge.create(owner, { idempotency_key: (payload as NativeTransferRequest)?.client_request_id, fixture: 'high-cpu-v1' }, payload as NativeTransferRequest);
}
export async function exportNativeResult(bridge: Bridge, owner: string, requestId: string) {
  const row = await bridge.row(owner, requestId); const result = bridge.public(row);
  if (!row.request.client_request) throw new Fault('not_a_native_transfer', 409);
  if (result.status !== 'proposed' || !result.proposal || !result.proposal_hash) throw new Fault('proposal_not_available', 409);
  const bundle = {
    schema_version: 1, kind: 'stats_synthetic_result', integrity: 'unsigned_sha256',
    client_request: row.request.client_request,
    request_canonical_json: canonical(row.request), request_hash: row.requestHash,
    status: 'proposed', proposal_canonical_json: canonical(result.proposal), proposal_hash: result.proposal_hash,
    exported_at: new Date(bridge.clock()).toISOString(),
  };
  if (Buffer.byteLength(JSON.stringify(bundle)) > TRANSFER_MAX_BYTES) throw new Fault('bundle_too_large', 413);
  return bundle;
}
// Fixed flat ASCII envelope: accept pretty printing, reject duplicate keys/noncanonical escapes.
export function parseNativeRequestFile(text: string): unknown {
  if (new TextEncoder().encode(text).length > TRANSFER_MAX_BYTES) throw new Fault('file_too_large', 413);
  let value: unknown; try { value = parseStrictJson(text); } catch { throw new Fault('invalid_json'); }
  const compact = text.replace(/"(?:\\.|[^"\\])*"|\s+/g, token => token.startsWith('"') ? token : '');
  if (compact !== canonical(value)) throw new Fault('request_file_must_use_sorted_unique_keys');
  return value;
}
export function makeNativeFixture(created: string, expires: string, clientId: string): NativeTransferRequest {
  const body = { schema_version: 1 as const, kind: 'stats_synthetic_request' as const, client_request_id: clientId, fixture: 'high-cpu-v1' as const, created_at: created, expires_at: expires };
  return { ...body, client_request_hash: digest(body) };
}
