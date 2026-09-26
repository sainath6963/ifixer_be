import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { validateEnvironment } from '../../config/environment';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { PasswordService } from '../../modules/admin-auth/password.service';
import { CorePersistenceModule } from '../core-persistence.module';
import { AdminBootstrapService } from './admin-bootstrap.service';

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
  providers: [AdminBootstrapService, PasswordService],
})
export class AdminBootstrapModule {}
