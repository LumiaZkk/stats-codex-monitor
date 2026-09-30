import { nativeTransferPost } from '@/bridge/transfer-http.mts';
import { newBridge, owner, failure } from '@/bridge/http';
import { principal } from '@/bridge/core.mts';
import { exportNativeResult } from '@/bridge/transfer.mts';
export async function POST(request: Request) {
  return nativeTransferPost(request, newBridge);
}
export async function GET(request: Request) {
  try { const id = new URL(request.url).searchParams.get('request_id') ?? ''; const bundle = await exportNativeResult(newBridge(), principal(owner(request)), id); return Response.json(bundle, { headers: { 'Cache-Control': 'no-store', 'Content-Disposition': 'attachment; filename="stats-synthetic-result.json"', 'X-Content-Type-Options': 'nosniff' } }); } catch (e) { return failure(e); }
}
