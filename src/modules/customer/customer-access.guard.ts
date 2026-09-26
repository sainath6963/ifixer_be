import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';

import { readRequestCookie } from '../admin-auth/cookie.util';
import { CustomerAuthService } from './customer-auth.service';
import { CUSTOMER_ACCESS_COOKIE } from './customer.constants';
import type { CustomerRequest } from './customer.types';

@Injectable()
export class CustomerAccessGuard implements CanActivate {
  constructor(private readonly auth: CustomerAuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<CustomerRequest>();
    const accessToken = readRequestCookie(request, CUSTOMER_ACCESS_COOKIE);
    if (!accessToken) {
      throw new UnauthorizedException({
        code: 'CUSTOMER_SESSION_REQUIRED',
        message: 'Customer authentication is required',
      });
    }
    request.customer = await this.auth.authenticateAccess(accessToken);
    return true;
  }
}
