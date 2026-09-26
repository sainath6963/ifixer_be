import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';

import { readRequestCookie } from '../admin-auth/cookie.util';
import { CUSTOMER_CSRF_COOKIE, CUSTOMER_CSRF_HEADER } from './customer.constants';
import { CustomerCsrfService } from './customer-csrf.service';
import type { CustomerRequest } from './customer.types';

@Injectable()
export class CustomerCsrfGuard implements CanActivate {
  constructor(private readonly csrf: CustomerCsrfService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<CustomerRequest>();
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return true;

    const cookieToken = readRequestCookie(request, CUSTOMER_CSRF_COOKIE);
    const header = request.headers[CUSTOMER_CSRF_HEADER];
    const headerToken = typeof header === 'string' ? header : undefined;
    if (!cookieToken || !headerToken || !this.csrf.verify(cookieToken, headerToken)) {
      throw new ForbiddenException({
        code: 'CUSTOMER_CSRF_TOKEN_INVALID',
        message: 'Customer CSRF token is missing, invalid, or expired',
      });
    }
    return true;
  }
}
