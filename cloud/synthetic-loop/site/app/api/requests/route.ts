import { jsonBody, newBridge, owner, sameOrigin, failure } from '@/bridge/http';
import { principal } from '@/bridge/core.mts';
export async function POST(request: Request) { try { sameOrigin(request); return Response.json(await newBridge().create(principal(owner(request)), await jsonBody(request)), { status: 201, headers: { 'Cache-Control': 'no-store' } }); } catch (e) { return failure(e); } }
export async function GET(request: Request) { try { return Response.json(await newBridge().read(principal(owner(request)), new URL(request.url).searchParams.get('request_id') ?? ''), { headers: { 'Cache-Control': 'no-store' } }); } catch (e) { return failure(e); } }
export async function DELETE(request: Request) { try { sameOrigin(request); return Response.json(await newBridge().cancel(principal(owner(request)), new URL(request.url).searchParams.get('request_id') ?? ''), { headers: { 'Cache-Control': 'no-store' } }); } catch (e) { return failure(e); } }
