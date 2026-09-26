import { Controller, Get, Header, Query, Res, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiProduces, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import { AdminRole } from '../../domain/enums';
import { AdminAccessGuard } from '../admin-auth/admin-access.guard';
import { ADMIN_ACCESS_SECURITY } from '../admin-auth/auth.constants';
import { CsrfGuard } from '../admin-auth/csrf.guard';
import { AdminRoles } from '../admin-auth/roles.decorator';
import { AdminRolesGuard } from '../admin-auth/roles.guard';
import { AdminAnalyticsService } from './admin-analytics.service';
import type { AdminAnalyticsOverview } from './admin-analytics.types';
import { AdminAnalyticsQueryDto } from './dto/admin-analytics.dto';

@ApiTags('admin-analytics')
@ApiCookieAuth(ADMIN_ACCESS_SECURITY)
@Controller('admin/analytics')
@UseGuards(CsrfGuard, AdminAccessGuard, AdminRolesGuard)
@AdminRoles(AdminRole.Owner, AdminRole.Staff)
export class AdminAnalyticsController {
  constructor(private readonly analytics: AdminAnalyticsService) {}

  @Get('export.csv')
  @ApiProduces('text/csv')
  @ApiOperation({ summary: 'Export period sales and customer trend as spreadsheet-safe CSV' })
  async exportCsv(
    @Query() query: AdminAnalyticsQueryDto,
    @Res() response: Response,
  ): Promise<void> {
    const report = await this.analytics.csv(query);
    response
      .status(200)
      .set({
        'Cache-Control': 'no-store',
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${report.filename}"`,
        'X-Content-Type-Options': 'nosniff',
      })
      .send(report.body);
  }

  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Get period KPIs, trends, top products, and low-stock signals' })
  overview(@Query() query: AdminAnalyticsQueryDto): Promise<AdminAnalyticsOverview> {
    return this.analytics.overview(query);
  }
}
