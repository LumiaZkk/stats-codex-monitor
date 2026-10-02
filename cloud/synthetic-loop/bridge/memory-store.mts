// Isolated tests only. This module is never imported by the hosted application.
import type { Store, RecordRow, Plan } from './core.mts';
export class MemoryStore implements Store {
  rows = new Map<string, RecordRow>(); audit = new Map<string, Set<string>>();
  async create(row: RecordRow) {
    const existing = [...this.rows.values()].find(r => r.owner === row.owner && r.idempotencyKey === row.idempotencyKey);
    if (existing) return structuredClone(existing);
    this.rows.set(row.request.request_id, structuredClone(row)); return structuredClone(row);
  }
  async get(owner: string, id: string) { const row = this.rows.get(id); return row?.owner === owner ? structuredClone(row) : null; }
  async propose(owner: string, id: string, plan: Plan, hash: string, now: string) {
    const row = this.rows.get(id);
    if (!row || row.owner !== owner) return null;
    if (!row.cancelled && row.request.expires_at > now && row.plan === null) { row.plan = structuredClone(plan); row.planHash = hash; }
    return structuredClone(row);
  }
  async cancel(owner: string, id: string) { const row = this.rows.get(id); if (!row || row.owner !== owner) return null; row.cancelled = true; return structuredClone(row); }
  async noteMethod(owner: string, method: string) { const set = this.audit.get(owner) ?? new Set<string>(); set.add(method); this.audit.set(owner, set); }
  async methods(owner: string) { return [...(this.audit.get(owner) ?? [])]; }
}
