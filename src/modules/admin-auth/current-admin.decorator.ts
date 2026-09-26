import { createParamDecorator, ExecutionContext } from '@nestjs/common';

import type { AuthenticatedAdmin, AuthenticatedAdminRequest } from './auth.types';

export const CurrentAdmin = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedAdmin => {
    const request = context.switchToHttp().getRequest<AuthenticatedAdminRequest>();
    if (!request.admin) {
      throw new Error('CurrentAdmin can only be used on an authenticated route');
    }
    return request.admin;
  },
);
