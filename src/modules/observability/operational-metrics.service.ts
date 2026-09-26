import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import type { Queue } from 'bullmq';
import { statfs } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { Model } from 'mongoose';

import { OutboxEvent } from '../../database/schemas/integration.schema';
import { Notification } from '../../database/schemas/notification.schema';
import { Order } from '../../database/schemas/order.schema';
import { PaymentAttempt, Refund } from '../../database/schemas/payment.schema';
import { ReturnRequest } from '../../database/schemas/return-request.schema';
import {
  ExchangeReservationStatus,
  NotificationChannel,
  NotificationStatus,
  OutboxStatus,
  PaymentAttemptStatus,
  RefundStatus,
  ReturnRequestStatus,
  ReturnRequestType,
  ShipmentStatus,
} from '../../domain/enums';
import { CHECKOUT_QUEUE } from '../checkout/checkout.constants';
import { NOTIFICATION_QUEUE } from '../notifications/notification.constants';
import { PAYMENT_QUEUE } from '../payments/payment.constants';
import { RETURN_QUEUE } from '../returns/return-queue.constants';
import { MetricsService } from './metrics.service';

interface GroupCount<T> {
  _id: T;
  count: number;
}

interface NotificationGroup {
  status: NotificationStatus;
  channel: NotificationChannel;
}

@Injectable()
export class OperationalMetricsService {
  private readonly mediaRoot: string;

  constructor(
    @InjectModel(Notification.name) private readonly notifications: Model<Notification>,
    @InjectModel(OutboxEvent.name) private readonly outbox: Model<OutboxEvent>,
    @InjectModel(PaymentAttempt.name) private readonly paymentAttempts: Model<PaymentAttempt>,
    @InjectModel(Refund.name) private readonly refunds: Model<Refund>,
    @InjectModel(Order.name) private readonly orders: Model<Order>,
    @InjectModel(ReturnRequest.name) private readonly returns: Model<ReturnRequest>,
    @InjectQueue(PAYMENT_QUEUE) private readonly paymentQueue: Queue,
    @InjectQueue(NOTIFICATION_QUEUE) private readonly notificationQueue: Queue,
    @InjectQueue(CHECKOUT_QUEUE) private readonly checkoutQueue: Queue,
    @InjectQueue(RETURN_QUEUE) private readonly returnQueue: Queue,
    private readonly metrics: MetricsService,
    config: ConfigService,
  ) {
    const configuredRoot = config.getOrThrow<string>('MEDIA_STORAGE_ROOT');
    this.mediaRoot = isAbsolute(configuredRoot)
      ? configuredRoot
      : resolve(process.cwd(), configuredRoot);
  }

  async refresh(): Promise<void> {
    this.refreshProcess();
    await Promise.all([
      this.safely('database', () => this.refreshDatabase()),
      this.safely('queues', () => this.refreshQueues()),
      this.safely('media_storage', () => this.refreshMediaStorage()),
    ]);
    this.metrics.replaceGauge(
      'rich_culture_metrics_last_scrape_timestamp_seconds',
      'Unix timestamp of the latest metrics collection attempt',
      [{ labels: {}, value: Date.now() / 1000 }],
    );
  }

  private refreshProcess(): void {
    const memory = process.memoryUsage();
    this.metrics.replaceGauge(
      'rich_culture_process_uptime_seconds',
      'Application process uptime in seconds',
      [{ labels: {}, value: process.uptime() }],
    );
    this.metrics.replaceGauge(
      'rich_culture_process_resident_memory_bytes',
      'Application resident memory in bytes',
      [{ labels: {}, value: memory.rss }],
    );
    this.metrics.replaceGauge(
      'rich_culture_process_heap_used_bytes',
      'Application heap memory in use in bytes',
      [{ labels: {}, value: memory.heapUsed }],
    );
  }

