import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';

import { AdminAuthModule } from '../admin-auth/admin-auth.module';
import { AdminHealthController } from './admin-health.controller';
import { HealthController } from './health.controller';
import { MediaHealthIndicator } from './media.health';
import { MongoHealthIndicator } from './mongo.health';
import { RedisHealthIndicator } from './redis.health';
import { ReadinessService } from './readiness.service';

@Module({
  imports: [TerminusModule, AdminAuthModule],
  controllers: [HealthController, AdminHealthController],
  providers: [MongoHealthIndicator, RedisHealthIndicator, MediaHealthIndicator, ReadinessService],
})
export class HealthModule {}
