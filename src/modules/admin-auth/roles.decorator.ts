import { SetMetadata } from '@nestjs/common';

import { AdminRole } from '../../domain/enums';
import { ADMIN_ROLES_METADATA } from './auth.constants';

export const AdminRoles = (...roles: AdminRole[]): MethodDecorator & ClassDecorator =>
  SetMetadata(ADMIN_ROLES_METADATA, roles);
