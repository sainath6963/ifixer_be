import { Module } from '@nestjs/common';

import { CorePersistenceModule } from '../../database/core-persistence.module';
import { AdminAuthModule } from '../admin-auth/admin-auth.module';
import {
  AdminWebsiteInsightsController,
  PublicWebsiteInsightsController,
} from './website-insights.controller';
import { WebsiteInsightsService } from './website-insights.service';

@Module({
  imports: [CorePersistenceModule, AdminAuthModule],
  controllers: [PublicWebsiteInsightsController, AdminWebsiteInsightsController],
  providers: [WebsiteInsightsService],
})
export class WebsiteInsightsModule {}
