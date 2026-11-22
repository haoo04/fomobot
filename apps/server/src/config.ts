import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const workspaceRoot = fileURLToPath(new URL('../../../', import.meta.url));
const envFile = resolve(workspaceRoot, '.env');

const secretSchema = z
  .string()
  .regex(/^[A-Za-z0-9+/]{43}=$/)
  .refine((value) => Buffer.from(value, 'base64').toString('base64') === value);

const environmentSchema = z
  .object({
    NODE_ENV: z
      .enum(['development', 'test', 'production'])
      .default('development'),
    HOST: z.string().trim().min(1).default('127.0.0.1'),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
    WEB_ORIGIN: z
      .url({ protocol: /^https?$/ })
      .refine((value) => URL.canParse(value) && new URL(value).origin === value)
      .default('http://localhost:5173'),
    APP_TIMEZONE: z
      .string()
      .refine((timeZone) => {
        try {
          new Intl.DateTimeFormat('zh-CN', { timeZone });
          return true;
        } catch {
          return false;
        }
      })
      .default('Asia/Kuala_Lumpur'),
    APP_ENCRYPTION_KEY_BASE64: secretSchema,
    SESSION_SECRET: secretSchema,
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
  })
  .refine(
    ({ NODE_ENV, WEB_ORIGIN }) =>
      NODE_ENV !== 'production' || WEB_ORIGIN.startsWith('https://'),
    {
      path: ['WEB_ORIGIN'],
    },
  )
  .refine(
    ({ APP_ENCRYPTION_KEY_BASE64, SESSION_SECRET }) =>
      APP_ENCRYPTION_KEY_BASE64 !== SESSION_SECRET,
    {
      path: ['SESSION_SECRET'],
    },
  );

export type AppConfig = z.infer<typeof environmentSchema>;

export class SetupError extends Error {}

export function loadLocalEnvironment() {
  if (existsSync(envFile)) loadEnvFile(envFile);
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = environmentSchema.safeParse(env);
  if (!result.success) {
    const fields = [
      ...new Set(result.error.issues.map((issue) => issue.path.join('.'))),
    ];
    throw new SetupError(`请检查环境变量 ${fields.join('、')}。`);
  }
  return result.data;
}

export function databasePath(
  url = process.env.DATABASE_URL ?? 'file:./data/market-sentinel.sqlite',
) {
  if (!url.startsWith('file:') || !url.slice(5).trim()) {
    throw new SetupError('DATABASE_URL 必须指定本地 SQLite 文件。');
  }
  if (url.startsWith('file://')) {
    if (!url.startsWith('file:///'))
      throw new SetupError('DATABASE_URL 必须指定本地 SQLite 文件。');
    return fileURLToPath(url);
  }
  return resolve(workspaceRoot, url.slice(5));
}
