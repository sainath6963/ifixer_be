import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';

import { NotificationDeliveryService } from './notification-delivery.service';
import { NOTIFICATION_QUEUE, PROCESS_NOTIFICATIONS_JOB } from './notification.constants';
import { OutboxRelayService } from './outbox-relay.service';
import { StockAlertDispatchService } from '../wishlist/stock-alert-dispatch.service';
import { MetricsService } from '../observability/metrics.service';

@Processor(NOTIFICATION_QUEUE, { concurrency: 1 })
export class NotificationProcessor extends WorkerHost {
  private readonly logger = new Logger(NotificationProcessor.name);

  constructor(
    private readonly outbox: OutboxRelayService,
    private readonly notifications: NotificationDeliveryService,
    private readonly stockAlerts: StockAlertDispatchService,
    private readonly metrics: MetricsService,
  ) {
    super();
  }

  async process(job: Job): Promise<Record<string, unknown>> {
    if (job.name !== PROCESS_NOTIFICATIONS_JOB) {
      throw new Error(`Unsupported notification job: ${job.name}`);
    }
    return this.metrics.trackJob(NOTIFICATION_QUEUE, PROCESS_NOTIFICATIONS_JOB, async () => {
      const stockAlerts = await this.stockAlerts.processBatch();
      const outbox = await this.outbox.processBatch();
      const notifications = await this.notifications.processBatch();
      const outcomes = {
        stock_alerts_dispatched: stockAlerts.dispatched,
        outbox_materialized: outbox.materialized,
        outbox_failed: outbox.failed,
        delivery_sent: notifications.sent,
        delivery_failed: notifications.failed,
      };
      for (const [outcome, count] of Object.entries(outcomes)) {
        this.metrics.incrementCounter(
          'ifixer_notification_sweep_records_total',
          'Records handled by the notification sweep outcome',
          { outcome },
          count,
        );
      }
      if (stockAlerts.dispatched > 0 || outbox.processed > 0 || notifications.processed > 0) {
        this.logger.log(
          `Notification sweep stockAlertsDispatched=${stockAlerts.dispatched} outboxProcessed=${outbox.processed} materialized=${outbox.materialized} outboxFailures=${outbox.failed} deliveryProcessed=${notifications.processed} sent=${notifications.sent} deliveryFailures=${notifications.failed}`,
        );
      }
      return { stockAlerts, outbox, notifications };
    });
  }
}
