import { apiErrorResponseSchema } from '@market-sentinel/contracts';

export class RequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function requestResponse(path: string, options?: RequestInit) {
  let response: Response;
  try {
    response = await fetch(path, options);
  } catch {
    throw new Error('无法连接服务。');
  }
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const problem = apiErrorResponseSchema.safeParse(body);
    if (problem.success) {
      throw new RequestError(
        problem.data.error.code,
        problem.data.error.message,
      );
    }
    throw new Error('服务暂时无法处理请求。');
  }
  return response;
}

export async function request<T>(
  path: string,
  parse: (body: unknown) => T,
  options?: RequestInit,
) {
  const response = await requestResponse(path, options);
  const body: unknown = await response.json().catch(() => null);
  try {
    return parse(body);
  } catch {
    throw new Error('服务响应格式无效。');
  }
}
