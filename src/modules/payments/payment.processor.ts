import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';

import { PAYMENT_QUEUE, RECONCILE_PAYMENTS_JOB } from './payment.constants';
import { PaymentService, PaymentReconciliationResult } from './payment.service';
import { RefundService } from './refund.service';
import type { RefundReconciliationResult } from './refund.types';
import { MetricsService } from '../observability/metrics.service';

interface PaymentMaintenanceResult {
  payments: PaymentReconciliationResult;
  refunds: RefundReconciliationResult;
}

@Processor(PAYMENT_QUEUE, { concurrency: 1 })
export class PaymentProcessor extends WorkerHost {
  private readonly logger = new Logger(PaymentProcessor.name);

  constructor(
    private readonly payments: PaymentService,
    private readonly refunds: RefundService,
    private readonly metrics: MetricsService,
  ) {
    super();
  }

  async process(job: Job): Promise<PaymentMaintenanceResult> {
    if (job.name !== RECONCILE_PAYMENTS_JOB) {
      throw new Error(`Unsupported payment job: ${job.name}`);
    }
    return this.metrics.trackJob(PAYMENT_QUEUE, RECONCILE_PAYMENTS_JOB, async () => {
      const [payments, refunds] = await Promise.all([
        this.payments.reconcilePending(),
        this.refunds.reconcilePending(),
      ]);
      this.recordOutcome('payment', 'checked', payments.checked);
      this.recordOutcome('payment', 'captured', payments.captured);
      this.recordOutcome('payment', 'failed', payments.failed);
      this.recordOutcome('refund', 'checked', refunds.checked);
      this.recordOutcome('refund', 'succeeded', refunds.succeeded);
      this.recordOutcome('refund', 'failed', refunds.failed);
      if (
        payments.captured > 0 ||
        payments.failed > 0 ||
        refunds.succeeded > 0 ||
        refunds.failed > 0
      ) {
        this.logger.log(
          `Payment reconciliation paymentsChecked=${payments.checked} captured=${payments.captured} paymentFailures=${payments.failed} refundsChecked=${refunds.checked} refunded=${refunds.succeeded} refundFailures=${refunds.failed}`,
        );
      }
      return { payments, refunds };
    });
  }

  private recordOutcome(entity: string, outcome: string, count: number): void {
    this.metrics.incrementCounter(
      'rich_culture_payment_reconciliation_records_total',
      'Payment and refund records handled by reconciliation outcome',
      { entity, outcome },
      count,
    );
  }
}
