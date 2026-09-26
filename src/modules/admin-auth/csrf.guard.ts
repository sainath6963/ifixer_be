import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';

import { ADMIN_CSRF_COOKIE, ADMIN_CSRF_HEADER } from './auth.constants';
import { readRequestCookie } from './cookie.util';
import { CsrfService } from './csrf.service';
import type { AuthenticatedAdminRequest } from './auth.types';

@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(private readonly csrf: CsrfService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedAdminRequest>();
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      return true;
    }

    const cookieToken = readRequestCookie(request, ADMIN_CSRF_COOKIE);
    const header = request.headers[ADMIN_CSRF_HEADER];
    const headerToken = typeof header === 'string' ? header : undefined;

    if (!cookieToken || !headerToken || !this.csrf.verify(cookieToken, headerToken)) {
      throw new ForbiddenException({
        code: 'CSRF_TOKEN_INVALID',
        message: 'CSRF token is missing, invalid, or expired',
      });
    }

    return true;
  }
}
