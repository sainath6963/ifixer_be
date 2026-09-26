import {
  Controller,
  Delete,
  Get,
  Header,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';

import { AdminRole } from '../../domain/enums';
import { AdminAccessGuard } from '../admin-auth/admin-access.guard';
import { ADMIN_ACCESS_SECURITY } from '../admin-auth/auth.constants';
import { CsrfGuard } from '../admin-auth/csrf.guard';
import { getAuthRequestContext } from '../admin-auth/http-context';
import { AdminRoles } from '../admin-auth/roles.decorator';
import { AdminRolesGuard } from '../admin-auth/roles.guard';
import { CustomerAccessGuard } from '../customer/customer-access.guard';
import { CUSTOMER_ACCESS_SECURITY } from '../customer/customer.constants';
import { CustomerCsrfGuard } from '../customer/customer-csrf.guard';
import { CurrentCustomer } from '../customer/current-customer.decorator';
import type { AuthenticatedCustomer } from '../customer/customer.types';
import {
  StockAlertVariantParamDto,
  StockDemandQueryDto,
  WishlistPageQueryDto,
  WishlistProductParamDto,
} from './dto/wishlist.dto';
import { WishlistService } from './wishlist.service';
import type {
  ProductStockAlertState,
  StockAlertView,
  StockDemandPage,
  WishlistPage,
} from './wishlist.types';

@ApiTags('customer-wishlist')
@ApiCookieAuth(CUSTOMER_ACCESS_SECURITY)
@Controller('customer/wishlist')
@UseGuards(CustomerCsrfGuard, CustomerAccessGuard)
export class CustomerWishlistController {
  constructor(private readonly wishlist: WishlistService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'List active storefront products saved by the current customer' })
  list(
    @CurrentCustomer() customer: AuthenticatedCustomer,
    @Query() query: WishlistPageQueryDto,
  ): Promise<WishlistPage> {
    return this.wishlist.list(customer.id, query);
  }

  @Get('products/:productId')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Get current-customer wishlist membership for one product' })
  membership(
    @CurrentCustomer() customer: AuthenticatedCustomer,
    @Param() params: WishlistProductParamDto,
  ): Promise<{ wishlisted: boolean }> {
    return this.wishlist.membership(customer.id, params.productId);
  }

  @Post(':productId')
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'Idempotently save an active product to the wishlist' })
  add(
    @CurrentCustomer() customer: AuthenticatedCustomer,
    @Param() params: WishlistProductParamDto,
    @Req() request: Request,
  ): Promise<{ wishlisted: true }> {
    return this.wishlist.add(customer.id, params.productId, getAuthRequestContext(request));
  }

  @Delete(':productId')
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'Idempotently remove a product from the wishlist' })
  remove(
    @CurrentCustomer() customer: AuthenticatedCustomer,
    @Param() params: WishlistProductParamDto,
    @Req() request: Request,
  ): Promise<{ wishlisted: false }> {
    return this.wishlist.remove(customer.id, params.productId, getAuthRequestContext(request));
  }
}

@ApiTags('customer-stock-alerts')
@ApiCookieAuth(CUSTOMER_ACCESS_SECURITY)
@Controller('customer/stock-alerts')
@UseGuards(CustomerCsrfGuard, CustomerAccessGuard)
export class CustomerStockAlertController {
  constructor(private readonly wishlist: WishlistService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'List active back-in-stock subscriptions' })
  list(@CurrentCustomer() customer: AuthenticatedCustomer): Promise<{ alerts: StockAlertView[] }> {
    return this.wishlist.listAlerts(customer.id);
  }

  @Get('product/:productId')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Get email eligibility and active alerts for a product' })
  productState(
    @CurrentCustomer() customer: AuthenticatedCustomer,
    @Param() params: WishlistProductParamDto,
  ): Promise<ProductStockAlertState> {
    return this.wishlist.productAlertState(customer, params.productId);
  }

  @Post(':productId/variants/:variantId')
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: 'Subscribe a verified email to an unavailable product option' })
  subscribe(
    @CurrentCustomer() customer: AuthenticatedCustomer,
    @Param() params: StockAlertVariantParamDto,
    @Req() request: Request,
  ): Promise<StockAlertView> {
    return this.wishlist.subscribe(
      customer,
      params.productId,
      params.variantId,
      getAuthRequestContext(request),
    );
  }

  @Delete(':productId/variants/:variantId')
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: 'Cancel an active back-in-stock subscription' })
  cancel(
    @CurrentCustomer() customer: AuthenticatedCustomer,
    @Param() params: StockAlertVariantParamDto,
    @Req() request: Request,
  ): Promise<{ active: false }> {
    return this.wishlist.cancelAlert(
      customer,
      params.productId,
      params.variantId,
      getAuthRequestContext(request),
    );
  }
}

@ApiTags('admin-stock-demand')
@ApiCookieAuth(ADMIN_ACCESS_SECURITY)
@Controller('admin/stock-demand')
@UseGuards(CsrfGuard, AdminAccessGuard, AdminRolesGuard)
@AdminRoles(AdminRole.Owner, AdminRole.Staff)
export class AdminStockDemandController {
  constructor(private readonly wishlist: WishlistService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Aggregate active stock-alert demand by product option' })
  demand(@Query() query: StockDemandQueryDto): Promise<StockDemandPage> {
    return this.wishlist.demand(query);
  }
}
