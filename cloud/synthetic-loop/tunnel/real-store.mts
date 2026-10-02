import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { canonical,digest,Fault,principal } from '../bridge/core.mts';
import { validateRealRequest,validateRealPlan,validateRealReceipt,REAL_MAX_FRAME_BYTES } from '../bridge/real-contract.mts';
import type { RealRequestEnvelope,RealDiagnosticRequest,RealPlan,RealReceiptEnvelope } from '../bridge/real-contract.mts';

export const REAL_STREAM='global-device-v1';
export const RECEIPT_EVENT='diagnostic.receipt_ready';
export function initializeRealTables(db:DatabaseSync){
  db.exec(`CREATE TABLE IF NOT EXISTS real_diagnostic_requests(
    request_id TEXT PRIMARY KEY,owner TEXT NOT NULL,client_id TEXT NOT NULL,
    request_json TEXT NOT NULL,request_hash TEXT NOT NULL,event_id TEXT NOT NULL,
    expires_at TEXT NOT NULL,cancelled INTEGER NOT NULL DEFAULT 0,
    plan_json TEXT,plan_hash TEXT,receipt_json TEXT,receipt_hash TEXT,receipt_event_id TEXT,
    UNIQUE(owner,client_id));
    CREATE TABLE IF NOT EXISTS real_cancellations(owner TEXT NOT NULL,client_id TEXT NOT NULL,
      binding_json TEXT NOT NULL,expires_at TEXT NOT NULL,PRIMARY KEY(owner,client_id));`);
}
type Row={request_id:string;owner:string;client_id:string;request_json:string;request_hash:string;event_id:string;expires_at:string;cancelled:number;plan_json:string|null;plan_hash:string|null;receipt_json:string|null;receipt_hash:string|null;receipt_event_id:string|null};
export class RealBridge {
  readonly db:DatabaseSync;clock:()=>number;
  constructor(db:DatabaseSync,clock=Date.now){this.db=db;this.clock=clock;initializeRealTables(db);}
  prune(){const cut=new Date(this.clock()-86_400_000).toISOString();this.db.prepare('DELETE FROM real_diagnostic_requests WHERE expires_at<=?').run(cut);this.db.prepare('DELETE FROM real_cancellations WHERE expires_at<=?').run(cut);}
  row(owner:string,id:string):Row{principal(owner);const row=this.db.prepare('SELECT * FROM real_diagnostic_requests WHERE owner=? AND request_id=?').get(owner,id) as Row|undefined;if(!row)throw new Fault('not_found',404,-32004);return row;}
  has(owner:string,id:string):boolean{return Boolean(this.db.prepare('SELECT request_id FROM real_diagnostic_requests WHERE owner=? AND request_id=?').get(principal(owner),id));}
  public(row:Row){
    const request=JSON.parse(row.request_json) as RealDiagnosticRequest,plan=row.plan_json?JSON.parse(row.plan_json) as RealPlan:null;
    const expired=Date.parse(row.expires_at)<=this.clock() || Boolean(plan&&Date.parse(plan.expires_at)<=this.clock());
    const status=row.cancelled?'cancelled':expired?'expired':plan?'proposed':'requested';
    return{request,request_hash:row.request_hash,event_id:row.event_id,status,proposal:status==='proposed'?plan:null,proposal_hash:status==='proposed'?row.plan_hash:null,receipt:row.receipt_json?JSON.parse(row.receipt_json) as RealReceiptEnvelope:null,receipt_hash:row.receipt_hash,execution:'local_approval_required'};
  }
  read(owner:string,id:string){return this.public(this.row(owner,id));}
  clientId(owner:string,client:RealRequestEnvelope):string|null{
    const body=validateRealRequest(client,this.clock(),{allowExpired:true});
    const row=this.db.prepare('SELECT request_id,request_json FROM real_diagnostic_requests WHERE owner=? AND client_id=?').get(principal(owner),body.client_request_id);
    if(!row)return null;
    if(canonical((JSON.parse(row.request_json as string) as RealDiagnosticRequest).client_request)!==canonical(client))throw new Fault('real_binding_mismatch',409);
    return row.request_id as string;
  }
  create(owner:string,client:RealRequestEnvelope,onCreated?:(requestId:string)=>void){
    principal(owner);const body=validateRealRequest(client,this.clock(),{allowExpired:true});
    this.db.exec('BEGIN IMMEDIATE');
    try{
      this.prune();const existing=this.clientId(owner,client);if(existing){this.db.exec('COMMIT');return this.read(owner,existing);}
      validateRealRequest(client,this.clock());
      const cancelled=this.db.prepare('SELECT binding_json FROM real_cancellations WHERE owner=? AND client_id=?').get(owner,body.client_request_id);
      if(cancelled){if(cancelled.binding_json!==canonical(client))throw new Fault('real_binding_mismatch',409);throw new Fault('request_cancelled',409);}
      if(Number(this.db.prepare('SELECT count(*) AS n FROM real_diagnostic_requests').get()!.n)>=100)throw new Fault('real_request_limit');
      const now=this.clock(),request:RealDiagnosticRequest={schema_version:2,request_id:randomUUID(),stream_id:REAL_STREAM,synthetic:false,created_at:new Date(now).toISOString(),expires_at:new Date(Math.min(now+600_000,Date.parse(body.expires_at))).toISOString(),client_request:client};
      if(Buffer.byteLength(canonical(request))>14_000)throw new Fault('server_request_too_large',413);
      const row:Row={request_id:request.request_id,owner,client_id:body.client_request_id,request_json:canonical(request),request_hash:digest(request),event_id:'evt_'+randomUUID(),expires_at:request.expires_at,cancelled:0,plan_json:null,plan_hash:null,receipt_json:null,receipt_hash:null,receipt_event_id:null};
      // Account for repeated JSON string escaping, not just raw request bytes.
      // Reserve a largest-shape action plus a short, heavily escaped rationale.
      // This is a size-only template, never a stored or executable proposal.
      const reserve:RealPlan={schema_version:2,request_id:row.request_id,request_hash:row.request_hash,plan_id:'00000000-0000-4000-8000-000000000000',expires_at:row.expires_at,dry_run:false,requires_local_approval:true,policy_id:'local_capabilities_v1',decision:'recommend_quit',summary:'\\'.repeat(256),actions:[{type:'quit_app',candidate_id:'00000000-0000-4000-8000-000000000000'}]};
      this.ensureResultBudget(row,reserve,'request_result_too_large');
      this.db.prepare('INSERT INTO real_diagnostic_requests(request_id,owner,client_id,request_json,request_hash,event_id,expires_at) VALUES(?,?,?,?,?,?,?)').run(row.request_id,owner,row.client_id,row.request_json,row.request_hash,row.event_id,row.expires_at);
      onCreated?.(row.request_id);
      this.db.exec('COMMIT');return this.read(owner,request.request_id);
    }catch(error){try{this.db.exec('ROLLBACK');}catch{}throw error;}
  }
  cancel(owner:string,client:RealRequestEnvelope){
    const body=validateRealRequest(client,this.clock(),{allowExpired:true});principal(owner);
    this.db.exec('BEGIN IMMEDIATE');
    try{
      this.prune();const id=this.clientId(owner,client),binding=canonical(client);
      const previous=this.db.prepare('SELECT binding_json FROM real_cancellations WHERE owner=? AND client_id=?').get(owner,body.client_request_id);
      if(previous&&previous.binding_json!==binding)throw new Fault('real_binding_mismatch',409);
      if(!id&&!previous){validateRealRequest(client,this.clock());if(Number(this.db.prepare('SELECT count(*) AS n FROM real_cancellations').get()!.n)>=100)throw new Fault('real_cancellation_limit');this.db.prepare('INSERT INTO real_cancellations(owner,client_id,binding_json,expires_at) VALUES(?,?,?,?)').run(owner,body.client_request_id,binding,body.expires_at);}
      if(id)this.db.prepare('UPDATE real_diagnostic_requests SET cancelled=1 WHERE owner=? AND request_id=?').run(owner,id);
      this.db.exec('COMMIT');if(!id)throw new Fault('not_found',404,-32004);return this.read(owner,id);
    }catch(error){try{this.db.exec('ROLLBACK');}catch{}throw error;}
  }
  submit(owner:string,input:unknown){
    const candidate=input as {request_id?:string};if(typeof candidate?.request_id!=='string')throw new Fault('invalid_schema');
    const row=this.row(owner,candidate.request_id),request=JSON.parse(row.request_json) as RealDiagnosticRequest;
    const plan=validateRealPlan(input,request,row.request_hash,this.clock());
    if(row.cancelled||Date.parse(row.expires_at)<=this.clock())throw new Fault('request_terminal',409);
    const hash=digest(plan);if(row.plan_hash&&row.plan_hash!==hash)throw new Fault('proposal_conflict',409);
    // Reserve the eventual receipt acknowledgement so every accepted result can
    // still be retrieved through the bounded native socket after completion.
    this.ensureResultBudget(row,plan,'plan_result_too_large');
    if(!row.plan_hash)this.db.prepare('UPDATE real_diagnostic_requests SET plan_json=?,plan_hash=? WHERE owner=? AND request_id=? AND plan_json IS NULL').run(canonical(plan),hash,owner,row.request_id);
    return this.read(owner,row.request_id);
  }
  private ensureResultBudget(row:Row,plan:RealPlan,reason:string){const preview=this.statusRow({...row,plan_json:canonical(plan),plan_hash:digest(plan)});if(Buffer.byteLength(JSON.stringify({result:{...preview,receipt:{receipt_id:'00000000-0000-4000-8000-000000000000',receipt_hash:'0'.repeat(64)}}}))+1>REAL_MAX_FRAME_BYTES)throw new Fault(reason,413);}
  receipt(owner:string,client:RealRequestEnvelope,input:unknown){
    const id=this.clientId(owner,client);if(!id)throw new Fault('not_found',404,-32004);const row=this.row(owner,id);
    if(!row.plan_json||!row.plan_hash)throw new Fault('proposal_not_available',409);
    const receipt=validateRealReceipt(input,JSON.parse(row.request_json) as RealDiagnosticRequest,row.request_hash,JSON.parse(row.plan_json) as RealPlan,row.plan_hash,this.clock());
    const envelope=input as RealReceiptEnvelope;
    if(row.receipt_hash&&row.receipt_hash!==envelope.receipt_hash)throw new Fault('receipt_conflict',409);
    if(!row.receipt_hash)this.db.prepare('UPDATE real_diagnostic_requests SET receipt_json=?,receipt_hash=?,receipt_event_id=? WHERE owner=? AND request_id=? AND receipt_json IS NULL').run(canonical(envelope),envelope.receipt_hash,'evt_'+randomUUID(),owner,id);
    // Cancellation preserves an already-reported local effect and its evidence.
    void receipt;return this.read(owner,id);
  }
  resolveReference(owner:string,reference:{client_request_id:string;client_request_hash:string;request_id:string;request_hash:string}):RealRequestEnvelope{
    const row=this.row(owner,reference.request_id),request=JSON.parse(row.request_json) as RealDiagnosticRequest;
    if(reference.client_request_id!==row.client_id||reference.client_request_hash!==request.client_request.client_request_hash||reference.request_hash!==row.request_hash)throw new Fault('real_binding_mismatch',409);
    return request.client_request;
  }
  bundle(owner:string,id:string){const row=this.row(owner,id),data=this.public(row);if(data.status!=='proposed'||!row.plan_json||!row.plan_hash)throw new Fault('proposal_not_available',409);return{schema_version:1 as const,kind:'stats_real_result' as const,request_json:row.request_json,request_hash:row.request_hash,proposal_json:row.plan_json,proposal_hash:row.plan_hash};}
  statusRow(row:Row){const data=this.public(row),client=data.request.client_request,body=validateRealRequest(client,this.clock(),{allowExpired:true});const receipt=data.receipt?JSON.parse(data.receipt.receipt_json) as {receipt_id:string}:null;return{schema_version:1 as const,kind:'stats_real_socket_status' as const,client_request_id:body.client_request_id,client_request_hash:client.client_request_hash,request_id:row.request_id,request_hash:data.request_hash,status:data.status,bundle:data.status==='proposed'?{schema_version:1 as const,kind:'stats_real_result' as const,request_json:row.request_json,request_hash:row.request_hash,proposal_json:row.plan_json!,proposal_hash:row.plan_hash!}:null,receipt:receipt?{receipt_id:receipt.receipt_id,receipt_hash:data.receipt_hash!}:null};}
  status(owner:string,client:RealRequestEnvelope){const id=this.clientId(owner,client);if(!id)throw new Fault('not_found',404,-32004);return this.statusRow(this.row(owner,id));}
  pending(owner:string){this.prune();return this.db.prepare('SELECT request_id FROM real_diagnostic_requests WHERE owner=? AND ((cancelled=0 AND plan_json IS NULL AND expires_at>?) OR receipt_json IS NOT NULL) LIMIT 100').all(principal(owner),new Date(this.clock()).toISOString()).map(r=>r.request_id as string);}
  events(owner:string,id:string){
    const row=this.row(owner,id),data=this.public(row),events:Array<{eventId:string;name:string;timestamp:string;data:{request_id:string;request_hash:string;stream_id:string;synthetic:false;expires_at:string;receipt_id?:string;receipt_hash?:string};cursor:null}>=[];
    const common={request_id:id,request_hash:row.request_hash,stream_id:REAL_STREAM,synthetic:false as const,expires_at:row.expires_at};
    if(data.status==='requested')events.push({eventId:row.event_id,name:'diagnostic.requested',timestamp:data.request.created_at,data:common,cursor:null});
    if(row.receipt_json&&row.receipt_hash&&row.receipt_event_id){const envelope=JSON.parse(row.receipt_json) as RealReceiptEnvelope,receipt=JSON.parse(envelope.receipt_json) as {receipt_id:string;completed_at:string};const until=Date.parse(receipt.completed_at)+600_000;if(until>this.clock())events.push({eventId:row.receipt_event_id,name:RECEIPT_EVENT,timestamp:receipt.completed_at,data:{...common,expires_at:new Date(until).toISOString(),receipt_id:receipt.receipt_id,receipt_hash:row.receipt_hash},cursor:null});}
    return events;
  }
}
