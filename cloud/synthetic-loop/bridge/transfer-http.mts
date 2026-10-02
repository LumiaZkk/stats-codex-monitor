import { principal } from './core.mts';
import type { Bridge } from './core.mts';
import { jsonBody, owner, sameOrigin, failure } from './http-body.mts';
import { importNativeRequest, parseNativeRequestFile } from './transfer.mts';
// The production route and tests call this same handler. Only tests inject an in-memory store.
export async function nativeTransferPost(request: Request, createBridge: () => Bridge): Promise<Response> {
  try {
    sameOrigin(request); const user = principal(owner(request));
    const payload = await jsonBody(request, parseNativeRequestFile);
    return Response.json(await importNativeRequest(createBridge(), user, payload), { status: 201, headers: { 'Cache-Control': 'no-store' } });
  } catch (e) { return failure(e); }
}
