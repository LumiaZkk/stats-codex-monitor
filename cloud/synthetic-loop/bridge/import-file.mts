import { parseStrictJson } from './json.mts';
import type { NativeTransferRequest } from './core.mts';
const fields = ['client_request_hash','client_request_id','created_at','expires_at','fixture','kind','schema_version'];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const hash = /^[0-9a-f]{64}$/;
const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const canonicalFlat = (value: Record<string, unknown>) => '{' + Object.keys(value).sort().map(k => JSON.stringify(k)+':'+JSON.stringify(value[k])).join(',') + '}';
export async function inspectNativeRequestFile(text: string, now = Date.now()): Promise<NativeTransferRequest> {
  const fail = (reason: string): never => { throw new Error(reason); };
  if (new TextEncoder().encode(text).length > 16_384) fail('Request file exceeds 16 KiB');
  let value: Record<string, unknown>; try { value = parseStrictJson(text) as Record<string, unknown>; } catch { return fail('Invalid JSON file'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== fields.join(',')) fail('Only the fixed synthetic request format is accepted; no telemetry or extra fields');
  if (value.schema_version !== 1 || value.kind !== 'stats_synthetic_request' || value.fixture !== 'high-cpu-v1' || typeof value.client_request_id !== 'string' || !uuid.test(value.client_request_id) || typeof value.client_request_hash !== 'string' || !hash.test(value.client_request_hash)) fail('Invalid synthetic request fields');
  const compact = text.replace(/"(?:\\.|[^"\\])*"|\s+/g, token => token.startsWith('"') ? token : '');
  if (compact !== canonicalFlat(value)) fail('Request file must have sorted unique keys and canonical values');
  if (typeof value.created_at !== 'string' || typeof value.expires_at !== 'string' || !instant.test(value.created_at) || !instant.test(value.expires_at)) fail('Invalid request timestamps');
  const created = Date.parse(value.created_at as string), expires = Date.parse(value.expires_at as string);
  if (!Number.isFinite(created) || !Number.isFinite(expires) || new Date(created).toISOString() !== value.created_at || new Date(expires).toISOString() !== value.expires_at || created > now + 120_000 || expires <= now || expires <= created || expires-created > 1_800_000) fail('Request expired or its time window is invalid');
  const { client_request_hash: supplied, ...body } = value;
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalFlat(body)));
  const calculated = [...new Uint8Array(bytes)].map(n => n.toString(16).padStart(2,'0')).join('');
  if (calculated !== supplied) fail('Request hash does not match');
  return value as NativeTransferRequest;
}
