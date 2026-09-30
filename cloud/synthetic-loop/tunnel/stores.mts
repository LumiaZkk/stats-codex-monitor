import { DatabaseSync } from 'node:sqlite';
import { chmodSync, existsSync, lstatSync, readFileSync } from 'node:fs';
import { D1Store } from '../bridge/d1-store.mts';
import { canonical, Fault, validateNativeRequest } from '../bridge/core.mts';
import type { NativeTransferRequest, RecordRow } from '../bridge/core.mts';
import type { Subscription, SubscriptionStore } from '../bridge/events.mts';
export function privateFile(path: string, directory = false) {
  const s = lstatSync(path);
  if (s.isSymbolicLink() || (directory ? !s.isDirectory() : !s.isFile()) || (s.mode & 0o077) !== 0 || (process.getuid && s.uid !== process.getuid())) throw new Fault('private_file_required');
}
class BoundedRequestStore extends D1Store {
  capacity: (r: RecordRow) => void;
  constructor(db: D1Database, capacity: (r: RecordRow) => void) { super(db); this.capacity=capacity; }
  override async create(r: RecordRow) { this.capacity(r); return super.create(r); }
}
export class RuntimeStore {
  db: DatabaseSync; requests: D1Store; subscriptions: SubscriptionStore;
  constructor(path: string) {
    if (existsSync(path)) privateFile(path);
    this.db = new DatabaseSync(path); chmodSync(path, 0o600);
    this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE;');
    this.db.exec(readFileSync(new URL('../drizzle/0000_harsh_lord_hawal.sql', import.meta.url), 'utf8').replaceAll('CREATE TABLE ', 'CREATE TABLE IF NOT EXISTS ').replaceAll('CREATE UNIQUE INDEX ', 'CREATE UNIQUE INDEX IF NOT EXISTS '));
    this.db.exec('CREATE TABLE IF NOT EXISTS subscriptions(id TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at INTEGER NOT NULL, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS deliveries(event_id TEXT NOT NULL, subscription_id TEXT NOT NULL, rounds INTEGER NOT NULL DEFAULT 0, received INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(event_id,subscription_id));');
    this.db.exec('CREATE TABLE IF NOT EXISTS native_cancellations(owner TEXT NOT NULL, client_id TEXT NOT NULL, binding_json TEXT NOT NULL, expires_at TEXT NOT NULL, PRIMARY KEY(owner,client_id));');
    const db = this.db;
    const d1 = { prepare(sql: string) { return { bind(...args: unknown[]) { const s = db.prepare(sql); return { run: async () => s.run(...args as []), first: async () => s.get(...args as []) ?? null, all: async () => ({ results: s.all(...args as []) }) }; } }; } } as unknown as D1Database;
    this.requests = new BoundedRequestStore(d1,r=>{this.checkCapacity(r.owner,r.idempotencyKey);const cancelled=this.nativeCancellation(r.owner,r.idempotencyKey);if(cancelled){if(canonical(r.request.client_request??null)!==cancelled.binding_json)throw new Fault('idempotency_conflict',409);throw new Fault('request_cancelled',409);}});
    this.subscriptions = {
      get: async id => { const r = db.prepare('SELECT body FROM subscriptions WHERE id=?').get(id); return r ? JSON.parse(r.body as string) as Subscription : null; },
      put: async sub => { this.prune(); if (!db.prepare('SELECT id FROM subscriptions WHERE id=?').get(sub.id) && Number(db.prepare('SELECT count(*) AS n FROM subscriptions').get()!.n) >= 8) throw new Fault('subscription_limit'); db.prepare('INSERT INTO subscriptions(id,owner,expires_at,body) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at,body=excluded.body').run(sub.id,sub.owner,sub.expiresAt,JSON.stringify(sub)); },
      remove: async id => { db.prepare('DELETE FROM subscriptions WHERE id=?').run(id); },
    };
  }
  prune(now = Date.now()) {
    this.db.prepare('DELETE FROM subscriptions WHERE expires_at <= ?').run(now);
    this.db.prepare('DELETE FROM diagnostic_requests WHERE expires_at <= ?').run(new Date(now - 86_400_000).toISOString());
    this.db.prepare('DELETE FROM native_cancellations WHERE expires_at <= ?').run(new Date(now - 86_400_000).toISOString());
    this.db.exec('DELETE FROM deliveries WHERE event_id NOT IN (SELECT event_id FROM diagnostic_requests) OR subscription_id NOT IN (SELECT id FROM subscriptions)');
  }
  checkCapacity(owner: string, key: string) { this.prune(); if(this.db.prepare('SELECT request_id FROM diagnostic_requests WHERE owner=? AND idempotency_key=?').get(owner,key))return; if (Number(this.db.prepare('SELECT count(*) AS n FROM diagnostic_requests').get()!.n) >= 100) throw new Fault('request_limit'); }
  nativeCancellation(owner:string,clientId:string) {return this.db.prepare('SELECT binding_json FROM native_cancellations WHERE owner=? AND client_id=?').get(owner,clientId) as {binding_json:string}|undefined;}
  nativeRequestId(owner:string,client:NativeTransferRequest):string|null {
    const row=this.db.prepare('SELECT request_id,request_json FROM diagnostic_requests WHERE owner=? AND idempotency_key=?').get(owner,client.client_request_id);
    if(!row)return null;
    const saved=JSON.parse(row.request_json as string) as {client_request?:unknown};
    if(canonical(saved.client_request??null)!==canonical(client))throw new Fault('native_binding_mismatch',409);
    return row.request_id as string;
  }
  cancelNativeRequest(owner:string,client:NativeTransferRequest,now:number):string|null {
    // Synchronous transaction: reserve the bound cancellation before a delayed
    // submit can insert, and mark an existing request cancelled atomically.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.prune(now);const id=this.nativeRequestId(owner,client),previous=this.nativeCancellation(owner,client.client_request_id),binding=canonical(client);
      if(previous && previous.binding_json!==binding)throw new Fault('native_binding_mismatch',409);
      if(!previous && !id){
        validateNativeRequest(client,now);
        if(Number(this.db.prepare('SELECT count(*) AS n FROM native_cancellations').get()!.n)>=100)throw new Fault('native_cancellation_limit');
        this.db.prepare('INSERT INTO native_cancellations(owner,client_id,binding_json,expires_at) VALUES(?,?,?,?)').run(owner,client.client_request_id,binding,client.expires_at);
      }
      if(id)this.db.prepare('UPDATE diagnostic_requests SET cancelled=1 WHERE owner=? AND request_id=?').run(owner,id);
      this.db.exec('COMMIT');return id;
    } catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  active(owner: string): Subscription[] { this.prune(); return this.db.prepare('SELECT body FROM subscriptions WHERE owner=?').all(owner).map(r => JSON.parse(r.body as string)); }
  pending(owner: string): string[] { return this.db.prepare('SELECT request_id FROM diagnostic_requests WHERE owner=? AND cancelled=0 AND plan_json IS NULL AND expires_at>? LIMIT 100').all(owner,new Date().toISOString()).map(r => r.request_id as string); }
  begin(eventId: string, subscriptionId: string) {
    this.db.prepare('INSERT INTO deliveries(event_id,subscription_id) VALUES(?,?) ON CONFLICT DO NOTHING').run(eventId,subscriptionId);
    return this.db.prepare('UPDATE deliveries SET rounds=rounds+1 WHERE event_id=? AND subscription_id=? AND received=0 AND rounds<3').run(eventId,subscriptionId).changes === 1;
  }
  acknowledge(eventId: string, subscriptionId: string) { this.db.prepare('UPDATE deliveries SET received=1 WHERE event_id=? AND subscription_id=?').run(eventId,subscriptionId); }
  reject(eventId: string, subscriptionId: string) { this.db.prepare('UPDATE deliveries SET received=-1 WHERE event_id=? AND subscription_id=?').run(eventId,subscriptionId); }
  close() { this.db.close(); }
}
