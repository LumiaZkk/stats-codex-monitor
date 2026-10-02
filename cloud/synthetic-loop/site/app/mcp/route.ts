import { rpc } from '@/bridge/mcp.mts';
import { jsonBody, newBridge, owner, failure } from '@/bridge/http';
export async function POST(request: Request) {
  try { const result = await rpc(newBridge(), owner(request), await jsonBody(request)); return Response.json(result, { status: result.error?.code === -32001 ? 401 : 200, headers: { 'Cache-Control': 'no-store' } }); }
  catch (e) { return failure(e); }
}
