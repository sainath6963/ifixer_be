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
import { CouponListQueryDto, CreateCouponDto, UpdateCouponDto } from './dto/promotion.dto';
import { PromotionService } from './promotion.service';
import type { CouponPage, CouponView } from './promotion.types';

@ApiTags('admin-promotions')
@ApiCookieAuth(ADMIN_ACCESS_SECURITY)
@Controller('admin/coupons')
@UseGuards(CsrfGuard, AdminAccessGuard, AdminRolesGuard)
@AdminRoles(AdminRole.Owner, AdminRole.Staff)
export class PromotionController {
  constructor(private readonly promotions: PromotionService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'List coupon campaigns and usage counters' })
  list(@Query() query: CouponListQueryDto): Promise<CouponPage> {
    return this.promotions.list(query);
  }

  @Get(':couponId')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Get one coupon campaign' })
  async get(@Param('couponId') couponId: string): Promise<{ coupon: CouponView }> {
    return { coupon: await this.promotions.get(couponId) };
  }

  @Post()
  @Header('Cache-Control', 'no-store')
  @AdminRoles(AdminRole.Owner)
  @ApiOperation({ summary: 'Create a draft coupon campaign' })
  async create(
    @Body() input: CreateCouponDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Req() request: Request,
  ): Promise<{ coupon: CouponView }> {
    return {
      coupon: await this.promotions.create(input, admin, getAuthRequestContext(request)),
    };
  }

  @Patch(':couponId')
  @Header('Cache-Control', 'no-store')
  @AdminRoles(AdminRole.Owner)
  @ApiOperation({ summary: 'Update, activate, pause, or archive a coupon campaign' })
  async update(
    @Param('couponId') couponId: string,
    @Body() input: UpdateCouponDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Req() request: Request,
  ): Promise<{ coupon: CouponView }> {
    return {
      coupon: await this.promotions.update(couponId, input, admin, getAuthRequestContext(request)),
    };
  }
}
