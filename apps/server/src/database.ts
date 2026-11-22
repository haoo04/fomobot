import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { migrate } from 'drizzle-orm/node-sqlite/migrator';

const migrationsFolder = fileURLToPath(new URL('../drizzle/', import.meta.url));

export function openDatabase(path: string) {
  mkdirSync(dirname(path), { recursive: true });
  const client = new DatabaseSync(path);
  try {
    client.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA synchronous = NORMAL;
    `);
    return drizzle({ client });
  } catch (error) {
    client.close();
    throw error;
  }
}

export type AppDatabase = ReturnType<typeof openDatabase>;

export function migrateDatabase(database: AppDatabase) {
  migrate(database, { migrationsFolder });
}
