import { validateScope, verifyMetadata } from './identity.mts';
import type { Scope } from './identity.mts';
import { parseStrictJson } from '../bridge/json.mts';

// Same official read-only endpoint as v0.0.15 admin.GetTunnel, without starting
// the full client. The endpoint and method cannot be configured by callers.
export async function verifyRemoteScope(scope: Scope, key: string, signal: AbortSignal, request: typeof fetch = fetch): Promise<void> {
  validateScope(scope);
  const abort = AbortSignal.any([signal, AbortSignal.timeout(35_000)]);
  let response: Response;
  try {
    response = await request(`https://api.openai.com/v1/tunnels/${scope.tunnel_id}`, {
      method: 'GET', redirect: 'error', signal: abort,
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
    });
  } catch { throw new Error('tunnel_metadata_unavailable'); }
  if (response.status !== 200 || !response.body) { await response.body?.cancel(); throw new Error('tunnel_metadata_rejected'); }
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) {
      abort.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 65_536) throw new Error('tunnel_metadata_too_large');
      chunks.push(value);
    }
    verifyMetadata(scope, parseStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))));
  } catch { await reader.cancel().catch(() => {}); throw new Error('tunnel_metadata_invalid'); }
  finally { reader.releaseLock(); }
}
