import {
  CallHandler,
  ExecutionContext,
  HttpException,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { Response } from 'express';
import { performance } from 'node:perf_hooks';
import { Observable } from 'rxjs';
import { finalize, tap } from 'rxjs/operators';

import { MetricsService } from './metrics.service';

@Injectable()
export class HttpMetricsInterceptor implements NestInterceptor {
  constructor(private readonly metrics: MetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const response = context.switchToHttp().getResponse<Response>();
    const startedAt = performance.now();
    let errorStatus: number | undefined;
    const labels = {
      method: context.switchToHttp().getRequest<{ method: string }>().method,
      controller: context.getClass().name.replace(/Controller$/, '') || 'Unknown',
      handler: context.getHandler().name || 'unknown',
    };
    return next.handle().pipe(
      tap({
        error: (error: unknown): void => {
          errorStatus = error instanceof HttpException ? error.getStatus() : 500;
        },
      }),
      finalize(() => {
        const status = String(errorStatus ?? response.statusCode);
        const completedLabels = { ...labels, status };
        this.metrics.incrementCounter(
          'rich_culture_http_requests_total',
          'Completed HTTP requests by bounded route and status',
          completedLabels,
        );
        this.metrics.observeHistogram(
          'rich_culture_http_request_duration_seconds',
          'HTTP request duration in seconds',
          completedLabels,
          (performance.now() - startedAt) / 1000,
        );
      }),
    );
  }
}
