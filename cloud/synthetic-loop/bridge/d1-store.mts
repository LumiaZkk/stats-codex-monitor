import type { Store, RecordRow, Plan } from './core.mts';
type DbRow = { owner: string; idempotency_key: string; request_json: string; request_hash: string; event_id: string; cancelled: number; plan_json: string | null; plan_hash: string | null };
const decode = (r: DbRow | null): RecordRow | null => r ? ({ owner: r.owner, idempotencyKey: r.idempotency_key, request: JSON.parse(r.request_json), requestHash: r.request_hash, eventId: r.event_id, cancelled: r.cancelled === 1, plan: r.plan_json ? JSON.parse(r.plan_json) : null, planHash: r.plan_hash }) : null;
export class D1Store implements Store {
  db: D1Database;
  constructor(db: D1Database) { this.db = db; }
  async create(r: RecordRow) {
    await this.db.prepare('INSERT INTO diagnostic_requests (request_id, owner, idempotency_key, request_json, request_hash, event_id, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(owner, idempotency_key) DO NOTHING').bind(r.request.request_id, r.owner, r.idempotencyKey, JSON.stringify(r.request), r.requestHash, r.eventId, r.request.expires_at).run();
    const saved = decode(await this.db.prepare('SELECT * FROM diagnostic_requests WHERE owner = ? AND idempotency_key = ?').bind(r.owner, r.idempotencyKey).first<DbRow>());
    if (!saved) throw new Error('storage_unavailable'); return saved;
  }
  async get(owner: string, id: string) { return decode(await this.db.prepare('SELECT * FROM diagnostic_requests WHERE owner = ? AND request_id = ?').bind(owner, id).first<DbRow>()); }
  async propose(owner: string, id: string, plan: Plan, hash: string, now: string) {
    await this.db.prepare('UPDATE diagnostic_requests SET plan_json = ?, plan_hash = ? WHERE owner = ? AND request_id = ? AND cancelled = 0 AND plan_json IS NULL AND expires_at > ?').bind(JSON.stringify(plan), hash, owner, id, now).run(); return this.get(owner, id);
  }
  async cancel(owner: string, id: string) { await this.db.prepare('UPDATE diagnostic_requests SET cancelled = 1 WHERE owner = ? AND request_id = ?').bind(owner, id).run(); return this.get(owner, id); }
  async noteMethod(owner: string, method: string) {
    if (!['server/discover', 'initialize', 'tools/list', 'tools/call', 'events/list', 'events/subscribe', 'events/unsubscribe'].includes(method)) return;
    await this.db.prepare('INSERT INTO protocol_methods (owner, method) VALUES (?, ?) ON CONFLICT(owner, method) DO NOTHING').bind(owner, method).run();
  }
  async methods(owner: string) { const rows = await this.db.prepare('SELECT method FROM protocol_methods WHERE owner = ? ORDER BY method').bind(owner).all<{ method: string }>(); return rows.results.map(r => r.method); }
}
