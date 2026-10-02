import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { D1Store } from '../bridge/d1-store.mts';
import { Bridge } from '../bridge/core.mts';
import type { Plan } from '../bridge/core.mts';
function d1(sqlite: DatabaseSync): D1Database {
  return { prepare(sql: string) { return { bind(...args: unknown[]) { const statement = sqlite.prepare(sql); return { run: async () => statement.run(...args as []), first: async () => statement.get(...args as []) ?? null, all: async () => ({ results: statement.all(...args as []) }) }; } }; } } as unknown as D1Database;
}
test('D1 SQL persists across restart and enforces atomic owner/idempotency/proposal guards', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stats-loop-test-')); const path = join(dir, 'db.sqlite');
  let sqlite = new DatabaseSync(path);
  try {
    sqlite.exec(readFileSync(new URL('../drizzle/0000_harsh_lord_hawal.sql', import.meta.url), 'utf8'));
    const bridge = new Bridge(new D1Store(d1(sqlite)));
    const input = { idempotency_key: randomUUID(), fixture: 'high-cpu-v1' }; const r = await bridge.create('a', input);
    assert.deepEqual(await bridge.create('a', input), r);
    await assert.rejects(bridge.read('b', r.request.request_id), /not_found/);
    const p: Plan = { schema_version: 1, request_id: r.request.request_id, request_hash: r.request_hash, plan_id: randomUUID(), expires_at: r.request.expires_at, dry_run: true, summary: 'Synthetic CPU fixture', actions: [{ type: 'open_activity_monitor', target: 'current_device', dry_run: true }] };
    await bridge.submit('a', p); sqlite.close(); sqlite = new DatabaseSync(path);
    const restarted = new Bridge(new D1Store(d1(sqlite)));
    assert.equal((await restarted.read('a', r.request.request_id)).status, 'proposed');
    assert.equal((await restarted.submit('a', p)).proposal_hash, (await restarted.read('a', r.request.request_id)).proposal_hash);
    await assert.rejects(restarted.submit('a', { ...p, summary: 'changed' }), /proposal_conflict/);
    await restarted.cancel('a', r.request.request_id);
    await assert.rejects(restarted.submit('a', p), /request_terminal/);
    assert.equal((await restarted.read('a', r.request.request_id)).proposal, null);
  } finally { sqlite.close(); rmSync(dir, { recursive: true, force: true }); }
});
