import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { link, mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { Worker, workerData } from 'node:worker_threads';
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

function verifyDatabase(client: DatabaseSync) {
  const checks = client.prepare('PRAGMA quick_check').all();
  if (
    checks.length !== 1 ||
    checks[0]?.quick_check !== 'ok' ||
    client.prepare('PRAGMA foreign_key_check').get()
  )
    throw new Error('DATABASE_INTEGRITY_CHECK_FAILED');
  client.prepare('SELECT id FROM administrators LIMIT 1').get();
  client.prepare('SELECT id FROM __drizzle_migrations LIMIT 1').get();
}

if (typeof workerData?.marketSentinelBackupPath === 'string') {
  const client = new DatabaseSync(workerData.marketSentinelBackupPath, {
    readOnly: true,
  });
  try {
    verifyDatabase(client);
  } finally {
    client.close();
  }
}

export function verifyDatabaseFile(path: string) {
  return new Promise<void>((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), {
      workerData: { marketSentinelBackupPath: path },
    });
    worker.once('error', reject);
    worker.once('exit', (code) =>
      code === 0
        ? resolve()
        : reject(new Error('DATABASE_INTEGRITY_CHECK_FAILED')),
    );
  });
}

export async function writeDatabaseBackup(
  database: AppDatabase,
  destination: string,
) {
  const dir = dirname(destination);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const temporary = join(dir, '.' + randomUUID() + '.sqlite');
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.close();
    await backup(database.$client, temporary);
    await verifyDatabaseFile(temporary);
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function restoreDatabase(
  source: string,
  destination: string,
  atMs = Date.now(),
) {
  const target = resolve(destination);
  if ([target, target + '-wal', target + '-shm'].some(existsSync))
    throw new Error('RESTORE_TARGET_IN_USE');
  const temporary = join(
    dirname(target),
    '.restore-' + randomUUID() + '.sqlite',
  );
  const reader = new DatabaseSync(resolve(source), { readOnly: true });
  let created = false;
  try {
    verifyDatabase(reader);
    const file = await open(temporary, 'wx', 0o600);
    created = true;
    await file.close();
    await backup(reader, temporary);
    const restored = openDatabase(temporary);
    try {
      migrateDatabase(restored);
      restored.transaction(() => {
        restored.$client
          .prepare(
            `
          INSERT INTO risk_evaluations (candidate_id, stage, outcome, reason_code, evaluated_at_ms)
          SELECT id, 'FINAL', 'SUPPRESSED', 'RESTORED_CANDIDATE_SUPPRESSED', ?
          FROM signal_candidates WHERE delivery_pending = 1
          ON CONFLICT (candidate_id, stage) DO NOTHING
        `,
          )
          .run(atMs);
        restored.$client.exec(`
          DELETE FROM sessions;
          UPDATE signal_candidates SET delivery_pending = 0 WHERE delivery_pending = 1;
          UPDATE outbox_messages SET status = 'DELIVERY_UNKNOWN', last_error = 'RESTORED_DELIVERY_UNCERTAIN'
          WHERE status IN ('PENDING', 'SENDING');
        `);
      });
      verifyDatabase(restored.$client);
    } finally {
      restored.$client.close();
    }
    if (existsSync(target + '-wal') || existsSync(target + '-shm'))
      throw new Error('RESTORE_TARGET_IN_USE');
    await link(temporary, target);
  } finally {
    reader.close();
    if (created)
      await Promise.all(
        [temporary, temporary + '-wal', temporary + '-shm'].map((file) =>
          rm(file, { force: true }),
        ),
      );
  }
}
