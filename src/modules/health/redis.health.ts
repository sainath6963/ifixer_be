import { Injectable } from '@nestjs/common';
import { HealthIndicatorResult, HealthIndicatorService } from '@nestjs/terminus';

import { getErrorMessage } from '../../common/errors/error-message';
import { RedisService } from '../../infrastructure/redis/redis.service';

@Injectable()
export class RedisHealthIndicator {
  constructor(
    private readonly redis: RedisService,
    private readonly healthIndicatorService: HealthIndicatorService,
  ) {}

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    const indicator = this.healthIndicatorService.check(key);

    try {
      const response = await this.redis.ping();
      return response === 'PONG'
        ? indicator.up()
        : indicator.down({ reason: `Unexpected Redis response: ${response}` });
    } catch (error: unknown) {
      return indicator.down({ reason: getErrorMessage(error) });
    }
  }
}
