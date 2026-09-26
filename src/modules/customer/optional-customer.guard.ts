import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';

import { readRequestCookie } from '../admin-auth/cookie.util';
import { CustomerAccessGuard } from './customer-access.guard';
import { CUSTOMER_ACCESS_COOKIE } from './customer.constants';
import type { CustomerRequest } from './customer.types';

@Injectable()
export class OptionalCustomerGuard implements CanActivate {
  constructor(private readonly requiredGuard: CustomerAccessGuard) {}

  canActivate(context: ExecutionContext): boolean | Promise<boolean> {
    const request = context.switchToHttp().getRequest<CustomerRequest>();
    return readRequestCookie(request, CUSTOMER_ACCESS_COOKIE)
      ? this.requiredGuard.canActivate(context)
      : true;
  }
}
