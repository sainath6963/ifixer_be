import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, OnModuleInit } from '@nestjs/common';
import type { Queue } from 'bullmq';

import {
  PAYMENT_QUEUE,
  PAYMENT_RECONCILIATION_SWEEP_MS,
  RECONCILE_PAYMENTS_JOB,
  RECONCILE_PAYMENTS_SCHEDULER,
} from './payment.constants';

@Injectable()
export class PaymentQueueScheduler implements OnModuleInit {
  constructor(@InjectQueue(PAYMENT_QUEUE) private readonly queue: Queue) {}

  async onModuleInit(): Promise<void> {
    await this.queue.upsertJobScheduler(
      RECONCILE_PAYMENTS_SCHEDULER,
      { every: PAYMENT_RECONCILIATION_SWEEP_MS },
      {
        name: RECONCILE_PAYMENTS_JOB,
        data: {},
        opts: { removeOnComplete: 100, removeOnFail: 1000 },
      },
    );
  }
}
