import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { validateEnvironment } from '../../config/environment';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { CorePersistenceModule } from '../core-persistence.module';
import { MediaMaintenanceService } from './media-maintenance.service';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      expandVariables: true,
      validate: validateEnvironment,
    }),
    DatabaseModule,
    CorePersistenceModule,
  ],
  providers: [MediaMaintenanceService],
})
export class MediaMaintenanceModule {}
