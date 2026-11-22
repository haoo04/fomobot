import type { ApiErrorResponse } from '@market-sentinel/contracts';

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
