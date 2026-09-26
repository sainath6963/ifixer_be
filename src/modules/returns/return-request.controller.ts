import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiCookieAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';

import { AdminRole } from '../../domain/enums';
import { AdminAccessGuard } from '../admin-auth/admin-access.guard';
import { ADMIN_ACCESS_SECURITY } from '../admin-auth/auth.constants';
import type { AuthenticatedAdmin } from '../admin-auth/auth.types';
import { CsrfGuard } from '../admin-auth/csrf.guard';
import { CurrentAdmin } from '../admin-auth/current-admin.decorator';
import { getAuthRequestContext } from '../admin-auth/http-context';
import { AdminRoles } from '../admin-auth/roles.decorator';
import { AdminRolesGuard } from '../admin-auth/roles.guard';
import { CustomerAccessGuard } from '../customer/customer-access.guard';
import { CUSTOMER_ACCESS_SECURITY } from '../customer/customer.constants';
import { CustomerCsrfGuard } from '../customer/customer-csrf.guard';
import { CurrentCustomer } from '../customer/current-customer.decorator';
import type { AuthenticatedCustomer } from '../customer/customer.types';
import {
  AdminReturnListQueryDto,
  CancelReturnRequestDto,
  CompleteReturnRequestDto,
  CreateReturnRequestDto,
  CustomerOrderReturnParamsDto,
  DecideReturnRequestDto,
  ReceiveReturnRequestDto,
  ReturnNumberParamDto,
} from './dto/return-request.dto';
import { ReturnRequestService } from './return-request.service';
import type {
  AdminReturnRequestPage,
  AdminReturnRequestView,
  CustomerReturnsView,
  ReturnRequestView,
} from './return-request.types';

@ApiTags('customer-returns')
@ApiCookieAuth(CUSTOMER_ACCESS_SECURITY)
@Controller('customer/orders/:orderNumber/returns')
@UseGuards(CustomerCsrfGuard, CustomerAccessGuard)
export class CustomerReturnRequestController {
  constructor(private readonly returns: ReturnRequestService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @ApiOperation({ summary: 'Get return eligibility and requests for an owned order' })
  get(
    @CurrentCustomer() customer: AuthenticatedCustomer,
    @Param('orderNumber') orderNumber: string,
  ): Promise<CustomerReturnsView> {
    return this.returns.customerOrderReturns(customer, orderNumber);
  }

  @Post()
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: 'Unique 16-160 character key reused only for an identical request retry',
  })
  @ApiOperation({ summary: 'Create an item-level return or exchange request' })
  create(
    @CurrentCustomer() customer: AuthenticatedCustomer,
    @Param('orderNumber') orderNumber: string,
    @Body() input: CreateReturnRequestDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: Request,
  ): Promise<ReturnRequestView> {
    return this.returns.create(
      customer,
      orderNumber,
      input,
      idempotencyKey,
      getAuthRequestContext(request),
    );
  }

  @Post(':returnNumber/cancel')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Cancel a pending owned return request' })
  cancel(
    @CurrentCustomer() customer: AuthenticatedCustomer,
    @Param() params: CustomerOrderReturnParamsDto,
    @Body() input: CancelReturnRequestDto,
    @Req() request: Request,
  ): Promise<ReturnRequestView> {
    return this.returns.cancel(
      customer,
      params.orderNumber,
      params.returnNumber,
      input,
      getAuthRequestContext(request),
    );
  }
}

@ApiTags('admin-returns')
@ApiCookieAuth(ADMIN_ACCESS_SECURITY)
@Controller('admin/returns')
@UseGuards(CsrfGuard, AdminAccessGuard, AdminRolesGuard)
@AdminRoles(AdminRole.Owner, AdminRole.Staff)
export class AdminReturnRequestController {
  constructor(private readonly returns: ReturnRequestService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Search and filter the admin returns queue' })
  list(@Query() query: AdminReturnListQueryDto): Promise<AdminReturnRequestPage> {
    return this.returns.adminList(query);
  }

  @Get(':returnNumber')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Get an admin return request detail' })
  get(@Param() params: ReturnNumberParamDto): Promise<AdminReturnRequestView> {
    return this.returns.adminGet(params.returnNumber);
  }

  @Patch(':returnNumber/decision')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Approve or reject a pending return request' })
  decide(
    @Param() params: ReturnNumberParamDto,
    @Body() input: DecideReturnRequestDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Req() request: Request,
  ): Promise<AdminReturnRequestView> {
    return this.returns.decide(params.returnNumber, input, admin, getAuthRequestContext(request));
  }

  @Patch(':returnNumber/receive')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Record inspection and idempotently restock resaleable quantities' })
  receive(
    @Param() params: ReturnNumberParamDto,
    @Body() input: ReceiveReturnRequestDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Req() request: Request,
  ): Promise<AdminReturnRequestView> {
    return this.returns.receive(params.returnNumber, input, admin, getAuthRequestContext(request));
  }

  @Patch(':returnNumber/complete')
  @AdminRoles(AdminRole.Owner)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Complete a return with a settled refund or exchange tracking' })
  complete(
    @Param() params: ReturnNumberParamDto,
    @Body() input: CompleteReturnRequestDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Req() request: Request,
  ): Promise<AdminReturnRequestView> {
    return this.returns.complete(params.returnNumber, input, admin, getAuthRequestContext(request));
  }
}
