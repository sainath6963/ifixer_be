import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiCookieAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';

import { getAuthRequestContext } from '../admin-auth/http-context';
import { CustomerAccessGuard } from '../customer/customer-access.guard';
import { CUSTOMER_ACCESS_SECURITY } from '../customer/customer.constants';
import { CustomerCsrfGuard } from '../customer/customer-csrf.guard';
import { CurrentCustomer } from '../customer/current-customer.decorator';
import type { AuthenticatedCustomer } from '../customer/customer.types';
import { CheckoutService } from './checkout.service';
import type { CheckoutPreview, CustomerOrderPage, CustomerOrderView } from './checkout.types';
import {
  CheckoutRequestDto,
  CustomerOrderListQueryDto,
  CustomerOrderNumberParamDto,
} from './dto/checkout.dto';

@ApiTags('customer-checkout')
@ApiCookieAuth(CUSTOMER_ACCESS_SECURITY)
@Controller('checkout')
@UseGuards(CustomerCsrfGuard, CustomerAccessGuard)
export class CheckoutController {
  constructor(private readonly checkout: CheckoutService) {}

  @Post('preview')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'Reprice the current cart and preview checkout totals' })
  async preview(
    @CurrentCustomer() customer: AuthenticatedCustomer,
    @Body() input: CheckoutRequestDto,
  ): Promise<{ preview: CheckoutPreview }> {
    return { preview: await this.checkout.preview(customer, input) };
  }

  @Post('orders')
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 15, ttl: 60_000 } })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: 'A unique 16-160 character key reused only when retrying the same checkout',
  })
  @ApiOperation({ summary: 'Create an unpaid order and reserve inventory atomically' })
  async createOrder(
    @CurrentCustomer() customer: AuthenticatedCustomer,
    @Body() input: CheckoutRequestDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: Request,
  ): Promise<{ order: CustomerOrderView }> {
    return {
      order: await this.checkout.createOrder(
        customer,
        input,
        idempotencyKey,
        getAuthRequestContext(request),
      ),
    };
  }
}

@ApiTags('customer-orders')
@ApiCookieAuth(CUSTOMER_ACCESS_SECURITY)
@Controller('customer/orders')
@UseGuards(CustomerCsrfGuard, CustomerAccessGuard)
export class CustomerOrderController {
  constructor(private readonly checkout: CheckoutService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @ApiOperation({ summary: 'List orders belonging to the current customer' })
  list(
    @CurrentCustomer() customer: AuthenticatedCustomer,
    @Query() query: CustomerOrderListQueryDto,
  ): Promise<CustomerOrderPage> {
    return this.checkout.list(customer, query);
  }

  @Get(':orderNumber')
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @ApiOperation({ summary: 'Get one order belonging to the current customer' })
  async get(
    @CurrentCustomer() customer: AuthenticatedCustomer,
    @Param() params: CustomerOrderNumberParamDto,
  ): Promise<{ order: CustomerOrderView }> {
    return { order: await this.checkout.get(customer, params.orderNumber) };
  }

  @Post(':orderNumber/cancel')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 15, ttl: 60_000 } })
  @ApiOperation({ summary: 'Cancel an unpaid pending order and release its inventory' })
  async cancel(
    @CurrentCustomer() customer: AuthenticatedCustomer,
    @Param() params: CustomerOrderNumberParamDto,
    @Req() request: Request,
  ): Promise<{ order: CustomerOrderView }> {
    return {
      order: await this.checkout.cancel(
        customer,
        params.orderNumber,
        getAuthRequestContext(request),
      ),
    };
  }
}
