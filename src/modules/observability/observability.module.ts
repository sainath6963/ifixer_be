import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';

import { CorePersistenceModule } from '../../database/core-persistence.module';
import { QueueModule } from '../../infrastructure/queue/queue.module';
import { CHECKOUT_QUEUE } from '../checkout/checkout.constants';
import { NOTIFICATION_QUEUE } from '../notifications/notification.constants';
import { PAYMENT_QUEUE } from '../payments/payment.constants';
import { RETURN_QUEUE } from '../returns/return-queue.constants';
import { HttpMetricsInterceptor } from './http-metrics.interceptor';
import { MetricsAuthGuard } from './metrics-auth.guard';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';
import { OperationalMetricsService } from './operational-metrics.service';

@Global()
@Module({
  imports: [
    CorePersistenceModule,
    QueueModule,
    BullModule.registerQueue(
      { name: PAYMENT_QUEUE },
      { name: NOTIFICATION_QUEUE },
      { name: CHECKOUT_QUEUE },
      { name: RETURN_QUEUE },
    ),
  ],
  controllers: [MetricsController],
  providers: [
    MetricsService,
    MetricsAuthGuard,
    OperationalMetricsService,
    { provide: APP_INTERCEPTOR, useClass: HttpMetricsInterceptor },
  ],
  exports: [MetricsService],
})
export class ObservabilityModule {}
