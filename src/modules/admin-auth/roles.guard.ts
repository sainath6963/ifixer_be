import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { AdminRole } from '../../domain/enums';
import { ADMIN_ROLES_METADATA } from './auth.constants';
import type { AuthenticatedAdminRequest } from './auth.types';

@Injectable()
export class AdminRolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<AdminRole[]>(ADMIN_ROLES_METADATA, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!requiredRoles?.length) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedAdminRequest>();
    if (!request.admin || !requiredRoles.some((role) => request.admin?.roles.includes(role))) {
      throw new ForbiddenException({
        code: 'ADMIN_ROLE_FORBIDDEN',
        message: 'Your admin role does not allow this action',
      });
    }
    return true;
  }
}
