import {
  apiErrorResponseSchema,
  authSessionResponseSchema,
  livenessResponseSchema,
  readinessResponseSchema,
} from '@market-sentinel/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { FormEvent } from 'react';

const sessionQueryKey = ['session'];

class RequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(
  path: string,
  parse: (body: unknown) => T,
  options?: RequestInit,
) {
  let response: Response;
  try {
    response = await fetch(path, options);
  } catch {
    throw new Error('无法连接服务。');
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const problem = apiErrorResponseSchema.safeParse(body);
    if (problem.success) {
      throw new RequestError(
        problem.data.error.code,
        problem.data.error.message,
      );
    }
    throw new Error('服务暂时无法处理请求。');
  }
  try {
    return parse(body);
  } catch {
    throw new Error('服务响应格式无效。');
  }
}

function Login() {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    const passwordInput = form.elements.namedItem('password');
    if (passwordInput instanceof HTMLInputElement) passwordInput.value = '';
    setPending(true);
    setMessage('');
    try {
      const { data } = await request(
        '/api/v1/auth/login',
        authSessionResponseSchema.parse,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: values.get('username'),
            password: values.get('password'),
          }),
        },
      );
      await queryClient.cancelQueries({ queryKey: sessionQueryKey });
      queryClient.setQueryData(sessionQueryKey, data);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '登录失败。');
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="center-panel">
      <form className="panel login" onSubmit={signIn}>
        <h1>管理员登录</h1>
        <label>
          用户名
          <input
            name="username"
            autoComplete="username"
            maxLength={64}
            required
          />
        </label>
        <label>
          密码
          <input
            name="password"
            type="password"
            autoComplete="current-password"
            maxLength={128}
            required
          />
        </label>
        {message && (
          <p className="error" role="alert">
            {message}
          </p>
        )}
        <button type="submit" className="primary" disabled={pending}>
          {pending ? '正在登录…' : '登录'}
        </button>
      </form>
    </main>
  );
}

function Dashboard({ username }: { username: string }) {
  const queryClient = useQueryClient();
  const live = useQuery({
    queryKey: ['health', 'live'],
    queryFn: () => request('/health/live', livenessResponseSchema.parse),
    refetchInterval: 10_000,
  });
  const ready = useQuery({
    queryKey: ['health', 'ready'],
    queryFn: () => request('/health/ready', readinessResponseSchema.parse),
    refetchInterval: 10_000,
  });
  const logout = useMutation({
    mutationFn: async () => {
      try {
        await request('/api/v1/auth/logout', () => undefined, {
          method: 'POST',
        });
      } catch (error) {
        if (!(
          error instanceof RequestError && error.code === 'UNAUTHENTICATED'
        ))
          throw error;
      }
    },
    onSuccess: async () => {
      await queryClient.cancelQueries({ queryKey: sessionQueryKey });
      queryClient.setQueryData(sessionQueryKey, null);
    },
  });

  const databaseStatus =
    ready.error instanceof RequestError &&
    ready.error.code === 'DATABASE_UNAVAILABLE'
      ? '不可用'
      : '状态未知';

  return (
    <main className="dashboard">
      <div className="dashboard-heading">
        <h1>总览</h1>
        <div className="account">
          <span>{username}</span>
          <button
            type="button"
            onClick={() => logout.mutate()}
            disabled={logout.isPending}
          >
            退出登录
          </button>
        </div>
      </div>
      {logout.isError && (
        <p className="error" role="alert">
          {logout.error.message}
        </p>
      )}
      <section aria-label="系统状态" className="status-grid">
        <div className="panel status-card">
          <h2>API 服务</h2>
          <p role="status" data-state={live.status}>
            {live.isPending
              ? '正在检查'
              : live.isSuccess
                ? '运行中'
                : '连接失败'}
          </p>
        </div>
        <div className="panel status-card">
          <h2>SQLite 数据库</h2>
          <p role="status" data-state={ready.status}>
            {ready.isPending
              ? '正在检查'
              : ready.isSuccess
                ? '就绪'
                : databaseStatus}
          </p>
        </div>
      </section>
    </main>
  );
}

export function App() {
  const session = useQuery({
    queryKey: sessionQueryKey,
    queryFn: async () => {
      try {
        const { data } = await request(
          '/api/v1/auth/session',
          authSessionResponseSchema.parse,
        );
        return data;
      } catch (error) {
        if (error instanceof RequestError && error.code === 'UNAUTHENTICATED')
          return null;
        throw error;
      }
    },
    refetchInterval: 60_000,
  });

  return (
    <>
      <header className="header">
        <div className="header-inner">
          <span className="brand-mark" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <strong>Market Sentinel</strong>
        </div>
      </header>
      {session.isPending && (
        <main className="center-panel">
          <p role="status">正在连接…</p>
        </main>
      )}
      {session.isError && (
        <main className="center-panel">
          <div className="panel login">
            <p className="error" role="alert">
              {session.error.message}
            </p>
            <button type="button" onClick={() => void session.refetch()}>
              重试
            </button>
          </div>
        </main>
      )}
      {session.isSuccess &&
        (session.data ? (
          <Dashboard username={session.data.username} />
        ) : (
          <Login />
        ))}
    </>
  );
}
