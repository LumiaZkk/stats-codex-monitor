import { EVENT_NAME,STREAM_ID,Fault,object,requestArgsSchema,createSchema } from '../bridge/core.mts';
import type { Bridge } from '../bridge/core.mts';
import type { McpExtension } from '../bridge/mcp.mts';
import type { RuntimeIdentity } from './rendezvous.mts';
import { PANEL_URI,panelResource } from '../ui/panel-resource.mts';
const uuid=requestArgsSchema.properties!.request_id;
const hash={type:'string',pattern:'^[0-9a-f]{64}$'};
const bound=object({expected_instance_id:uuid,request_id:uuid,request_hash:hash});
const annotations=(readOnlyHint:boolean)=>({readOnlyHint,destructiveHint:false,idempotentHint:true,openWorldHint:false});
export const PANEL_TOOLS=[
  {name:'open_diagnostic_panel',title:'Stats 诊断面板',description:'Open the private Tunnel diagnostic panel. This increment creates fixed synthetic requests only. The panel cannot approve or execute local actions.',inputSchema:object({}),annotations:annotations(true),_meta:{ui:{resourceUri:PANEL_URI,visibility:['model','app']},'ui/resourceUri':PANEL_URI,'openai/outputTemplate':PANEL_URI,'openai/ui':{entrypoints:[{type:'global'},{type:'thread'}]}}},
  {name:'panel_create_synthetic_request',description:'Create one fixed synthetic diagnostic request on the current private runtime. Requires the exact live runtime instance and an active synthetic event subscription. No real telemetry or execution.',inputSchema:object({expected_instance_id:uuid,idempotency_key:createSchema.properties!.idempotency_key}),annotations:annotations(false)},
  {name:'panel_get_synthetic_result',description:'Read the same owned synthetic request and immutable proposal by exact runtime instance, request ID and hash. No execution receipt exists for this synthetic test.',inputSchema:bound,annotations:annotations(true)},
  {name:'panel_cancel_synthetic_request',description:'Cancel an owned synthetic request after validating its runtime instance, request ID and hash. This prevents further delivery; it does not undo a callback already accepted.',inputSchema:bound,annotations:annotations(false)},
];
type PanelContext={bridge:Bridge;identity:()=>RuntimeIdentity;boundIdentity:(expected:unknown)=>RuntimeIdentity;subscriptionReady:()=>boolean;reserveDestination:(owner:string,key:string)=>()=>void};
export function panelExtension(context:PanelContext,base:McpExtension):McpExtension {
  const connection=(identity:RuntimeIdentity)=>({state:'online' as const,instance_id:identity.instance_id,expires_at:identity.expires_at});
  const wrap=(data:Awaited<ReturnType<Bridge['read']>>,identity:RuntimeIdentity)=>({schema_version:1,kind:'stats_tunnel_panel_result',synthetic:true,connection:connection(identity),data,receipt:null});
  return {...base,tools:[...(base.tools??[]),...PANEL_TOOLS],resources:{
    list:()=>[{uri:PANEL_URI,name:'stats-diagnostic-panel',title:'Stats 诊断面板',mimeType:'text/html;profile=mcp-app'}],
    read:(uri:unknown)=>{if(uri!==PANEL_URI)throw new Fault('resource_not_found',404,-32002);return [panelResource()];},
  },call:async(name,args,owner)=>{
    if(name==='open_diagnostic_panel')return{handled:true,data:{schema_version:1,kind:'stats_tunnel_panel',synthetic:true,connection:connection(context.identity()),subscription_ready:context.subscriptionReady()}};
    if(PANEL_TOOLS.some(t=>t.name===name)){
      const input=args as {expected_instance_id:string;idempotency_key:string;request_id:string;request_hash:string};
      const identity=context.boundIdentity(input.expected_instance_id);
      if(name==='panel_create_synthetic_request'){
        if(!context.subscriptionReady())throw new Fault('synthetic_subscription_unavailable',409);
        const releaseUncreated=context.reserveDestination(owner,input.idempotency_key);
        try{return{handled:true,data:wrap(await context.bridge.create(owner,{idempotency_key:input.idempotency_key,fixture:'high-cpu-v1'}),identity)};}
        catch(error){releaseUncreated();throw error;}
      }
      const data=await context.bridge.read(owner,input.request_id);
      if(data.request_hash!==input.request_hash)throw new Fault('request_hash_mismatch',409,-32009);
      return{handled:true,data:wrap(name==='panel_cancel_synthetic_request'?await context.bridge.cancel(owner,input.request_id):data,identity)};
    }
    return base.call?.(name,args,owner)??{handled:false};
  }};
}
export const isSyntheticSubscription=(value:{name:string;arguments:{stream_id?:unknown}})=>value.name===EVENT_NAME&&value.arguments.stream_id===STREAM_ID;
