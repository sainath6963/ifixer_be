import { Module } from '@nestjs/common';
import { CorePersistenceModule } from '../../database/core-persistence.module';
import { AdminAuthModule } from '../admin-auth/admin-auth.module';
import { AdminRepairCatalogController, RepairCatalogController } from './repair-catalog.controller';
import { RepairCatalogService } from './repair-catalog.service';
@Module({
  imports: [CorePersistenceModule, AdminAuthModule],
  controllers: [RepairCatalogController, AdminRepairCatalogController],
  providers: [RepairCatalogService],
  exports: [RepairCatalogService],
})
export class RepairCatalogModule {}
