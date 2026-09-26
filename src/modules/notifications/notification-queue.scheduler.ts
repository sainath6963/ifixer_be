import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, OnModuleInit } from '@nestjs/common';
import type { Queue } from 'bullmq';

import {
  NOTIFICATION_QUEUE,
  NOTIFICATION_SWEEP_MS,
  PROCESS_NOTIFICATIONS_JOB,
  PROCESS_NOTIFICATIONS_SCHEDULER,
} from './notification.constants';

@Injectable()
export class NotificationQueueScheduler implements OnModuleInit {
  constructor(@InjectQueue(NOTIFICATION_QUEUE) private readonly queue: Queue) {}

  async onModuleInit(): Promise<void> {
    await this.queue.upsertJobScheduler(
      PROCESS_NOTIFICATIONS_SCHEDULER,
      { every: NOTIFICATION_SWEEP_MS },
      {
        name: PROCESS_NOTIFICATIONS_JOB,
        data: {},
        opts: { removeOnComplete: 100, removeOnFail: 1000 },
      },
    );
  }
}
