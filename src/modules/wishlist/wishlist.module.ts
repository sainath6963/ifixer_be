import { Module } from '@nestjs/common';

import { CorePersistenceModule } from '../../database/core-persistence.module';
import { AdminAuthModule } from '../admin-auth/admin-auth.module';
import { CustomerModule } from '../customer/customer.module';
import { StorefrontCatalogModule } from '../storefront-catalog/storefront-catalog.module';
import { StockAlertDispatchService } from './stock-alert-dispatch.service';
import {
  AdminStockDemandController,
  CustomerStockAlertController,
  CustomerWishlistController,
} from './wishlist.controller';
import { WishlistService } from './wishlist.service';

@Module({
  imports: [CorePersistenceModule, AdminAuthModule, CustomerModule, StorefrontCatalogModule],
  controllers: [
    CustomerWishlistController,
    CustomerStockAlertController,
    AdminStockDemandController,
  ],
  providers: [WishlistService, StockAlertDispatchService],
  exports: [WishlistService, StockAlertDispatchService],
})
export class WishlistModule {}
