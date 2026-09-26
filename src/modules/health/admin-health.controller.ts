import { Controller, Get, Header, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { HealthCheck, HealthCheckResult } from '@nestjs/terminus';

import { AdminRole } from '../../domain/enums';
import { AdminAccessGuard } from '../admin-auth/admin-access.guard';
import { ADMIN_ACCESS_SECURITY } from '../admin-auth/auth.constants';
import { CsrfGuard } from '../admin-auth/csrf.guard';
import { AdminRoles } from '../admin-auth/roles.decorator';
import { AdminRolesGuard } from '../admin-auth/roles.guard';
import { ReadinessService } from './readiness.service';

@ApiTags('admin-health')
@ApiCookieAuth(ADMIN_ACCESS_SECURITY)
@Controller('admin/health')
@UseGuards(CsrfGuard, AdminAccessGuard, AdminRolesGuard)
@AdminRoles(AdminRole.Owner, AdminRole.Staff)
export class AdminHealthController {
  constructor(private readonly readiness: ReadinessService) {}

  @Get('ready')
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @HealthCheck()
  @ApiOperation({ summary: 'Return detailed infrastructure readiness to authenticated admins' })
  ready(): Promise<HealthCheckResult> {
    return this.readiness.check();
  }
}
