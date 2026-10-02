import { EVENT_NAME,STREAM_ID,eventSchema,object,planSchema,requestArgsSchema,validate,Fault } from '../bridge/core.mts';
import type { Schema } from '../bridge/core.mts';
import { TOOLS } from '../bridge/mcp.mts';
import type { McpExtension } from '../bridge/mcp.mts';
import { realRequestEnvelopeSchema,realReceiptEnvelopeSchema,realPlanSchema } from '../bridge/real-contract.mts';
import type { RealRequestEnvelope } from '../bridge/real-contract.mts';
import type { EventSchemas } from '../bridge/events.mts';
import { RealBridge,REAL_STREAM,RECEIPT_EVENT } from './real-store.mts';
import { LOCAL_FRAME_MAX_BYTES } from './native-protocol.mts';
const uuid=requestArgsSchema.properties!.request_id;
const hash:Schema={type:'string',pattern:'^[0-9a-f]{64}$'};
const instant:Schema={type:'string',pattern:'^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$'};
export const REAL_OPS=['diagnose_real','result_real','cancel_real','receipt_real'] as const;
const realFilter=object({stream_id:{const:REAL_STREAM}});
const requestPayload=object({request_id:uuid,request_hash:hash,stream_id:{const:REAL_STREAM},synthetic:{const:false},expires_at:instant});
const receiptPayload=object({...requestPayload.properties,receipt_id:uuid,receipt_hash:hash});
export const realEventSchemas:EventSchemas={
  [EVENT_NAME]:{filter:object({stream_id:{enum:[STREAM_ID,REAL_STREAM]}}),payload:{type:'object',oneOf:[eventSchema,requestPayload]}},
  [RECEIPT_EVENT]:{filter:realFilter,payload:receiptPayload},
};
const common={schema_version:{const:2},expected_instance_id:uuid,client_request:realRequestEnvelopeSchema};
export const realSocketCommandSchema:Schema={oneOf:[
  object({...common,op:{enum:['diagnose_real','result_real','cancel_real']}}),
  object({schema_version:{const:2},expected_instance_id:uuid,op:{const:'receipt_real'},client_request_id:uuid,client_request_hash:hash,request_id:uuid,request_hash:hash,receipt:realReceiptEnvelopeSchema}),
]};
export function realLocal(bridge:RealBridge,owner:string,value:unknown){
  if(Buffer.byteLength(JSON.stringify(value))+1>LOCAL_FRAME_MAX_BYTES)throw new Fault('request_too_large',413);
  validate(realSocketCommandSchema,value);
  const command=value as {op:typeof REAL_OPS[number];client_request:RealRequestEnvelope;client_request_id:string;client_request_hash:string;request_id:string;request_hash:string;receipt?:unknown};
  if(command.op==='receipt_real'){
    const client=bridge.resolveReference(owner,command);
    bridge.receipt(owner,client,command.receipt);return bridge.status(owner,client);
  }
  if(command.op==='diagnose_real')bridge.create(owner,command.client_request);
  if(command.op==='cancel_real')bridge.cancel(owner,command.client_request);
  return bridge.status(owner,command.client_request);
}
export function realExtension(bridge:RealBridge):McpExtension{
  // MCP tool inputs are object schemas. Expose their fields to catalog readers
  // while retaining complete branch validation for both protocol versions.
  const unionProperties={...planSchema.properties,...realPlanSchema.properties,schema_version:{enum:[1,2]},dry_run:{enum:[true,false]},actions:{oneOf:[planSchema.properties!.actions,realPlanSchema.properties!.actions]}};
  const commonRequired=planSchema.required!.filter(key=>realPlanSchema.required!.includes(key));
  const proposalInput:Schema={...object(unionProperties,commonRequired),oneOf:[planSchema,realPlanSchema]};
  const tools=TOOLS.map(t=>{
    if(t.name==='submit_diagnostic_plan')return{...t,description:'Store an immutable proposal for an owned request. Real plans may recommend one allowlisted local action, observation or no action. The server never executes; native local approval is mandatory.',inputSchema:proposalInput};
    if(['get_diagnostic_request','get_diagnostic_result'].includes(t.name))return{...t,description:'Read one owned diagnostic request, immutable proposal and any returned local receipt. Real telemetry is bounded by explicit native consent. A receipt reports local observations and does not prove causation.'};
    if(t.name==='get_native_result_bundle')return{...t,description:'Read an owned immutable canonical result bundle. Hashes bind content; local approval and target-identity checks are still required before any action.'};
    return t;
  });
  return{tools,events:[
    {name:EVENT_NAME,description:'An owned diagnostic request is ready. Synthetic and explicitly consented global real diagnostics use separate stream filters. Payload contains identifiers only; read the request through its tool.',delivery:['webhook'],inputSchema:realEventSchemas[EVENT_NAME].filter,payloadSchema:realEventSchemas[EVENT_NAME].payload},
    {name:RECEIPT_EVENT,description:'An owned native client returned bounded observations and outcome after a locally approved action or no-action decision. Read the receipt; do not infer causation or execute another action.',delivery:['webhook'],inputSchema:realFilter,payloadSchema:receiptPayload},
  ],call:async(name,args,owner)=>{
    const input=args as {request_id?:string;schema_version?:number};
    if(name==='submit_diagnostic_plan'&&input.schema_version===2)return{handled:true,data:bridge.submit(owner,args)};
    if(['get_diagnostic_request','get_diagnostic_result','get_native_result_bundle'].includes(name)&&typeof input.request_id==='string'&&bridge.has(owner,input.request_id))return{handled:true,data:name==='get_native_result_bundle'?bridge.bundle(owner,input.request_id):bridge.read(owner,input.request_id)};
    return{handled:false};
  }};
}
export function assertRealEnabled(enabled:boolean){if(!enabled)throw new Fault('real_data_scope_not_approved',403,-32003);}
