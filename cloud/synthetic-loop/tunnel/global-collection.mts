import { randomUUID } from 'node:crypto';
import { canonical, digest, Fault, object, requestArgsSchema, validate } from '../bridge/core.mts';
import type { Schema } from '../bridge/core.mts';
import type { McpExtension } from '../bridge/mcp.mts';
import { realRequestEnvelopeSchema, validateRealRequest } from '../bridge/real-contract.mts';
import type { RealRequestEnvelope } from '../bridge/real-contract.mts';
import type { RuntimeIdentity } from './rendezvous.mts';
import type { RuntimeStore } from './stores.mts';
import { RealBridge, REAL_STREAM, RECEIPT_EVENT } from './real-store.mts';
import { assertRealEnabled } from './real-protocol.mts';

const uuid=requestArgsSchema.properties!.request_id;
const hash:Schema={type:'string',pattern:'^[0-9a-f]{64}$'};
const binding={expected_instance_id:uuid,intent_id:uuid,intent_hash:hash};
const native={schema_version:{const:2},expected_instance_id:uuid,native_session_id:uuid};
export const COLLECTION_OPS=['next_global_collection_intent','resolve_global_collection_intent','diagnose_real_for_intent'] as const;
export const collectionSocketSchema:Schema={oneOf:[
  object({...native,op:{const:'next_global_collection_intent'}}),
  object({...native,...binding,op:{const:'resolve_global_collection_intent'},decision:{const:'declined'}}),
  object({...native,...binding,op:{const:'diagnose_real_for_intent'},client_request:realRequestEnvelopeSchema}),
]};
export type GlobalCollectionIntent={schema_version:1;kind:'stats_global_collection_intent';intent_id:string;created_at:string;expires_at:string;consent_scope:'global_diagnostics_v1'};
type IntentRow={owner:string;runtime_instance_id:string;idempotency_key:string;intent_id:string;intent_json:string;intent_hash:string;expires_at:string;state:'awaiting_native'|'awaiting_consent'|'declined'|'cancelled';native_session_id:string|null;request_id:string|null;requested_subscription_id:string;receipt_subscription_id:string};
type NativeCommand={op:typeof COLLECTION_OPS[number];native_session_id:string;intent_id:string;intent_hash:string;client_request:RealRequestEnvelope};
const annotations=(readOnlyHint:boolean)=>({readOnlyHint,destructiveHint:false,idempotentHint:true,openWorldHint:false});
export const GLOBAL_COLLECTION_TOOLS=[
  {name:'panel_request_global_diagnostic',description:'Request one global diagnostic collection on the connected Mac. This creates only a fixed metadata intent; the native app must ask for explicit one-shot upload consent. It grants no approval for any action. First open_diagnostic_panel to obtain the runtime instance.',inputSchema:object({expected_instance_id:uuid,idempotency_key:uuid}),annotations:annotations(false)},
  {name:'panel_get_global_diagnostic',description:'Read one exact owned collection intent, immutable real diagnostic proposal and local receipt. A receipt reports observations, not causation. Historical proposals must not be executed.',inputSchema:object(binding),annotations:annotations(true)},
  {name:'panel_cancel_global_diagnostic',description:'Cancel one exact owned collection intent and its diagnostic request. Cancellation blocks later consent/upload; it cannot undo an event accepted or an action already performed.',inputSchema:object(binding),annotations:annotations(false)},
];

