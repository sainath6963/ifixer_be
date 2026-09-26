import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, OnModuleInit } from '@nestjs/common';
import type { Queue } from 'bullmq';

import {
  EXCHANGE_RESERVATION_SWEEP_MS,
  EXPIRE_EXCHANGE_RESERVATIONS_JOB,
  EXPIRE_EXCHANGE_RESERVATIONS_SCHEDULER,
  RETURN_QUEUE,
} from './return-queue.constants';

@Injectable()
export class ReturnQueueScheduler implements OnModuleInit {
  constructor(@InjectQueue(RETURN_QUEUE) private readonly queue: Queue) {}

  async onModuleInit(): Promise<void> {
    await this.queue.upsertJobScheduler(
      EXPIRE_EXCHANGE_RESERVATIONS_SCHEDULER,
      { every: EXCHANGE_RESERVATION_SWEEP_MS },
      {
        name: EXPIRE_EXCHANGE_RESERVATIONS_JOB,
        data: {},
        opts: { removeOnComplete: 100, removeOnFail: 1000 },
      },
    );
  }
}
