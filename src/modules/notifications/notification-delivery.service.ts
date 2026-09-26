import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import { Model } from 'mongoose';

import { Notification, NotificationDocument } from '../../database/schemas/notification.schema';
import { NotificationChannel, NotificationStatus } from '../../domain/enums';
import { EmailGatewayService } from './email-gateway.service';
import { MessageGatewayService } from './message-gateway.service';
import {
  NOTIFICATION_BATCH_SIZE,
  NOTIFICATION_LEASE_MS,
  NOTIFICATION_MAX_ATTEMPTS,
  NOTIFICATION_RETRY_BASE_MS,
} from './notification.constants';

@Injectable()
export class NotificationDeliveryService {
  private readonly logger = new Logger(NotificationDeliveryService.name);

  constructor(
    @InjectModel(Notification.name) private readonly notifications: Model<Notification>,
    private readonly email: EmailGatewayService,
    private readonly messages: MessageGatewayService,
  ) {}

  async processBatch(): Promise<{ processed: number; sent: number; failed: number }> {
    let processed = 0;
    let sent = 0;
    let failed = 0;
    for (let index = 0; index < NOTIFICATION_BATCH_SIZE; index += 1) {
      const notification = await this.claim();
      if (!notification) break;
      processed += 1;
      try {
        const result =
          notification.channel === NotificationChannel.Email
            ? await this.email.send({
                templateKey: notification.templateKey,
                recipient: notification.recipient,
                subject: notification.subject ?? '',
                text: notification.textBody,
                html: notification.htmlBody ?? '',
                deliveryKey: notification.deliveryKey,
              })
            : await this.messages.send({
                channel: notification.channel,
                templateKey: notification.templateKey,
                recipient: notification.recipient,
                text: notification.textBody,
                deliveryKey: notification.deliveryKey,
              });
        const updated = await this.notifications.updateOne(
          {
            _id: notification._id,
            status: NotificationStatus.Processing,
            lockToken: notification.lockToken,
          },
          {
            $set: {
              status: NotificationStatus.Sent,
              providerMessageId: result.messageId.slice(0, 500),
              sentAt: new Date(),
              ...(this.containsSensitiveContent(notification.templateKey)
                ? {
                    textBody: '[Sensitive one-time credential removed after delivery]',
                    ...(notification.htmlBody
                      ? {
                          htmlBody: '<p>Sensitive one-time credential removed after delivery.</p>',
                        }
                      : {}),
                  }
                : {}),
            },
            $unset: { lockedAt: 1, lockToken: 1, lastError: 1 },
          },
        );
        if (updated.modifiedCount === 1) sent += 1;
      } catch (error) {
        failed += 1;
        await this.fail(notification, error);
      }
    }
    return { processed, sent, failed };
  }

  private containsSensitiveContent(templateKey: string): boolean {
    return [
      'CUSTOMER_EMAIL_VERIFICATION_REQUESTED',
      'CUSTOMER_EMAIL_CHANGE_REQUESTED',
      'CUSTOMER_PASSWORD_RESET_REQUESTED',
      'CUSTOMER_MOBILE_OTP_REQUESTED',
    ].includes(templateKey);
  }

  private claim(): Promise<NotificationDocument | null> {
    const now = new Date();
    const leaseExpiredAt = new Date(now.getTime() - NOTIFICATION_LEASE_MS);
    return this.notifications
      .findOneAndUpdate(
        {
          $or: [
            {
              status: { $in: [NotificationStatus.Pending, NotificationStatus.Failed] },
              nextAttemptAt: { $lte: now },
            },
            { status: NotificationStatus.Processing, lockedAt: { $lt: leaseExpiredAt } },
          ],
        },
        {
          $set: {
            status: NotificationStatus.Processing,
            lockedAt: now,
            lockToken: randomUUID(),
          },
          $inc: { attempts: 1 },
          $unset: { lastError: 1 },
        },
        { returnDocument: 'after', sort: { nextAttemptAt: 1, _id: 1 } },
      )
      .exec();
  }

  private async fail(notification: NotificationDocument, error: unknown): Promise<void> {
    const terminal = notification.attempts >= NOTIFICATION_MAX_ATTEMPTS;
    const status = terminal ? NotificationStatus.Dead : NotificationStatus.Failed;
    const nextAttemptAt = terminal
      ? notification.nextAttemptAt
      : new Date(Date.now() + this.retryDelay(notification.attempts));
    await this.notifications.updateOne(
      {
        _id: notification._id,
        status: NotificationStatus.Processing,
        lockToken: notification.lockToken,
      },
      {
        $set: { status, nextAttemptAt, lastError: this.errorMessage(error) },
        $unset: { lockedAt: 1, lockToken: 1 },
      },
    );
    if (terminal) {
      this.logger.error(
        `Notification moved to dead status deliveryKey=${notification.deliveryKey}`,
      );
    }
  }

  private retryDelay(attempt: number): number {
    return Math.min(NOTIFICATION_RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1), 6 * 60 * 60_000);
  }

  private errorMessage(error: unknown): string {
    return (error instanceof Error ? error.message : 'Unknown notification delivery error')
      .replace(/[\r\n]+/g, ' ')
      .slice(0, 2000);
  }
}
