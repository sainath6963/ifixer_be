import { Injectable } from '@nestjs/common';
import { HealthCheckResult, HealthCheckService, HealthIndicatorResult } from '@nestjs/terminus';

import { MediaHealthIndicator } from './media.health';
import { MongoHealthIndicator } from './mongo.health';
import { RedisHealthIndicator } from './redis.health';

@Injectable()
export class ReadinessService {
  constructor(
    private readonly health: HealthCheckService,
    private readonly mongo: MongoHealthIndicator,
    private readonly redis: RedisHealthIndicator,
    private readonly media: MediaHealthIndicator,
  ) {}

  check(): Promise<HealthCheckResult> {
    return this.health.check([
      (): Promise<HealthIndicatorResult> => this.mongo.isHealthy('mongodb'),
      (): Promise<HealthIndicatorResult> => this.redis.isHealthy('redis'),
      (): Promise<HealthIndicatorResult> => this.media.isHealthy('mediaStorage'),
    ]);
  }
}
