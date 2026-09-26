import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';

import { CHECKOUT_QUEUE, EXPIRE_PENDING_ORDERS_JOB } from './checkout.constants';
import { CheckoutService } from './checkout.service';
import { MetricsService } from '../observability/metrics.service';

@Processor(CHECKOUT_QUEUE, { concurrency: 1 })
export class CheckoutProcessor extends WorkerHost {
  private readonly logger = new Logger(CheckoutProcessor.name);

  constructor(
    private readonly checkout: CheckoutService,
    private readonly metrics: MetricsService,
  ) {
    super();
  }

  async process(job: Job): Promise<{ expired: number }> {
    if (job.name !== EXPIRE_PENDING_ORDERS_JOB) {
      throw new Error(`Unsupported checkout job: ${job.name}`);
    }
    return this.metrics.trackJob(CHECKOUT_QUEUE, EXPIRE_PENDING_ORDERS_JOB, async () => {
      const expired = await this.checkout.expirePendingOrders();
      this.metrics.incrementCounter(
        'rich_culture_checkout_expired_orders_total',
        'Pending checkout orders expired by maintenance',
        {},
        expired,
      );
      if (expired > 0) this.logger.log(`Expired ${expired} pending checkout order(s)`);
      return { expired };
    });
  }
}
