import { Module } from '@nestjs/common';

import { CorePersistenceModule } from '../../database/core-persistence.module';
import { AdminAuthModule } from '../admin-auth/admin-auth.module';
import { CategoryController } from './category.controller';
import { CategoryService } from './category.service';
import { LocalMediaService } from './local-media.service';
import { AdminMediaController, MediaDeliveryController } from './media.controller';
import { ProductController } from './product.controller';
import { ProductService } from './product.service';

@Module({
  imports: [CorePersistenceModule, AdminAuthModule],
  controllers: [
    CategoryController,
    ProductController,
    AdminMediaController,
    MediaDeliveryController,
  ],
  providers: [CategoryService, ProductService, LocalMediaService],
})
export class AdminCatalogModule {}
