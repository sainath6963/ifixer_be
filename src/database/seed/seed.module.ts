import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { validateEnvironment } from '../../config/environment';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { CorePersistenceModule } from '../core-persistence.module';
import { SeedService } from './seed.service';

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
  providers: [SeedService],
  exports: [SeedService],
})
export class SeedModule {}
