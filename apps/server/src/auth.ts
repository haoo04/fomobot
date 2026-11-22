import { argon2, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { loginRequestSchema } from '@market-sentinel/contracts';
import type {
  AuthSessionResponse,
  LoginRequest,
} from '@market-sentinel/contracts';
import { and, eq, gt, lte } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ApiError } from './api-error.js';
import type { AppDatabase } from './database.js';
import { administrators, auditLogs, sessions } from './schema.js';

const administratorId = 1;
const cookieName = 'market_sentinel_session';
const sessionSeconds = 12 * 60 * 60;
const deriveKey = promisify(argon2);

function passwordKey(password: string, salt: Buffer) {
  return deriveKey('argon2id', {
    message: Buffer.from(password, 'utf8'),
    nonce: salt,
    memory: 65_536,
    passes: 3,
    parallelism: 1,
    tagLength: 32,
  });
}

async function matchesPassword(password: string, hash: string) {
  const [version, salt, tag] = hash.split('.');
  if (version !== 'argon2id-v1' || !salt || !tag) return false;
  const expected = Buffer.from(tag, 'base64url');
  const actual = await passwordKey(password, Buffer.from(salt, 'base64url'));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export async function initializeAdministrator(
  database: AppDatabase,
  credentials: LoginRequest,
) {
  const existing = database
    .select({ id: administrators.id })
    .from(administrators)
    .get();
  if (existing) return false;

  const salt = randomBytes(16);
  const tag = await passwordKey(credentials.password, salt);
  const passwordHash = `argon2id-v1.${salt.toString('base64url')}.${tag.toString('base64url')}`;
  const now = Date.now();

  return database.transaction((transaction) => {
    const created = transaction
      .insert(administrators)
      .values({
        id: administratorId,
        username: credentials.username,
        passwordHash,
        createdAtMs: now,
      })
      .onConflictDoNothing()
      .returning({ id: administrators.id })
      .get();
    if (!created) return false;

    transaction
      .insert(auditLogs)
      .values({
        actor: credentials.username,
        action: 'ADMIN_CREATED',
        targetType: 'administrator',
        targetId: String(administratorId),
        createdAtMs: now,
      })
      .run();
    return true;
  });
}

function hashSession(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

function requireSession(database: AppDatabase, request: FastifyRequest) {
  const cookie = request.cookies[cookieName];
  if (cookie) {
    const signature = request.unsignCookie(cookie);
    if (
      signature.valid &&
      signature.value &&
      /^[\w-]{43}$/.test(signature.value)
    ) {
      const session = database
        .select({
          tokenHash: sessions.tokenHash,
          username: administrators.username,
        })
        .from(sessions)
        .innerJoin(
          administrators,
          eq(sessions.administratorId, administrators.id),
        )
        .where(
          and(
            eq(sessions.tokenHash, hashSession(signature.value)),
            gt(sessions.expiresAtMs, Date.now()),
          ),
        )
        .get();
      if (session) return session;
    }
  }
  throw new ApiError(401, 'UNAUTHENTICATED', '请登录。');
}

export function registerAuthRoutes(
  app: FastifyInstance,
  database: AppDatabase,
  secureCookies: boolean,
) {
  const cookieOptions = {
    path: '/',
    httpOnly: true,
    sameSite: 'strict',
    secure: secureCookies,
  } as const;

  app.post(
    '/api/v1/auth/login',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (request, reply): Promise<AuthSessionResponse> => {
      const parsed = loginRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new ApiError(
          400,
          'INVALID_REQUEST',
          '请检查用户名和密码格式。',
          parsed.error.issues.map((issue) => ({
            field: issue.path.join('.'),
            code: issue.code,
          })),
        );
      }

      const administrator = database.select().from(administrators).get();
      if (!administrator) {
        throw new ApiError(
          503,
          'ADMIN_SETUP_REQUIRED',
          '请先在服务端初始化管理员。',
        );
      }

      const { username, password } = parsed.data;
      const validPassword = await matchesPassword(
        password,
        administrator.passwordHash,
      );
      if (!validPassword || username !== administrator.username) {
        throw new ApiError(401, 'INVALID_CREDENTIALS', '用户名或密码错误。');
      }

      const token = randomBytes(32).toString('base64url');
      const now = Date.now();
      database.transaction((transaction) => {
        transaction
          .delete(sessions)
          .where(lte(sessions.expiresAtMs, now))
          .run();
        transaction
          .insert(sessions)
          .values({
            tokenHash: hashSession(token),
            administratorId: administrator.id,
            expiresAtMs: now + sessionSeconds * 1_000,
          })
          .run();
        transaction
          .insert(auditLogs)
          .values({
            actor: administrator.username,
            action: 'LOGIN',
            targetType: 'administrator',
            targetId: String(administrator.id),
            createdAtMs: now,
          })
          .run();
      });

      reply.setCookie(cookieName, token, {
        ...cookieOptions,
        signed: true,
        maxAge: sessionSeconds,
      });
      return {
        requestId: request.id,
        data: { username: administrator.username },
      };
    },
  );

  app.get(
    '/api/v1/auth/session',
    async (request): Promise<AuthSessionResponse> => {
      const { username } = requireSession(database, request);
      return { requestId: request.id, data: { username } };
    },
  );

  app.post('/api/v1/auth/logout', async (request, reply) => {
    const session = requireSession(database, request);
    database.transaction((transaction) => {
      transaction
        .delete(sessions)
        .where(eq(sessions.tokenHash, session.tokenHash))
        .run();
      transaction
        .insert(auditLogs)
        .values({
          actor: session.username,
          action: 'LOGOUT',
          targetType: 'administrator',
          targetId: String(administratorId),
          createdAtMs: Date.now(),
        })
        .run();
    });
    reply.clearCookie(cookieName, cookieOptions);
    return { requestId: request.id };
  });
}
