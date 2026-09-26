import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  Patch,
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
  AdminProductReviewListQueryDto,
  CreateProductReviewDto,
  ModerateProductReviewDto,
  ProductReviewIdParamDto,
  ProductReviewListQueryDto,
  ProductReviewProductParamDto,
  UpdateProductReviewDto,
  WithdrawProductReviewDto,
} from './dto/product-review.dto';
import { ProductReviewService } from './product-review.service';
import type {
  AdminProductReviewPage,
  AdminProductReviewView,
  CustomerProductReviewView,
  CustomerReviewEligibilityView,
  ProductReviewPage,
} from './product-review.types';

@ApiTags('product-reviews')
@Controller('catalog/products/:productId/reviews')
export class PublicProductReviewController {
  constructor(private readonly reviews: ProductReviewService) {}

  @Get()
  @Header('Cache-Control', 'public, max-age=30, stale-while-revalidate=60')
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @ApiOperation({ summary: 'List moderated verified-purchase reviews and rating summary' })
  list(
    @Param() params: ProductReviewProductParamDto,
    @Query() query: ProductReviewListQueryDto,
  ): Promise<ProductReviewPage> {
    return this.reviews.publicList(params.productId, query);
  }
}

@ApiTags('customer-product-reviews')
@ApiCookieAuth(CUSTOMER_ACCESS_SECURITY)
@Controller('customer/reviews')
@UseGuards(CustomerCsrfGuard, CustomerAccessGuard)
export class CustomerProductReviewController {
  constructor(private readonly reviews: ProductReviewService) {}

  @Get('product/:productId')
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @ApiOperation({ summary: 'Get verified-buyer eligibility and the current customer review' })
  eligibility(
    @CurrentCustomer() customer: AuthenticatedCustomer,
    @Param() params: ProductReviewProductParamDto,
  ): Promise<CustomerReviewEligibilityView> {
    return this.reviews.eligibility(customer, params.productId);
  }

  @Post()
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 8, ttl: 60_000 } })
  @ApiOperation({ summary: 'Submit one verified-purchase review per product' })
  create(
    @CurrentCustomer() customer: AuthenticatedCustomer,
    @Body() input: CreateProductReviewDto,
    @Req() request: Request,
  ): Promise<CustomerProductReviewView> {
    return this.reviews.create(customer, input, getAuthRequestContext(request));
  }

  @Patch(':reviewId')
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 12, ttl: 60_000 } })
  @ApiOperation({ summary: 'Revise and resubmit an owned review for moderation' })
  update(
    @CurrentCustomer() customer: AuthenticatedCustomer,
    @Param() params: ProductReviewIdParamDto,
    @Body() input: UpdateProductReviewDto,
    @Req() request: Request,
  ): Promise<CustomerProductReviewView> {
    return this.reviews.update(customer, params.reviewId, input, getAuthRequestContext(request));
  }

  @Post(':reviewId/withdraw')
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 12, ttl: 60_000 } })
  @ApiOperation({ summary: 'Withdraw an owned review from moderation or publication' })
  withdraw(
    @CurrentCustomer() customer: AuthenticatedCustomer,
    @Param() params: ProductReviewIdParamDto,
    @Body() input: WithdrawProductReviewDto,
    @Req() request: Request,
  ): Promise<CustomerProductReviewView> {
    return this.reviews.withdraw(
      customer,
      params.reviewId,
      input.expectedVersion,
      getAuthRequestContext(request),
    );
  }
}

@ApiTags('admin-product-reviews')
@ApiCookieAuth(ADMIN_ACCESS_SECURITY)
@Controller('admin/reviews')
@UseGuards(CsrfGuard, AdminAccessGuard, AdminRolesGuard)
@AdminRoles(AdminRole.Owner, AdminRole.Staff)
export class AdminProductReviewController {
  constructor(private readonly reviews: ProductReviewService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Search and filter the review moderation queue' })
  list(@Query() query: AdminProductReviewListQueryDto): Promise<AdminProductReviewPage> {
    return this.reviews.adminList(query);
  }

  @Patch(':reviewId/moderation')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Publish or reject a customer product review' })
  moderate(
    @Param() params: ProductReviewIdParamDto,
    @Body() input: ModerateProductReviewDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Req() request: Request,
  ): Promise<AdminProductReviewView> {
    return this.reviews.moderate(params.reviewId, input, admin, getAuthRequestContext(request));
  }
}
