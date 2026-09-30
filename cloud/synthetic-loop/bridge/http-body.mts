import { Fault } from './core.mts';
import { parseStrictJson } from './json.mts';
export const owner = (r: Request) => r.headers.get('oai-authenticated-user-id');
export async function jsonBody(r: Request, parse: (text: string) => unknown = parseStrictJson) {
  if (!(r.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) throw new Fault('json_required', 415);
  const reader = r.body?.getReader(); if (!reader) throw new Fault('body_required');
  const chunks: Uint8Array[] = []; let count = 0;
  while (true) { const next = await reader.read(); if (next.done) break; count += next.value.byteLength; if (count > 16_384) { await reader.cancel(); throw new Fault('body_too_large', 413); } chunks.push(next.value); }
  const bytes = new Uint8Array(count); let offset = 0; for (const c of chunks) { bytes.set(c, offset); offset += c.length; }
  try { return parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch (e) { if (e instanceof Fault) throw e; throw new Fault('invalid_or_duplicate_json'); }
}
export function sameOrigin(r: Request) { if (r.headers.get('origin') !== new URL(r.url).origin) throw new Fault('origin_required', 403); }
export function failure(e: unknown) { return Response.json({ error: e instanceof Fault ? e.reason : 'storage_unavailable' }, { status: e instanceof Fault ? e.status : 503, headers: { 'Cache-Control': 'no-store' } }); }
