import { Module } from '@nestjs/common';

import { CorePersistenceModule } from '../../database/core-persistence.module';
import { AdminAuthModule } from '../admin-auth/admin-auth.module';
import { AdminCustomerController } from './admin-customer.controller';
import { AdminCustomerService } from './admin-customer.service';

@Module({
  imports: [CorePersistenceModule, AdminAuthModule],
  controllers: [AdminCustomerController],
  providers: [AdminCustomerService],
})
export class AdminCustomersModule {}
