import { Module } from '@nestjs/common';

import { CorePersistenceModule } from '../../database/core-persistence.module';
import { AdminAuthModule } from '../admin-auth/admin-auth.module';
import { CustomerModule } from '../customer/customer.module';
import {
  AdminProductReviewController,
  CustomerProductReviewController,
  PublicProductReviewController,
} from './product-review.controller';
import { ProductReviewService } from './product-review.service';

@Module({
  imports: [CorePersistenceModule, AdminAuthModule, CustomerModule],
  controllers: [
    PublicProductReviewController,
    CustomerProductReviewController,
    AdminProductReviewController,
  ],
  providers: [ProductReviewService],
  exports: [ProductReviewService],
})
export class ProductReviewModule {}
