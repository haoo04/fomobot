import type { ApiErrorResponse } from '@market-sentinel/contracts';
import type { ZodType } from 'zod';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: ApiErrorResponse['error']['details'],
  ) {
    super(message);
  }
}

export function validated<T>(schema: ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new ApiError(
      400,
      'INVALID_REQUEST',
      '请检查请求参数。',
      result.error.issues.map((issue) => ({
        field: issue.path.join('.'),
        code: issue.code,
      })),
    );
  return result.data;
}
