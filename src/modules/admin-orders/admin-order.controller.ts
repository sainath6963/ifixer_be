import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiCookieAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
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
import { RefundService } from '../payments/refund.service';
import type { RefundRequestResult } from '../payments/refund.types';
import { AdminOrderService } from './admin-order.service';
import { AdminShipmentService } from './admin-shipment.service';
import type {
  AdminOrderDetailView,
  AdminOrderPage,
  OrderOperationsSummary,
} from './admin-order.types';
import { CreateShipmentDto, UpdateShipmentStatusDto } from './dto/admin-shipment.dto';
import {
  AdminOrderListQueryDto,
  CreateRefundDto,
  UpdateAdminNoteDto,
  UpdateFulfillmentDto,
} from './dto/admin-order.dto';

@ApiTags('admin-orders')
@ApiCookieAuth(ADMIN_ACCESS_SECURITY)
@Controller('admin/orders')
@UseGuards(CsrfGuard, AdminAccessGuard, AdminRolesGuard)
@AdminRoles(AdminRole.Owner, AdminRole.Staff)
export class AdminOrderController {
  constructor(
    private readonly orders: AdminOrderService,
    private readonly shipments: AdminShipmentService,
    private readonly refunds: RefundService,
  ) {}

  @Get('operations-summary')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Get fulfillment, refund, and late-capture operational counts' })
  summary(): Promise<OrderOperationsSummary> {
    return this.orders.summary();
  }

  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Search and filter orders for admin operations' })
  list(@Query() query: AdminOrderListQueryDto): Promise<AdminOrderPage> {
    return this.orders.list(query);
  }

  @Get(':orderNumber')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Get full order, payment, refund, and shipping details' })
  async get(@Param('orderNumber') orderNumber: string): Promise<{ order: AdminOrderDetailView }> {
    return { order: await this.orders.get(orderNumber) };
  }

  @Patch(':orderNumber/fulfillment')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Apply a guarded fulfillment transition' })
  async updateFulfillment(
    @Param('orderNumber') orderNumber: string,
    @Body() input: UpdateFulfillmentDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Req() request: Request,
  ): Promise<{ order: AdminOrderDetailView }> {
    return {
      order: await this.orders.updateFulfillment(
        orderNumber,
        input,
        admin,
        getAuthRequestContext(request),
      ),
    };
  }

  @Post(':orderNumber/shipment')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Create a provider-neutral manual shipment for a processing order' })
  async createShipment(
    @Param('orderNumber') orderNumber: string,
    @Body() input: CreateShipmentDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Req() request: Request,
  ): Promise<{ order: AdminOrderDetailView }> {
    await this.shipments.create(orderNumber, input, admin, getAuthRequestContext(request));
    return { order: await this.orders.get(orderNumber) };
  }

  @Patch(':orderNumber/shipment/status')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Append a guarded shipment event and synchronize order fulfillment' })
  async updateShipmentStatus(
    @Param('orderNumber') orderNumber: string,
    @Body() input: UpdateShipmentStatusDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Req() request: Request,
  ): Promise<{ order: AdminOrderDetailView }> {
    await this.shipments.updateStatus(orderNumber, input, admin, getAuthRequestContext(request));
    return { order: await this.orders.get(orderNumber) };
  }

  @Patch(':orderNumber/admin-note')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Set or clear a private admin order note' })
  async updateAdminNote(
    @Param('orderNumber') orderNumber: string,
    @Body() input: UpdateAdminNoteDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Req() request: Request,
  ): Promise<{ order: AdminOrderDetailView }> {
    return {
      order: await this.orders.updateAdminNote(
        orderNumber,
        input,
        admin,
        getAuthRequestContext(request),
      ),
    };
  }

  @Post(':orderNumber/refunds')
  @AdminRoles(AdminRole.Owner)
  @Header('Cache-Control', 'no-store')
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: 'Unique 16-160 character key reused only for the identical refund retry',
  })
  @ApiOperation({ summary: 'Issue an irreversible full or partial Razorpay refund' })
  requestRefund(
    @Param('orderNumber') orderNumber: string,
    @Body() input: CreateRefundDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Req() request: Request,
  ): Promise<RefundRequestResult> {
    return this.refunds.request(
      orderNumber,
      input,
      idempotencyKey,
      admin,
      getAuthRequestContext(request),
    );
  }
}
