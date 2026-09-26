import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';

import { CorePersistenceModule } from '../../database/core-persistence.module';
import { QueueModule } from '../../infrastructure/queue/queue.module';
import { AdminAuthModule } from '../admin-auth/admin-auth.module';
import { CustomerModule } from '../customer/customer.module';
import {
  AdminReturnRequestController,
  CustomerReturnRequestController,
} from './return-request.controller';
import {
  AdminReturnEvidenceController,
  CustomerReturnEvidenceController,
} from './return-evidence.controller';
import { ReturnEvidenceService } from './return-evidence.service';
import { RETURN_QUEUE } from './return-queue.constants';
import { ReturnQueueScheduler } from './return-queue.scheduler';
import { ReturnRequestService } from './return-request.service';
import { ReturnProcessor } from './return.processor';

@Module({
  imports: [
    CorePersistenceModule,
    AdminAuthModule,
    CustomerModule,
    QueueModule,
    BullModule.registerQueue({ name: RETURN_QUEUE }),
  ],
  controllers: [
    CustomerReturnRequestController,
    AdminReturnRequestController,
    CustomerReturnEvidenceController,
    AdminReturnEvidenceController,
  ],
  providers: [ReturnRequestService, ReturnEvidenceService, ReturnQueueScheduler, ReturnProcessor],
  exports: [ReturnRequestService],
})
export class ReturnRequestModule {}
