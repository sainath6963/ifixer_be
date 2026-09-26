import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, QueryFilter, Types } from 'mongoose';

import { OutboxEvent, OutboxEventDocument } from '../../database/schemas/integration.schema';
import { Notification, NotificationDocument } from '../../database/schemas/notification.schema';
import { NotificationStatus, OutboxStatus } from '../../domain/enums';
import { AuthAuditService } from '../admin-auth/auth-audit.service';
import type { AuthenticatedAdmin, AuthRequestContext } from '../admin-auth/auth.types';
import type {
  AdminNotificationListQueryDto,
  AdminOutboxListQueryDto,
} from './dto/admin-notification.dto';
import type {
  NotificationOperationsSummary,
  NotificationPage,
  NotificationPageItem,
  OutboxPage,
  OutboxPageItem,
} from './notification.types';

@Injectable()
export class AdminNotificationService {
  constructor(
    @InjectModel(Notification.name) private readonly notifications: Model<Notification>,
    @InjectModel(OutboxEvent.name) private readonly outbox: Model<OutboxEvent>,
    private readonly audit: AuthAuditService,
  ) {}

  async list(query: AdminNotificationListQueryDto): Promise<NotificationPage> {
    const filter: QueryFilter<Notification> = {};
    if (query.status) filter.status = query.status;
    if (query.channel) filter.channel = query.channel;
    if (query.templateKey?.trim()) filter.templateKey = query.templateKey.trim();
    if (query.search?.trim()) {
      const pattern = new RegExp(this.escapeRegex(query.search.trim()), 'i');
      filter.$or = [{ recipient: pattern }, { sourceEventId: pattern }];
    }
    const skip = (query.page - 1) * query.limit;
    const [documents, total] = await Promise.all([
      this.notifications
        .find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip(skip)
        .limit(query.limit)
        .exec(),
      this.notifications.countDocuments(filter),
    ]);
    return {
      items: documents.map((notification) => this.toView(notification)),
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.ceil(total / query.limit),
    };
  }

  async summary(): Promise<NotificationOperationsSummary> {
    const [outboxGroups, notificationGroups] = await Promise.all([
      this.outbox.aggregate<{ _id: OutboxStatus; count: number }>([
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]),
      this.notifications.aggregate<{ _id: NotificationStatus; count: number }>([
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]),
    ]);
    const outbox: Record<OutboxStatus, number> = {
      [OutboxStatus.Pending]: 0,
      [OutboxStatus.Processing]: 0,
      [OutboxStatus.Published]: 0,
      [OutboxStatus.Failed]: 0,
      [OutboxStatus.Dead]: 0,
    };
    const notifications: Record<NotificationStatus, number> = {
      [NotificationStatus.Pending]: 0,
      [NotificationStatus.Processing]: 0,
      [NotificationStatus.Sent]: 0,
      [NotificationStatus.Failed]: 0,
      [NotificationStatus.Dead]: 0,
    };
    for (const group of outboxGroups) outbox[group._id] = group.count;
    for (const group of notificationGroups) notifications[group._id] = group.count;
    return { outbox, notifications };
  }

  async listOutbox(query: AdminOutboxListQueryDto): Promise<OutboxPage> {
    const filter: QueryFilter<OutboxEvent> = {};
    if (query.status) filter.status = query.status;
    if (query.search?.trim()) {
      const pattern = new RegExp(this.escapeRegex(query.search.trim()), 'i');
      filter.$or = [{ eventId: pattern }, { eventType: pattern }, { aggregateType: pattern }];
    }
    const skip = (query.page - 1) * query.limit;
    const [documents, total] = await Promise.all([
      this.outbox
        .find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip(skip)
        .limit(query.limit)
        .exec(),
      this.outbox.countDocuments(filter),
    ]);
    return {
      items: documents.map((event) => this.toOutboxView(event)),
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.ceil(total / query.limit),
    };
  }

