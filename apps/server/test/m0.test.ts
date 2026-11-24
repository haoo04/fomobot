import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { buildApp } from '../src/app.js';
import { initializeAdministrator } from '../src/auth.js';
import { readConfig } from '../src/config.js';
import { migrateDatabase, openDatabase } from '../src/database.js';
import type { AppDatabase } from '../src/database.js';
import {
  administrators,
  auditLogs,
  secretStore,
  sessions,
} from '../src/schema.js';
import { readSecret, saveSecret } from '../src/secrets.js';

const config = readConfig({
  NODE_ENV: 'production',
  WEB_ORIGIN: 'https://sentinel.example',
  APP_ENCRYPTION_KEY_BASE64: randomBytes(32).toString('base64'),
  SESSION_SECRET: randomBytes(32).toString('base64'),
  LOG_LEVEL: 'silent',
});
const credentials = {
  username: 'test-admin',
  password: 'integration fixture phrase',
};

let directory: string;
let database: AppDatabase;
let app: Awaited<ReturnType<typeof buildApp>>;

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'market-sentinel-'));
  database = openDatabase(join(directory, 'test.sqlite'));
  app = await buildApp(database, config);
});

afterEach(async () => {
  await app.close();
  database.$client.close();
  for (const name of ['test.sqlite', 'test.sqlite-wal', 'test.sqlite-shm']) {
    rmSync(join(directory, name), { force: true });
  }
  rmdirSync(directory);
});

function login(payload = credentials, origin = config.WEB_ORIGIN) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { origin },
    payload,
  });
}

describe('SQLite and health checks', () => {
  test('reports readiness only once the empty database has been migrated', async () => {
    const live = await app.inject('/health/live');
    expect(live.statusCode).toBe(200);
    expect(live.json()).toMatchObject({
      status: 'ok',
      requestId: expect.any(String),
    });

    const before = await app.inject('/health/ready');
    expect(before.statusCode).toBe(503);
    expect(before.json()).toMatchObject({
      error: { code: 'DATABASE_UNAVAILABLE' },
    });

    migrateDatabase(database);
    migrateDatabase(database);
    expect(database.$client.prepare('PRAGMA journal_mode').get()).toMatchObject(
      { journal_mode: 'wal' },
    );
    expect(database.$client.prepare('PRAGMA foreign_keys').get()).toMatchObject(
      { foreign_keys: 1 },
    );
    expect(
      database.$client
        .prepare('SELECT COUNT(*) AS count FROM __drizzle_migrations')
        .get(),
    ).toMatchObject({
      count: 5,
    });

    const ready = await app.inject('/health/ready');
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({
      status: 'ok',
      checks: { database: 'ok' },
    });
  });

  test('handles unknown paths with a request ID and a standard error', async () => {
    const response = await app.inject('/api/v1/missing');
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      requestId: expect.any(String),
      error: { code: 'NOT_FOUND' },
    });
  });
});

describe('administrator authentication', () => {
  test('creates one administrator and protects and revokes its session', async () => {
    migrateDatabase(database);
    expect((await login()).statusCode).toBe(503);
    expect(await initializeAdministrator(database, credentials)).toBe(true);
    expect(
      await initializeAdministrator(database, {
        ...credentials,
        username: 'second',
      }),
    ).toBe(false);

    const account = database.select().from(administrators).get();
    expect(account?.passwordHash).toMatch(/^argon2id-v1\./);
    expect(account?.passwordHash).not.toContain(credentials.password);

    const blocked = await login(credentials, 'https://different.example');
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json()).toMatchObject({
      error: { code: 'ORIGIN_NOT_ALLOWED' },
    });
    expect(
      (await login({ ...credentials, password: 'incorrect password' }))
        .statusCode,
    ).toBe(401);

    expect((await app.inject('/api/v1/auth/session')).statusCode).toBe(401);
    const logoutRequest = {
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { origin: config.WEB_ORIGIN },
    } as const;
    expect((await app.inject(logoutRequest)).statusCode).toBe(401);

    const signedIn = await login();
    expect(signedIn.statusCode).toBe(200);
    expect(signedIn.json()).toMatchObject({
      data: { username: credentials.username },
    });
    const sessionCookie = signedIn.cookies.find(
      (value) => value.name === 'market_sentinel_session',
    );
    expect(sessionCookie).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: 'Strict',
    });
    const cookies = { market_sentinel_session: sessionCookie!.value };
    const session = await app.inject({ url: '/api/v1/auth/session', cookies });
    expect(session.statusCode).toBe(200);
    expect(session.json()).toMatchObject({
      data: { username: credentials.username },
    });
    expect(database.select().from(sessions).get()?.tokenHash).toMatch(
      /^[a-f0-9]{64}$/,
    );

    expect(
      (await app.inject({ ...logoutRequest, headers: {}, cookies })).statusCode,
    ).toBe(403);
    expect((await app.inject({ ...logoutRequest, cookies })).statusCode).toBe(
      200,
    );
    expect(
      (await app.inject({ url: '/api/v1/auth/session', cookies })).statusCode,
    ).toBe(401);
    expect(
      database
        .select({ action: auditLogs.action })
        .from(auditLogs)
        .orderBy(auditLogs.id)
        .all(),
    ).toEqual([
      { action: 'ADMIN_CREATED' },
      { action: 'LOGIN' },
      { action: 'LOGOUT' },
    ]);
  });

  test('validates input and limits login attempts before doing password work', async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const response = await login({ username: '', password: 'fixture' });
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toMatchObject({
        code: 'INVALID_REQUEST',
        details: expect.arrayContaining([
          expect.objectContaining({ field: 'username' }),
        ]),
      });
    }
    const limited = await login();
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });
  });
});

test('encrypts each credential with a fresh nonce and rejects the wrong key', () => {
  migrateDatabase(database);
  const key = config.APP_ENCRYPTION_KEY_BASE64;
  const plaintext = 'fixture credential 演示数据';
  const first = saveSecret(database, key, plaintext);
  const second = saveSecret(database, key, plaintext);
  const records = database.select().from(secretStore).all();

  expect(records).toHaveLength(2);
  expect(new Set(records.map(({ nonce }) => nonce)).size).toBe(2);
  expect(JSON.stringify(records)).not.toContain(plaintext);
  expect(readSecret(database, key, first)).toBe(plaintext);
  expect(readSecret(database, key, second)).toBe(plaintext);
  expect(readSecret(database, key, 'missing')).toBeNull();
  expect(() => readSecret(database, config.SESSION_SECRET, first)).toThrow();
});
