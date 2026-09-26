import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';

import { CorePersistenceModule } from '../../database/core-persistence.module';
import { AdminAuthModule } from '../admin-auth/admin-auth.module';
import { WishlistModule } from '../wishlist/wishlist.module';
import { AdminNotificationController } from './admin-notification.controller';
import { AdminNotificationService } from './admin-notification.service';
import { EmailGatewayService } from './email-gateway.service';
import { NotificationDeliveryService } from './notification-delivery.service';
import { MessageGatewayService } from './message-gateway.service';
import { MobileNotificationTemplateService } from './mobile-notification-template.service';
import { NOTIFICATION_QUEUE } from './notification.constants';
import { NotificationProcessor } from './notification.processor';
import { NotificationQueueScheduler } from './notification-queue.scheduler';
import { NotificationTemplateService } from './notification-template.service';
import { OutboxRelayService } from './outbox-relay.service';

@Module({
  imports: [
    CorePersistenceModule,
    AdminAuthModule,
    WishlistModule,
    BullModule.registerQueue({ name: NOTIFICATION_QUEUE }),
  ],
  controllers: [AdminNotificationController],
  providers: [
    AdminNotificationService,
    EmailGatewayService,
    MessageGatewayService,
    MobileNotificationTemplateService,
    NotificationDeliveryService,
    NotificationProcessor,
    NotificationQueueScheduler,
    NotificationTemplateService,
    OutboxRelayService,
  ],
})
export class NotificationModule {}