  async retryNotification(
    id: string,
    admin: AuthenticatedAdmin,
    context: AuthRequestContext,
  ): Promise<{ notification: NotificationPageItem }> {
    if (!Types.ObjectId.isValid(id)) throw this.notificationNotFound();
    const existing = await this.notifications.findById(id).exec();
    if (!existing) throw this.notificationNotFound();
    if (![NotificationStatus.Failed, NotificationStatus.Dead].includes(existing.status)) {
      throw new ConflictException({
        code: 'NOTIFICATION_RETRY_NOT_ALLOWED',
        message: 'Only failed or dead notifications can be retried',
      });
    }
    const updated = await this.notifications.findOneAndUpdate(
      { _id: existing._id, status: existing.status },
      {
        $set: { status: NotificationStatus.Pending, attempts: 0, nextAttemptAt: new Date() },
        $unset: { lockedAt: 1, lockToken: 1, lastError: 1 },
      },
      { returnDocument: 'after' },
    );
    if (!updated) throw this.retryConflict();
    await this.audit.record({
      action: 'NOTIFICATION_RETRY_REQUESTED',
      resourceType: 'NOTIFICATION',
      resourceId: updated.id,
      actorId: admin.id,
      context,
      metadata: { previousStatus: existing.status, previousAttempts: existing.attempts },
    });
    return { notification: this.toView(updated) };
  }

  async retryOutbox(
    id: string,
    admin: AuthenticatedAdmin,
    context: AuthRequestContext,
  ): Promise<{ eventId: string; status: OutboxStatus }> {
    if (!Types.ObjectId.isValid(id)) throw this.outboxNotFound();
    const existing = await this.outbox.findById(id).exec();
    if (!existing) throw this.outboxNotFound();
    if (![OutboxStatus.Failed, OutboxStatus.Dead].includes(existing.status)) {
      throw new ConflictException({
        code: 'OUTBOX_RETRY_NOT_ALLOWED',
        message: 'Only failed or dead outbox events can be retried',
      });
    }
    const updated = await this.outbox.findOneAndUpdate(
      { _id: existing._id, status: existing.status },
      {
        $set: { status: OutboxStatus.Pending, processingAttempts: 0, availableAt: new Date() },
        $unset: { lockedAt: 1, lockToken: 1, lastError: 1 },
      },
      { returnDocument: 'after' },
    );
    if (!updated) throw this.retryConflict();
    await this.audit.record({
      action: 'OUTBOX_RETRY_REQUESTED',
      resourceType: 'OUTBOX_EVENT',
      resourceId: updated.id,
      actorId: admin.id,
      context,
      metadata: {
        eventId: updated.eventId,
        previousStatus: existing.status,
        previousAttempts: existing.processingAttempts,
      },
    });
    return { eventId: updated.eventId, status: updated.status };
  }

  private toView(notification: NotificationDocument): NotificationPageItem {
    return {
      id: notification.id,
      sourceEventId: notification.sourceEventId,
      channel: notification.channel,
      templateKey: notification.templateKey,
      recipient: notification.recipient,
      status: notification.status,
      attempts: notification.attempts,
      nextAttemptAt: notification.nextAttemptAt,
      providerMessageId: notification.providerMessageId,
      sentAt: notification.sentAt,
      lastError: notification.lastError,
      createdAt: notification.get('createdAt') as Date,
      updatedAt: notification.get('updatedAt') as Date,
    };
  }

  private toOutboxView(event: OutboxEventDocument): OutboxPageItem {
    return {
      id: event.id,
      eventId: event.eventId,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId.toHexString(),
      eventType: event.eventType,
      status: event.status,
      processingAttempts: event.processingAttempts,
      availableAt: event.availableAt,
      lockedAt: event.lockedAt,
      publishedAt: event.publishedAt,
      lastError: event.lastError,
      createdAt: event.get('createdAt') as Date,
      updatedAt: event.get('updatedAt') as Date,
    };
  }

  private escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private notificationNotFound(): NotFoundException {
    return new NotFoundException({
      code: 'NOTIFICATION_NOT_FOUND',
      message: 'Notification was not found',
    });
  }

  private outboxNotFound(): NotFoundException {
    return new NotFoundException({
      code: 'OUTBOX_EVENT_NOT_FOUND',
      message: 'Outbox event was not found',
    });
  }

  private retryConflict(): ConflictException {
    return new ConflictException({
      code: 'NOTIFICATION_RETRY_CONFLICT',
      message: 'Delivery state changed; reload and retry',
    });
  }
}
