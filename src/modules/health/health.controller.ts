import { Controller, Get, Header } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle, Throttle } from '@nestjs/throttler';

import { ReadinessService } from './readiness.service';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly readiness: ReadinessService) {}

  @Get('live')
  @Header('Cache-Control', 'no-store')
  @SkipThrottle()
  @ApiOperation({ summary: 'Process liveness probe' })
  live(): { status: 'ok'; uptimeSeconds: number; timestamp: string } {
    return {
      status: 'ok',
      uptimeSeconds: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    };
  }

  @Get('ready')
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'Sanitized dependency readiness probe' })
  async ready(): Promise<{ status: 'ok'; timestamp: string }> {
    await this.readiness.check();
    return { status: 'ok', timestamp: new Date().toISOString() };
  }
}
