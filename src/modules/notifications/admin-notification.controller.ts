import { Controller, Get, Header, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import { AdminRole, OutboxStatus } from '../../domain/enums';
import { AdminAccessGuard } from '../admin-auth/admin-access.guard';
import { ADMIN_ACCESS_SECURITY } from '../admin-auth/auth.constants';
import type { AuthenticatedAdmin } from '../admin-auth/auth.types';
import { CsrfGuard } from '../admin-auth/csrf.guard';
import { CurrentAdmin } from '../admin-auth/current-admin.decorator';
import { getAuthRequestContext } from '../admin-auth/http-context';
import { AdminRoles } from '../admin-auth/roles.decorator';
import { AdminRolesGuard } from '../admin-auth/roles.guard';
import { AdminNotificationService } from './admin-notification.service';
import {
  AdminNotificationListQueryDto,
  AdminOutboxListQueryDto,
} from './dto/admin-notification.dto';
import type {
  NotificationOperationsSummary,
  NotificationPage,
  NotificationPageItem,
  OutboxPage,
} from './notification.types';

@ApiTags('admin-notifications')
@ApiCookieAuth(ADMIN_ACCESS_SECURITY)
@Controller('admin/notifications')
@UseGuards(CsrfGuard, AdminAccessGuard, AdminRolesGuard)
@AdminRoles(AdminRole.Owner, AdminRole.Staff)
export class AdminNotificationController {
  constructor(private readonly notifications: AdminNotificationService) {}

  @Get('operations-summary')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Get outbox and notification delivery counts' })
  summary(): Promise<NotificationOperationsSummary> {
    return this.notifications.summary();
  }

  @Get('outbox')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Search and filter outbox processing records without payloads' })
  listOutbox(@Query() query: AdminOutboxListQueryDto): Promise<OutboxPage> {
    return this.notifications.listOutbox(query);
  }

  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Search and filter email deliveries' })
  list(@Query() query: AdminNotificationListQueryDto): Promise<NotificationPage> {
    return this.notifications.list(query);
  }

  @Post('outbox/:outboxEventId/retry')
  @AdminRoles(AdminRole.Owner)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Retry a failed or dead outbox event' })
  retryOutbox(
    @Param('outboxEventId') outboxEventId: string,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Req() request: Request,
  ): Promise<{ eventId: string; status: OutboxStatus }> {
    return this.notifications.retryOutbox(outboxEventId, admin, getAuthRequestContext(request));
  }

  @Post(':notificationId/retry')
  @AdminRoles(AdminRole.Owner)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Retry a failed or dead notification' })
  retryNotification(
    @Param('notificationId') notificationId: string,
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Req() request: Request,
  ): Promise<{ notification: NotificationPageItem }> {
    return this.notifications.retryNotification(
      notificationId,
      admin,
      getAuthRequestContext(request),
    );
  }
}
