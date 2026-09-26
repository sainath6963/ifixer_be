import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';

import { CorePersistenceModule } from '../../database/core-persistence.module';
import { QueueModule } from '../../infrastructure/queue/queue.module';
import { CustomerModule } from '../customer/customer.module';
import { PromotionModule } from '../promotions/promotion.module';
import { CheckoutQueueScheduler } from './checkout-queue.scheduler';
import { CheckoutController, CustomerOrderController } from './checkout.controller';
import { CHECKOUT_QUEUE } from './checkout.constants';
import { CheckoutProcessor } from './checkout.processor';
import { CheckoutService } from './checkout.service';

@Module({
  imports: [
    CorePersistenceModule,
    CustomerModule,
    PromotionModule,
    QueueModule,
    BullModule.registerQueue({ name: CHECKOUT_QUEUE }),
  ],
  controllers: [CheckoutController, CustomerOrderController],
  providers: [CheckoutService, CheckoutQueueScheduler, CheckoutProcessor],
  exports: [CheckoutService],
})
export class CheckoutModule {}
