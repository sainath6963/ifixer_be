import { Module } from '@nestjs/common';

import { CorePersistenceModule } from '../../database/core-persistence.module';
import { StorefrontCatalogController } from './storefront-catalog.controller';
import { StorefrontCatalogService } from './storefront-catalog.service';

@Module({
  imports: [CorePersistenceModule],
  controllers: [StorefrontCatalogController],
  providers: [StorefrontCatalogService],
  exports: [StorefrontCatalogService],
})
export class StorefrontCatalogModule {}
