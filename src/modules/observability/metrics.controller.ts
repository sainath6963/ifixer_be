import { Controller, Get, Header, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';

import { MetricsAuthGuard } from './metrics-auth.guard';
import { MetricsService } from './metrics.service';
import { OperationalMetricsService } from './operational-metrics.service';

@ApiExcludeController()
@SkipThrottle()
@UseGuards(MetricsAuthGuard)
@Controller('metrics')
export class MetricsController {
  constructor(
    private readonly metrics: MetricsService,
    private readonly operational: OperationalMetricsService,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  async read(): Promise<string> {
    await this.operational.refresh();
    return this.metrics.render();
  }
}
