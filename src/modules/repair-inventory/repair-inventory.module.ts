import { Module } from '@nestjs/common';
import { CorePersistenceModule } from '../../database/core-persistence.module';
import { AdminAuthModule } from '../admin-auth/admin-auth.module';
import { RepairInventoryController, RepairJobPartsController } from './repair-inventory.controller';
import { RepairInventoryService } from './repair-inventory.service';
@Module({
  imports: [CorePersistenceModule, AdminAuthModule],
  controllers: [RepairInventoryController, RepairJobPartsController],
  providers: [RepairInventoryService],
  exports: [RepairInventoryService],
})
export class RepairInventoryModule {}
