import { Bridge, Fault, nativeRequestSchema, object, validate, validateNativeRequest } from '../bridge/core.mts';
import type { NativeTransferRequest } from '../bridge/core.mts';
import { exportNativeResult, importNativeRequest } from '../bridge/transfer.mts';
import type { RuntimeStore } from './stores.mts';
import { parseStrictJson } from '../bridge/json.mts';

export const LOCAL_FRAME_MAX_BYTES=16_384;
export const NATIVE_OPS=['diagnose_native','result_native','cancel_native'] as const;
export const nativeSocketCommandSchema=object({schema_version:{const:1},op:{enum:NATIVE_OPS},client_request:nativeRequestSchema});
export type NativeSocketStatus={schema_version:1;kind:'stats_native_socket_status';client_request_id:string;client_request_hash:string;request_id:string;request_hash:string;status:'requested'|'proposed'|'cancelled'|'expired';bundle:Awaited<ReturnType<typeof exportNativeResult>>|null};
export async function nativeSocketStatus(bridge:Bridge,owner:string,client:NativeTransferRequest,id:string):Promise<NativeSocketStatus>{
  const result=await bridge.read(owner,id);
  return {schema_version:1,kind:'stats_native_socket_status',client_request_id:client.client_request_id,client_request_hash:client.client_request_hash,request_id:result.request.request_id,request_hash:result.request_hash,status:result.status as NativeSocketStatus['status'],bundle:result.status==='proposed'?await exportNativeResult(bridge,owner,id):null};
}
export async function nativeLocal(bridge:Bridge,store:RuntimeStore,owner:string,input:unknown):Promise<NativeSocketStatus>{
  validate(nativeSocketCommandSchema,input);
  const command=input as {schema_version:1;op:typeof NATIVE_OPS[number];client_request:NativeTransferRequest},client=command.client_request;
  // Existing bindings remain inspectable after expiry. New insertion still goes
  // through Bridge.create's strict unexpired validation and insertion guard.
  validateNativeRequest(client,bridge.clock(),{allowExpired:true});
  let id=store.nativeRequestId(owner,client);
  if(command.op==='cancel_native')id=store.cancelNativeRequest(owner,client,bridge.clock());
  else if(command.op==='diagnose_native' && !id)id=(await importNativeRequest(bridge,owner,client)).request.request_id;
  if(!id)throw new Fault('not_found',404,-32004);
  return nativeSocketStatus(bridge,owner,client,id);
}
export function localResultFrame(result:unknown):string {
  const frame=JSON.stringify({result})+'\n';
  if(Buffer.byteLength(frame)>LOCAL_FRAME_MAX_BYTES)throw new Fault('response_too_large',413);
  return frame;
}

// A socket may split one frame across chunks. No bytes or later frames are
// silently ignored once the first operation has been dispatched.
export class LocalRequestFrame {
  private bytes=0; private text=''; private complete=false;
  push(chunk:string):{value:unknown}|null {
    this.bytes+=Buffer.byteLength(chunk);
    if(this.bytes>LOCAL_FRAME_MAX_BYTES)throw new Fault('request_too_large',413);
    if(this.complete)throw new Fault('invalid_local_frame');
    this.text+=chunk;const newline=this.text.indexOf('\n');
    if(newline<0)return null;
    this.complete=true;
    if(newline!==this.text.length-1)throw new Fault('invalid_local_frame');
    return {value:parseStrictJson(this.text.slice(0,-1))};
  }
}
