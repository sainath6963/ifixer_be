import { Body, Controller, Get, Header, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';

import { AdminRole } from '../../domain/enums';
import { AdminAccessGuard } from '../admin-auth/admin-access.guard';
import type { AuthenticatedAdmin } from '../admin-auth/auth.types';
import { CsrfGuard } from '../admin-auth/csrf.guard';
import { CurrentAdmin } from '../admin-auth/current-admin.decorator';
import { getAuthRequestContext } from '../admin-auth/http-context';
import { AdminRoles } from '../admin-auth/roles.decorator';
import { AdminRolesGuard } from '../admin-auth/roles.guard';
import { AdminAnalyticsQueryDto } from '../admin-analytics/dto/admin-analytics.dto';
import { SaveGoogleReviewSettingDto, WebsiteEventDto } from './website-insights.dto';
import { WebsiteInsightsService } from './website-insights.service';
import type { GoogleReviewSettingView, WebsiteInsightsOverview } from './website-insights.types';

@Controller('website')
export class PublicWebsiteInsightsController {
  constructor(private readonly insights: WebsiteInsightsService) {}

  @Post('page-view')
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  recordPageView(
    @Body() input: WebsiteEventDto,
    @Req() request: Request,
  ): Promise<{ recorded: boolean }> {
    const userAgent = request.headers['user-agent'];
    return this.insights.recordPageView(
      input,
      typeof userAgent === 'string' ? userAgent.slice(0, 500) : undefined,
    );
  }

  @Post('google-review-click')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  recordGoogleReviewClick(
    @Body() input: WebsiteEventDto,
    @Req() request: Request,
  ): Promise<{ recorded: boolean }> {
    const userAgent = request.headers['user-agent'];
    return this.insights.recordGoogleReviewClick(
      input,
      typeof userAgent === 'string' ? userAgent.slice(0, 500) : undefined,
    );
  }

  @Get('review-link')
  @Header('Cache-Control', 'public, max-age=60')
  reviewLink(): Promise<{ googleReviewUrl: string | null }> {
    return this.insights.publicReviewLink();
  }
}

@Controller('admin/website')
@UseGuards(CsrfGuard, AdminAccessGuard, AdminRolesGuard)
@AdminRoles(AdminRole.Owner, AdminRole.Staff)
export class AdminWebsiteInsightsController {
  constructor(private readonly insights: WebsiteInsightsService) {}

  @Get('insights')
  @Header('Cache-Control', 'private, no-store')
  overview(@Query() query: AdminAnalyticsQueryDto): Promise<WebsiteInsightsOverview> {
    return this.insights.overview(query);
  }

  @Get('review-settings')
  @Header('Cache-Control', 'private, no-store')
  reviewSettings(): Promise<GoogleReviewSettingView> {
    return this.insights.reviewSetting();
  }

  @Post('review-settings')
  @AdminRoles(AdminRole.Owner)
  saveReviewSettings(
    @Body() input: SaveGoogleReviewSettingDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Req() request: Request,
  ): Promise<GoogleReviewSettingView> {
    return this.insights.saveReviewSetting(input, admin, getAuthRequestContext(request));
  }
}