  private async refreshDatabase(): Promise<void> {
    const [
      notificationGroups,
      outboxGroups,
      paymentGroups,
      refundGroups,
      deliveryExceptions,
      overdueExchanges,
    ] = await Promise.all([
      this.notifications.aggregate<GroupCount<NotificationGroup>>([
        { $group: { _id: { status: '$status', channel: '$channel' }, count: { $sum: 1 } } },
      ]),
      this.outbox.aggregate<GroupCount<OutboxStatus>>([
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]),
      this.paymentAttempts.aggregate<GroupCount<PaymentAttemptStatus>>([
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]),
      this.refunds.aggregate<GroupCount<RefundStatus>>([
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]),
      this.orders.countDocuments({ 'shipping.status': ShipmentStatus.DeliveryException }),
      this.returns.countDocuments({
        type: ReturnRequestType.Exchange,
        status: ReturnRequestStatus.Approved,
        exchangeReservationStatus: ExchangeReservationStatus.Active,
        exchangeReservationExpiresAt: { $lte: new Date() },
      }),
    ]);

    const notificationCounts = new Map(
      notificationGroups.map((group) => [`${group._id.channel}:${group._id.status}`, group.count]),
    );
    this.metrics.replaceGauge(
      'rich_culture_notification_records',
      'Durable notification records by channel and status',
      Object.values(NotificationChannel).flatMap((channel) =>
        Object.values(NotificationStatus).map((status) => ({
          labels: { channel, status },
          value: notificationCounts.get(`${channel}:${status}`) ?? 0,
        })),
      ),
    );
    this.replaceGroupedGauge(
      'rich_culture_outbox_events',
      'Transactional outbox events by status',
      Object.values(OutboxStatus),
      outboxGroups,
    );
    this.replaceGroupedGauge(
      'rich_culture_payment_attempts',
      'Payment attempts by status',
      Object.values(PaymentAttemptStatus),
      paymentGroups,
    );
    this.replaceGroupedGauge(
      'rich_culture_refunds',
      'Refund records by status',
      Object.values(RefundStatus),
      refundGroups,
    );
    this.metrics.replaceGauge(
      'rich_culture_delivery_exceptions',
      'Orders currently in a shipment delivery exception',
      [{ labels: {}, value: deliveryExceptions }],
    );
    this.metrics.replaceGauge(
      'rich_culture_overdue_exchange_reservations',
      'Approved exchange reservations past their expiry time',
      [{ labels: {}, value: overdueExchanges }],
    );
  }

  private async refreshQueues(): Promise<void> {
    const queues = [
      { name: PAYMENT_QUEUE, queue: this.paymentQueue },
      { name: NOTIFICATION_QUEUE, queue: this.notificationQueue },
      { name: CHECKOUT_QUEUE, queue: this.checkoutQueue },
      { name: RETURN_QUEUE, queue: this.returnQueue },
    ];
    const samples = await Promise.all(
      queues.map(async ({ name, queue }) => {
        const counts = await queue.getJobCounts('waiting', 'active', 'delayed', 'failed');
        return (['waiting', 'active', 'delayed', 'failed'] as const).map((state) => ({
          labels: { queue: name, state },
          value: counts[state],
        }));
      }),
    );
    this.metrics.replaceGauge(
      'rich_culture_queue_jobs',
      'BullMQ jobs by queue and state',
      samples.flat(),
    );
  }

  private async refreshMediaStorage(): Promise<void> {
    const filesystem = await statfs(this.mediaRoot);
    this.metrics.replaceGauge(
      'rich_culture_media_storage_free_bytes',
      'Free bytes on the media-storage filesystem',
      [{ labels: {}, value: filesystem.bavail * filesystem.bsize }],
    );
  }

  private replaceGroupedGauge<T extends string>(
    name: string,
    help: string,
    states: T[],
    groups: Array<GroupCount<T>>,
  ): void {
    const counts = new Map(groups.map((group) => [group._id, group.count]));
    this.metrics.replaceGauge(
      name,
      help,
      states.map((status) => ({ labels: { status }, value: counts.get(status) ?? 0 })),
    );
  }

  private async safely(source: string, operation: () => Promise<void>): Promise<void> {
    try {
      await operation();
    } catch {
      this.metrics.incrementCounter(
        'rich_culture_metrics_collection_errors_total',
        'Metrics collection failures by bounded source',
        { source },
      );
    }
  }
}
