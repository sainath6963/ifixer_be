import { Module } from '@nestjs/common';
import { CorePersistenceModule } from '../../database/core-persistence.module';
import { AdminAuthModule } from '../admin-auth/admin-auth.module';
import { RepairBillingController, RepairJobBillingController } from './repair-billing.controller';
import { RepairBillingService } from './repair-billing.service';
@Module({
  imports: [CorePersistenceModule, AdminAuthModule],
  controllers: [RepairBillingController, RepairJobBillingController],
  providers: [RepairBillingService],
  exports: [RepairBillingService],
})
export class RepairBillingModule {}
