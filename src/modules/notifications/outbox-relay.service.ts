import { Injectable, Logger } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { createHash, randomUUID } from 'node:crypto';
import { Connection, Model } from 'mongoose';

import { OutboxEvent, OutboxEventDocument } from '../../database/schemas/integration.schema';
import { Notification } from '../../database/schemas/notification.schema';
import { NotificationChannel, NotificationStatus, OutboxStatus } from '../../domain/enums';
import {
  NOTIFICATION_BATCH_SIZE,
  NOTIFICATION_LEASE_MS,
  NOTIFICATION_MAX_ATTEMPTS,
  NOTIFICATION_RETRY_BASE_MS,
} from './notification.constants';
import { NotificationTemplateService } from './notification-template.service';
import { MobileNotificationTemplateService } from './mobile-notification-template.service';

@Injectable()
export class OutboxRelayService {
  private readonly logger = new Logger(OutboxRelayService.name);

  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(OutboxEvent.name) private readonly outbox: Model<OutboxEvent>,
    @InjectModel(Notification.name) private readonly notifications: Model<Notification>,
    private readonly templates: NotificationTemplateService,
    private readonly mobileTemplates: MobileNotificationTemplateService,
  ) {}

  async processBatch(): Promise<{ processed: number; materialized: number; failed: number }> {
    let processed = 0;
    let materialized = 0;
    let failed = 0;
    for (let index = 0; index < NOTIFICATION_BATCH_SIZE; index += 1) {
      const event = await this.claim();
      if (!event) break;
      processed += 1;
      try {
        materialized += await this.materialize(event);
      } catch (error) {
        failed += 1;
        await this.fail(event, error);
      }
    }
    return { processed, materialized, failed };
  }

  private claim(): Promise<OutboxEventDocument | null> {
    const now = new Date();
    const leaseExpiredAt = new Date(now.getTime() - NOTIFICATION_LEASE_MS);
    return this.outbox
      .findOneAndUpdate(
        {
          $or: [
            {
              status: { $in: [OutboxStatus.Pending, OutboxStatus.Failed] },
              availableAt: { $lte: now },
            },
            { status: OutboxStatus.Processing, lockedAt: { $lt: leaseExpiredAt } },
          ],
        },
        {
          $set: {
            status: OutboxStatus.Processing,
            lockedAt: now,
            lockToken: randomUUID(),
          },
          $inc: { processingAttempts: 1 },
          $unset: { lastError: 1 },
        },
        { returnDocument: 'after', sort: { availableAt: 1, _id: 1 } },
      )
      .exec();
  }

  private async materialize(event: OutboxEventDocument): Promise<number> {
    const emails = await this.templates.render(event);
    const mobileMessages = await this.mobileTemplates.render(event);
    const deliveries = [
      ...emails.map((email) => ({ ...email, channel: NotificationChannel.Email })),
      ...mobileMessages,
    ];
    await this.connection.transaction(async (session): Promise<void> => {
      for (const delivery of deliveries) {
        const deliveryKey = this.deliveryKey(
          event.eventId,
          delivery.channel,
          delivery.templateKey,
          delivery.recipient,
        );
        await this.notifications.updateOne(
          { deliveryKey },
          {
            $setOnInsert: {
              outboxEventId: event._id,
              sourceEventId: event.eventId,
              channel: delivery.channel,
              templateKey: delivery.templateKey,
              recipient: delivery.recipient,
              deliveryKey,
              ...('subject' in delivery ? { subject: delivery.subject } : {}),
              textBody: delivery.text,
              ...('html' in delivery ? { htmlBody: delivery.html } : {}),
              status: NotificationStatus.Pending,
              attempts: 0,
              nextAttemptAt: new Date(),
            },
          },
          { upsert: true, session },
        );
      }
      const published = await this.outbox.updateOne(
        { _id: event._id, status: OutboxStatus.Processing, lockToken: event.lockToken },
        {
          $set: { status: OutboxStatus.Published, publishedAt: new Date() },
          $unset: { lockedAt: 1, lockToken: 1, lastError: 1 },
        },
        { session },
      );
      if (published.modifiedCount !== 1) throw new Error('Outbox processing lease was lost');
    });
    return deliveries.length;
  }

  private async fail(event: OutboxEventDocument, error: unknown): Promise<void> {
    const terminal = event.processingAttempts >= NOTIFICATION_MAX_ATTEMPTS;
    const status = terminal ? OutboxStatus.Dead : OutboxStatus.Failed;
    const availableAt = terminal
      ? event.availableAt
      : new Date(Date.now() + this.retryDelay(event.processingAttempts));
    await this.outbox.updateOne(
      { _id: event._id, status: OutboxStatus.Processing, lockToken: event.lockToken },
      {
        $set: { status, availableAt, lastError: this.errorMessage(error) },
        $unset: { lockedAt: 1, lockToken: 1 },
      },
    );
    if (terminal) this.logger.error(`Outbox event moved to dead status eventId=${event.eventId}`);
  }

  private deliveryKey(
    eventId: string,
    channel: NotificationChannel,
    templateKey: string,
    recipient: string,
  ): string {
    return createHash('sha256')
      .update(`${eventId}\u0000${channel}\u0000${templateKey}\u0000${recipient.toLowerCase()}`)
      .digest('hex');
  }

  private retryDelay(attempt: number): number {
    return Math.min(NOTIFICATION_RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1), 6 * 60 * 60_000);
  }

  private errorMessage(error: unknown): string {
    return (error instanceof Error ? error.message : 'Unknown outbox processing error')
      .replace(/[\r\n]+/g, ' ')
      .slice(0, 2000);
  }
}
