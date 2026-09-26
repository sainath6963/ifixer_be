import type { RepairBookingView, RepairBookingPage } from './repair-booking.types';
import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { AdminRole } from '../../domain/enums';
import { AdminAccessGuard } from '../admin-auth/admin-access.guard';
import { CsrfGuard } from '../admin-auth/csrf.guard';
import { AdminRoles } from '../admin-auth/roles.decorator';
import { AdminRolesGuard } from '../admin-auth/roles.guard';
import { CurrentAdmin } from '../admin-auth/current-admin.decorator';
import type { AuthenticatedAdmin } from '../admin-auth/auth.types';
import { getAuthRequestContext } from '../admin-auth/http-context';
import { CustomerCsrfGuard } from '../customer/customer-csrf.guard';
import { OptionalCustomerGuard } from '../customer/optional-customer.guard';
import type { CustomerRequest } from '../customer/customer.types';
import { BookingChangeDto, BookingListDto, CreateRepairBookingDto } from './repair-booking.dto';
import { RepairBookingService } from './repair-booking.service';

@Controller('repair/bookings')
@UseGuards(CustomerCsrfGuard, OptionalCustomerGuard)
export class RepairBookingController {
  constructor(private readonly bookings: RepairBookingService) {}
  @Post()
  @Throttle({ default: { limit: 12, ttl: 60000 } })
  async create(
    @Body() input: CreateRepairBookingDto,
    @Req() request: CustomerRequest,
  ): Promise<{ booking: RepairBookingView }> {
    return {
      booking: await this.bookings.create(input, {
        customerId: request.customer?.id,
        context: getAuthRequestContext(request),
      }),
    };
  }
  @Get(':reference')
  async get(
    @Param('reference') reference: string,
    @Headers('x-repair-token') token: string | undefined,
    @Req() request: CustomerRequest,
  ): Promise<{ booking: RepairBookingView }> {
    return {
      booking: await this.bookings.get(reference, {
        token,
        customerId: request.customer?.id,
        context: getAuthRequestContext(request),
      }),
    };
  }
  @Patch(':reference')
  async change(
    @Param('reference') reference: string,
    @Body() input: BookingChangeDto,
    @Headers('x-repair-token') token: string | undefined,
    @Req() request: CustomerRequest,
  ): Promise<{ booking: RepairBookingView }> {
    return {
      booking: await this.bookings.change(reference, input, {
        token,
        customerId: request.customer?.id,
        context: getAuthRequestContext(request),
      }),
    };
  }
}

@Controller('admin/repair/bookings')
@UseGuards(CsrfGuard, AdminAccessGuard, AdminRolesGuard)
@AdminRoles(AdminRole.Owner, AdminRole.Staff, AdminRole.Reception)
export class AdminRepairBookingController {
  constructor(private readonly bookings: RepairBookingService) {}
  @Get() list(@Query() query: BookingListDto): Promise<RepairBookingPage> {
    return this.bookings.list(query);
  }
  @Post() async create(
    @Body() input: CreateRepairBookingDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Req() request: Request,
  ): Promise<{ booking: RepairBookingView }> {
    return {
      booking: await this.bookings.create(input, {
        adminId: admin.id,
        context: getAuthRequestContext(request),
      }),
    };
  }
  @Get(':reference') async get(
    @Param('reference') reference: string,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Req() request: Request,
  ): Promise<{ booking: RepairBookingView }> {
    return {
      booking: await this.bookings.get(reference, {
        adminId: admin.id,
        context: getAuthRequestContext(request),
      }),
    };
  }
  @Patch(':reference') async change(
    @Param('reference') reference: string,
    @Body() input: BookingChangeDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Req() request: Request,
  ): Promise<{ booking: RepairBookingView }> {
    return {
      booking: await this.bookings.change(reference, input, {
        adminId: admin.id,
        context: getAuthRequestContext(request),
      }),
    };
  }
}
