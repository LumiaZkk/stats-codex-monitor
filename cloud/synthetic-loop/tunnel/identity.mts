import { digest, Fault } from '../bridge/core.mts';
export type Scope = { tunnel_id: string; organization_id: string; workspace_id: string; mode: 'exclusive_personal_synthetic'|'exclusive_personal_global_diagnostics_v1' };
export type Lease = { scope: Scope; verified_at: number; valid_until: number; run_until: number };
export function validateScope(value: unknown): asserts value is Scope {
  const s = value as Scope;
  if (!s || Object.keys(s).sort().join(',') !== 'mode,organization_id,tunnel_id,workspace_id' || !['exclusive_personal_synthetic','exclusive_personal_global_diagnostics_v1'].includes(s.mode) || !/^tunnel_[a-z0-9]{32}$/.test(s.tunnel_id) || !/^org-[a-zA-Z0-9]+$/.test(s.organization_id) || !/^[0-9a-f-]{36}$/.test(s.workspace_id)) throw new Fault('invalid_exclusive_scope');
}
// Exact official v0.0.15 admin JSON: pkg/controlplane/admin/types.go, Tunnel.
export function verifyMetadata(scope: Scope, value: unknown) {
  validateScope(scope); const v = value as { id?: unknown; organization_ids?: unknown; workspace_ids?: unknown; tenant_ids?: unknown };
  const only = (a: unknown, expected: string) => Array.isArray(a) && a.length === 1 && a[0] === expected;
  if (!v || v.id !== scope.tunnel_id || !only(v.organization_ids, scope.organization_id) || !only(v.workspace_ids, scope.workspace_id) || (v.tenant_ids !== undefined && (!Array.isArray(v.tenant_ids) || v.tenant_ids.length !== 0))) throw new Fault('tunnel_scope_mismatch');
}
export function leasePrincipal(value: unknown, now = Date.now()) {
  const l = value as Lease; validateScope(l?.scope);
  if (!Number.isSafeInteger(l.verified_at) || !Number.isSafeInteger(l.valid_until) || !Number.isSafeInteger(l.run_until) || l.verified_at > now + 1000 || l.valid_until <= now || l.valid_until - l.verified_at > 90_000 || l.run_until <= now || l.run_until - l.verified_at > 3_600_000) throw new Fault('access_lease_expired', 403);
  return 'exclusive-tunnel:' + digest(l.scope);
}
