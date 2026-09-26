import { Module } from '@nestjs/common';
import { CorePersistenceModule } from '../../database/core-persistence.module';
import { AdminAuthModule } from '../admin-auth/admin-auth.module';
import { CustomerModule } from '../customer/customer.module';
import { OptionalCustomerGuard } from '../customer/optional-customer.guard';
import { RepairCatalogModule } from '../repair-catalog/repair-catalog.module';
import { AdminRepairBookingController, RepairBookingController } from './repair-booking.controller';
import { RepairBookingService } from './repair-booking.service';
@Module({
  imports: [CorePersistenceModule, AdminAuthModule, CustomerModule, RepairCatalogModule],
  controllers: [RepairBookingController, AdminRepairBookingController],
  providers: [RepairBookingService, OptionalCustomerGuard],
})
export class RepairBookingModule {}
