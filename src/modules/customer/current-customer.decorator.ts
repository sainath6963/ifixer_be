import { createParamDecorator, ExecutionContext } from '@nestjs/common';

import type { AuthenticatedCustomer, CustomerRequest } from './customer.types';

export const CurrentCustomer = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedCustomer => {
    const request = context.switchToHttp().getRequest<CustomerRequest>();
    if (!request.customer) {
      throw new Error('CurrentCustomer can only be used on an authenticated route');
    }
    return request.customer;
  },
);
