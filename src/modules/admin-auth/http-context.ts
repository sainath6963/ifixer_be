import type { Request } from 'express';

import type { AuthRequestContext } from './auth.types';

export function getAuthRequestContext(request: Request): AuthRequestContext {
  const userAgent = request.headers['user-agent'];
  const requestId =
    typeof request.id === 'string'
      ? request.id
      : typeof request.id === 'number'
        ? request.id.toString()
        : undefined;

  return {
    ipAddress: request.ip || request.socket.remoteAddress || 'unknown',
    userAgent: typeof userAgent === 'string' ? userAgent.slice(0, 500) : undefined,
    requestId,
  };
}
