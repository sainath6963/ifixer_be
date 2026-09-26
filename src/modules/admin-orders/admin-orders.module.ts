import { Module } from '@nestjs/common';

import { CorePersistenceModule } from '../../database/core-persistence.module';
import { AdminAuthModule } from '../admin-auth/admin-auth.module';
import { PaymentModule } from '../payments/payment.module';
import { AdminOrderController } from './admin-order.controller';
import { AdminOrderService } from './admin-order.service';
import { AdminShipmentService } from './admin-shipment.service';

@Module({
  imports: [CorePersistenceModule, AdminAuthModule, PaymentModule],
  controllers: [AdminOrderController],
  providers: [AdminOrderService, AdminShipmentService],
})
export class AdminOrdersModule {}
