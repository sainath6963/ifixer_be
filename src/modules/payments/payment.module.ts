import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';

import { CorePersistenceModule } from '../../database/core-persistence.module';
import { QueueModule } from '../../infrastructure/queue/queue.module';
import { AdminAuthModule } from '../admin-auth/admin-auth.module';
import { CheckoutModule } from '../checkout/checkout.module';
import { CustomerModule } from '../customer/customer.module';
import { PromotionModule } from '../promotions/promotion.module';
import { CustomerPaymentController, RazorpayWebhookController } from './payment.controller';
import { PAYMENT_QUEUE, RAZORPAY_GATEWAY } from './payment.constants';
import { PaymentQueueScheduler } from './payment-queue.scheduler';
import { PaymentProcessor } from './payment.processor';
import { PaymentService } from './payment.service';
import { RazorpayGatewayService } from './razorpay-gateway.service';
import { RazorpayWebhookService } from './razorpay-webhook.service';
import { RefundService } from './refund.service';

@Module({
  imports: [
    CorePersistenceModule,
    CustomerModule,
    CheckoutModule,
    AdminAuthModule,
    PromotionModule,
    QueueModule,
    BullModule.registerQueue({ name: PAYMENT_QUEUE }),
  ],
  controllers: [CustomerPaymentController, RazorpayWebhookController],
  providers: [
    RazorpayGatewayService,
    { provide: RAZORPAY_GATEWAY, useExisting: RazorpayGatewayService },
    PaymentService,
    RefundService,
    RazorpayWebhookService,
    PaymentQueueScheduler,
    PaymentProcessor,
  ],
  exports: [PaymentService, RefundService, RAZORPAY_GATEWAY],
})
export class PaymentModule {}
