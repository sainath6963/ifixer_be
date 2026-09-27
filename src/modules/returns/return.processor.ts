import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';

import {
  EXCHANGE_RESERVATION_BATCH_SIZE,
  EXPIRE_EXCHANGE_RESERVATIONS_JOB,
  RETURN_QUEUE,
} from './return-queue.constants';
import { ReturnRequestService } from './return-request.service';
import { MetricsService } from '../observability/metrics.service';

@Processor(RETURN_QUEUE, { concurrency: 1 })
export class ReturnProcessor extends WorkerHost {
  private readonly logger = new Logger(ReturnProcessor.name);

  constructor(
    private readonly returns: ReturnRequestService,
    private readonly metrics: MetricsService,
  ) {
    super();
  }

  async process(job: Job): Promise<{ expired: number }> {
    if (job.name !== EXPIRE_EXCHANGE_RESERVATIONS_JOB) {
      throw new Error(`Unsupported return-maintenance job: ${job.name}`);
    }
    return this.metrics.trackJob(RETURN_QUEUE, EXPIRE_EXCHANGE_RESERVATIONS_JOB, async () => {
      const expired = await this.returns.expireExchangeReservations(
        EXCHANGE_RESERVATION_BATCH_SIZE,
      );
      this.metrics.incrementCounter(
        'ifixer_exchange_reservations_expired_total',
        'Exchange reservations expired by maintenance',
        {},
        expired,
      );
      if (expired > 0) this.logger.log(`Expired ${expired} exchange reservation(s)`);
      return { expired };
    });
  }
}
