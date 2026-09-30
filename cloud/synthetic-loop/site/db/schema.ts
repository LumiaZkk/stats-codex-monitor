import { integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
export const requests = sqliteTable('diagnostic_requests', {
  requestId: text('request_id').primaryKey(), owner: text('owner').notNull(), idempotencyKey: text('idempotency_key').notNull(),
  requestJson: text('request_json').notNull(), requestHash: text('request_hash').notNull(), eventId: text('event_id').notNull(),
  expiresAt: text('expires_at').notNull(), cancelled: integer('cancelled').notNull().default(0),
  planJson: text('plan_json'), planHash: text('plan_hash'),
}, t => [uniqueIndex('request_owner_idempotency').on(t.owner, t.idempotencyKey)]);
export const protocolMethods = sqliteTable('protocol_methods', { owner: text('owner').notNull(), method: text('method').notNull() }, t => [uniqueIndex('protocol_owner_method').on(t.owner, t.method)]);
