import { RepairBillingModule } from '../repair-billing/repair-billing.module';
import { RepairInventoryModule } from '../repair-inventory/repair-inventory.module';
import { Module } from '@nestjs/common';
import { CorePersistenceModule } from '../../database/core-persistence.module';
import { AdminAuthModule } from '../admin-auth/admin-auth.module';
import { RepairJobController, RepairTeamController } from './repair-job.controller';
import { RepairJobService } from './repair-job.service';
@Module({
  imports: [CorePersistenceModule, AdminAuthModule, RepairInventoryModule, RepairBillingModule],
  controllers: [RepairJobController, RepairTeamController],
  providers: [RepairJobService],
})
export class RepairJobModule {}
