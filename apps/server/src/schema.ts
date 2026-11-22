import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from 'drizzle-orm/sqlite-core';

export const administrators = sqliteTable(
  'administrators',
  {
    id: integer('id').primaryKey(),
    username: text('username').notNull(),
    passwordHash: text('password_hash').notNull(),
    createdAtMs: integer('created_at_ms').notNull(),
  },
  (table) => [check('administrators_singleton', sql`${table.id} = 1`)],
);

export const sessions = sqliteTable(
  'sessions',
  {
    tokenHash: text('token_hash').notNull(),
    administratorId: integer('administrator_id')
      .notNull()
      .references(() => administrators.id, { onDelete: 'cascade' }),
    expiresAtMs: integer('expires_at_ms').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tokenHash] }),
    index('sessions_expiration').on(table.expiresAtMs),
  ],
);

export const secretStore = sqliteTable(
  'secret_store',
  {
    id: text('id').notNull(),
    cipherText: text('cipher_text').notNull(),
    nonce: text('nonce').notNull(),
    authTag: text('auth_tag').notNull(),
    algorithm: text('algorithm').notNull(),
    keyVersion: integer('key_version').notNull(),
    createdAtMs: integer('created_at_ms').notNull(),
  },
  (table) => [primaryKey({ columns: [table.id] })],
);

export const auditLogs = sqliteTable('audit_logs', {
  id: integer('id').primaryKey(),
  actor: text('actor').notNull(),
  action: text('action').notNull(),
  targetType: text('target_type').notNull(),
  targetId: text('target_id').notNull(),
  createdAtMs: integer('created_at_ms').notNull(),
});
