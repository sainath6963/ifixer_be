import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, OnModuleInit } from '@nestjs/common';
import type { Queue } from 'bullmq';

import {
  CHECKOUT_EXPIRY_SWEEP_MS,
  CHECKOUT_QUEUE,
  EXPIRE_PENDING_ORDERS_JOB,
  EXPIRE_PENDING_ORDERS_SCHEDULER,
} from './checkout.constants';

@Injectable()
export class CheckoutQueueScheduler implements OnModuleInit {
  constructor(@InjectQueue(CHECKOUT_QUEUE) private readonly queue: Queue) {}

  async onModuleInit(): Promise<void> {
    await this.queue.upsertJobScheduler(
      EXPIRE_PENDING_ORDERS_SCHEDULER,
      { every: CHECKOUT_EXPIRY_SWEEP_MS },
      {
        name: EXPIRE_PENDING_ORDERS_JOB,
        data: {},
        opts: { removeOnComplete: 100, removeOnFail: 1000 },
      },
    );
  }
}