export class GlobalCollection {
  readonly store:RuntimeStore;readonly real:RealBridge;
  private readonly instanceID:string|undefined;
  private lastPoll:{owner:string;at:number}|null=null;
  constructor(store:RuntimeStore,real:RealBridge,instanceID?:string){
    this.store=store;this.real=real;this.instanceID=instanceID;
    store.db.exec(`CREATE TABLE IF NOT EXISTS global_collection_intents(
      owner TEXT NOT NULL,runtime_instance_id TEXT NOT NULL DEFAULT '',idempotency_key TEXT NOT NULL,intent_id TEXT NOT NULL UNIQUE,
      intent_json TEXT NOT NULL,intent_hash TEXT NOT NULL,expires_at TEXT NOT NULL,
      state TEXT NOT NULL,native_session_id TEXT,request_id TEXT,
      requested_subscription_id TEXT NOT NULL,receipt_subscription_id TEXT NOT NULL,
      PRIMARY KEY(owner,idempotency_key));
      CREATE TABLE IF NOT EXISTS real_destinations(owner TEXT NOT NULL,request_id TEXT NOT NULL,
      requested_subscription_id TEXT NOT NULL,receipt_subscription_id TEXT NOT NULL,
      PRIMARY KEY(owner,request_id));`);
    // Pre-binding rows cannot be attributed to this process. Preserve them for
    // retention/idempotency protection, with an empty identity that fails closed.
    if(!store.db.prepare('PRAGMA table_info(global_collection_intents)').all().some(column=>column.name==='runtime_instance_id'))store.db.exec("ALTER TABLE global_collection_intents ADD COLUMN runtime_instance_id TEXT NOT NULL DEFAULT ''");
  }
  private prune(){
    this.store.db.prepare('DELETE FROM global_collection_intents WHERE expires_at<=?').run(new Date(this.real.clock()-86_400_000).toISOString());
    this.store.db.exec('DELETE FROM real_destinations WHERE request_id NOT IN (SELECT request_id FROM real_diagnostic_requests)');
  }
  private pair(owner:string){
    const subscriptions=this.store.active(owner),requested=subscriptions.filter(s=>s.name==='diagnostic.requested'&&s.arguments.stream_id===REAL_STREAM),receipt=subscriptions.filter(s=>s.name===RECEIPT_EVENT&&s.arguments.stream_id===REAL_STREAM);
    if(requested.length!==1||receipt.length!==1)throw new Fault('global_subscription_unavailable',409);
    // Event-specific URLs may differ. The platform owns conversation routing;
    // these immutable IDs prevent a later subscription from taking its place.
    return{requested_subscription_id:requested[0].id,receipt_subscription_id:receipt[0].id};
  }
  ready(owner:string){try{this.pair(owner);return true;}catch{return false;}}
  nativeReady(owner:string){return this.lastPoll?.owner===owner&&this.real.clock()-this.lastPoll.at>=0&&this.real.clock()-this.lastPoll.at<=15_000;}
  private assertInstance(row:IntentRow){if(!this.instanceID||row.runtime_instance_id!==this.instanceID)throw new Fault('collection_runtime_mismatch',409);}
  private row(owner:string,id:string){const row=this.store.db.prepare('SELECT * FROM global_collection_intents WHERE owner=? AND intent_id=?').get(owner,id) as IntentRow|undefined;if(!row)throw new Fault('not_found',404,-32004);this.assertInstance(row);return row;}
  private bound(owner:string,id:string,expectedHash:string){const row=this.row(owner,id);if(row.intent_hash!==expectedHash)throw new Fault('intent_hash_mismatch',409);return row;}
  private state(row:IntentRow){
    if(row.request_id)return this.real.read(row.owner,row.request_id).status;
    if(row.state==='cancelled'||row.state==='declined')return row.state;
    return Date.parse(row.expires_at)<=this.real.clock()?'expired':row.state;
  }
  private active(row:IntentRow){return ['awaiting_native','awaiting_consent','requested','proposed'].includes(this.state(row))&&(!row.request_id||!this.real.read(row.owner,row.request_id).receipt);}
  private pin(owner:string,id:string,pair:{requested_subscription_id:string;receipt_subscription_id:string}){
    this.store.db.prepare('INSERT INTO real_destinations(owner,request_id,requested_subscription_id,receipt_subscription_id) VALUES(?,?,?,?)').run(owner,id,pair.requested_subscription_id,pair.receipt_subscription_id);
  }
  destination(owner:string,id:string,eventName:string){const row=this.store.db.prepare('SELECT requested_subscription_id,receipt_subscription_id FROM real_destinations WHERE owner=? AND request_id=?').get(owner,id);return row?.[eventName===RECEIPT_EVENT?'receipt_subscription_id':'requested_subscription_id'] as string|undefined;}
  private assertPinnedLive(row:IntentRow){
    const subscriptions=this.store.active(row.owner);
    if(!subscriptions.some(s=>s.id===row.requested_subscription_id&&s.name==='diagnostic.requested'&&s.arguments.stream_id===REAL_STREAM)||!subscriptions.some(s=>s.id===row.receipt_subscription_id&&s.name===RECEIPT_EVENT&&s.arguments.stream_id===REAL_STREAM))throw new Fault('global_destination_unavailable',409);
  }
  private public(row:IntentRow,identity:RuntimeIdentity){
    this.assertInstance(row);if(identity.instance_id!==this.instanceID)throw new Fault('collection_runtime_mismatch',409);
    const data=row.request_id?this.real.read(row.owner,row.request_id):null;
    const saved=row.request_id?this.real.row(row.owner,row.request_id):null;
    const result_bundle=saved?.plan_json&&saved.plan_hash?{schema_version:1 as const,kind:'stats_real_result' as const,request_json:saved.request_json,request_hash:saved.request_hash,proposal_json:saved.plan_json,proposal_hash:saved.plan_hash}:null;
    return{schema_version:1 as const,kind:'stats_global_panel_result' as const,synthetic:false as const,connection:{state:'online' as const,instance_id:identity.instance_id,expires_at:identity.expires_at},intent:JSON.parse(row.intent_json) as GlobalCollectionIntent,intent_hash:row.intent_hash,status:this.state(row),data,result_bundle};
  }
  read(owner:string,id:string,expectedHash:string,identity:RuntimeIdentity){return this.public(this.bound(owner,id,expectedHash),identity);}
  request(owner:string,key:string,identity:RuntimeIdentity){
    if(!this.instanceID||identity.instance_id!==this.instanceID)throw new Fault('collection_runtime_mismatch',409);
    this.prune();const previous=this.store.db.prepare('SELECT * FROM global_collection_intents WHERE owner=? AND idempotency_key=?').get(owner,key) as IntentRow|undefined;
    if(previous)return this.public(previous,identity);
    const existing=this.store.db.prepare('SELECT * FROM global_collection_intents WHERE owner=? AND runtime_instance_id=?').all(owner,this.instanceID) as IntentRow[];
    if(existing.some(row=>this.active(row)))throw new Fault('global_collection_busy',409);
    if(Number(this.store.db.prepare('SELECT count(*) AS n FROM global_collection_intents').get()!.n)>=100)throw new Fault('global_collection_limit',409);
    const pair=this.pair(owner),now=this.real.clock();
    const intent:GlobalCollectionIntent={schema_version:1,kind:'stats_global_collection_intent',intent_id:randomUUID(),created_at:new Date(now).toISOString(),expires_at:new Date(Math.min(now+600_000,Date.parse(identity.expires_at))).toISOString(),consent_scope:'global_diagnostics_v1'};
    this.store.db.prepare('INSERT INTO global_collection_intents(owner,runtime_instance_id,idempotency_key,intent_id,intent_json,intent_hash,expires_at,state,requested_subscription_id,receipt_subscription_id) VALUES(?,?,?,?,?,?,?,?,?,?)').run(owner,this.instanceID,key,intent.intent_id,canonical(intent),digest(intent),intent.expires_at,'awaiting_native',pair.requested_subscription_id,pair.receipt_subscription_id);
    return this.public(this.row(owner,intent.intent_id),identity);
  }
  cancel(owner:string,id:string,expectedHash:string,identity:RuntimeIdentity){
    const row=this.bound(owner,id,expectedHash);
    if(row.request_id)this.real.cancel(owner,this.real.read(owner,row.request_id).request.client_request);
    this.store.db.prepare("UPDATE global_collection_intents SET state='cancelled' WHERE owner=? AND intent_id=?").run(owner,id);
    return this.public(this.row(owner,id),identity);
  }
  createDirect(owner:string,client:RealRequestEnvelope){
    const body=validateRealRequest(client,this.real.clock(),{allowExpired:true});
    // An intent cannot be bypassed through the older direct-upload operation.
    if(this.store.db.prepare('SELECT intent_id FROM global_collection_intents WHERE owner=? AND intent_id=?').get(owner,body.client_request_id))throw new Fault('collection_intent_required',409);
    const existing=this.real.clientId(owner,client);if(existing)return this.real.read(owner,existing);
    const pair=this.pair(owner);return this.real.create(owner,client,id=>this.pin(owner,id,pair));
  }
  local(owner:string,value:unknown){
    validate(collectionSocketSchema,value);const command=value as NativeCommand;
    const empty={schema_version:1 as const,kind:'stats_global_collection_poll' as const,intent:null,intent_hash:null};
    if(command.op==='next_global_collection_intent'){
      this.lastPoll={owner,at:this.real.clock()};this.prune();
      if(!this.instanceID)throw new Fault('runtime_identity_unavailable');
      const rows=this.store.db.prepare("SELECT * FROM global_collection_intents WHERE owner=? AND runtime_instance_id=? AND state IN ('awaiting_native','awaiting_consent') AND request_id IS NULL AND expires_at>? ORDER BY expires_at,intent_id").all(owner,this.instanceID,new Date(this.real.clock()).toISOString()) as IntentRow[];
      const row=rows.find(r=>r.native_session_id===command.native_session_id)??rows.find(r=>r.native_session_id===null);
      if(!row)return empty;
      this.assertPinnedLive(row);
      this.store.db.prepare("UPDATE global_collection_intents SET state='awaiting_consent',native_session_id=? WHERE owner=? AND intent_id=? AND native_session_id IS NULL").run(command.native_session_id,owner,row.intent_id);
      return{...empty,intent:JSON.parse(row.intent_json) as GlobalCollectionIntent,intent_hash:row.intent_hash};
    }
    const row=this.bound(owner,command.intent_id,command.intent_hash);
    if(row.native_session_id!==command.native_session_id)throw new Fault('native_session_mismatch',409);
    if(command.op==='resolve_global_collection_intent'){
      if(row.request_id)throw new Fault('collection_already_submitted',409);
      if(row.state==='declined')return empty;
      if(this.state(row)!=='awaiting_consent')throw new Fault('collection_intent_terminal',409);
      this.store.db.prepare("UPDATE global_collection_intents SET state='declined' WHERE owner=? AND intent_id=?").run(owner,row.intent_id);return empty;
    }
    if(row.request_id){
      const id=this.real.clientId(owner,command.client_request);
      if(id!==row.request_id)throw new Fault('real_binding_mismatch',409);
      return this.real.status(owner,command.client_request);
    }
    if(this.state(row)!=='awaiting_consent')throw new Fault('collection_intent_terminal',409);
    this.assertPinnedLive(row);
    const body=validateRealRequest(command.client_request,this.real.clock()),intent=JSON.parse(row.intent_json) as GlobalCollectionIntent;
    if(body.client_request_id!==row.intent_id||Date.parse(body.created_at)<Date.parse(intent.created_at)||Date.parse(body.consent.confirmed_at)<Date.parse(intent.created_at)||Date.parse(body.expires_at)>Date.parse(intent.expires_at))throw new Fault('collection_consent_binding_mismatch',409);
    this.real.create(owner,command.client_request,id=>{
      this.pin(owner,id,row);
      this.store.db.prepare('UPDATE global_collection_intents SET request_id=? WHERE owner=? AND intent_id=?').run(id,owner,row.intent_id);
    });
    return this.real.status(owner,command.client_request);
  }
}

export function globalCollectionExtension(collection:GlobalCollection,enabled:boolean,boundIdentity:(expected:unknown)=>RuntimeIdentity,base:McpExtension):McpExtension{
  return{...base,tools:[...(base.tools??[]),...GLOBAL_COLLECTION_TOOLS],call:async(name,args,owner)=>{
    if(!GLOBAL_COLLECTION_TOOLS.some(tool=>tool.name===name))return base.call?.(name,args,owner)??{handled:false};
    assertRealEnabled(enabled);
    const input=args as {expected_instance_id:string;idempotency_key:string;intent_id:string;intent_hash:string},identity=boundIdentity(input.expected_instance_id);
    const data=name==='panel_request_global_diagnostic'?collection.request(owner,input.idempotency_key,identity):name==='panel_cancel_global_diagnostic'?collection.cancel(owner,input.intent_id,input.intent_hash,identity):collection.read(owner,input.intent_id,input.intent_hash,identity);
    return{handled:true,data};
  }};
}
