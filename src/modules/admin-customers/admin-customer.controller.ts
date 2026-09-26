import { Controller, Get, Header, Param, Query, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { AdminRole } from '../../domain/enums';
import { AdminAccessGuard } from '../admin-auth/admin-access.guard';
import { ADMIN_ACCESS_SECURITY } from '../admin-auth/auth.constants';
import { CsrfGuard } from '../admin-auth/csrf.guard';
import { AdminRoles } from '../admin-auth/roles.decorator';
import { AdminRolesGuard } from '../admin-auth/roles.guard';
import { AdminCustomerService } from './admin-customer.service';
import type { AdminCustomerDetail, AdminCustomerPage } from './admin-customer.types';
import { AdminCustomerListQueryDto, AdminCustomerParamDto } from './dto/admin-customer.dto';

@ApiTags('admin-customers')
@ApiCookieAuth(ADMIN_ACCESS_SECURITY)
@Controller('admin/customers')
@UseGuards(CsrfGuard, AdminAccessGuard, AdminRolesGuard)
@AdminRoles(AdminRole.Owner, AdminRole.Staff)
export class AdminCustomerController {
  constructor(private readonly customers: AdminCustomerService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Search customer profiles and purchase summaries' })
  list(@Query() query: AdminCustomerListQueryDto): Promise<AdminCustomerPage> {
    return this.customers.list(query);
  }

  @Get(':customerId')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'View a customer profile and recent order activity' })
  async get(@Param() params: AdminCustomerParamDto): Promise<{ customer: AdminCustomerDetail }> {
    return { customer: await this.customers.get(params.customerId) };
  }
}
