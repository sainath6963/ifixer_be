import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';

import { ADMIN_ACCESS_COOKIE } from './auth.constants';
import { AdminAuthService } from './admin-auth.service';
import type { AuthenticatedAdminRequest } from './auth.types';
import { readRequestCookie } from './cookie.util';

@Injectable()
export class AdminAccessGuard implements CanActivate {
  constructor(private readonly auth: AdminAuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedAdminRequest>();
    const accessToken = readRequestCookie(request, ADMIN_ACCESS_COOKIE);
    if (!accessToken) {
      throw new UnauthorizedException({
        code: 'ADMIN_SESSION_REQUIRED',
        message: 'Admin authentication is required',
      });
    }

    request.admin = await this.auth.authenticateAccess(accessToken);
    return true;
  }
}
