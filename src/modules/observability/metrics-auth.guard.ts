import {
  CanActivate,
  ExecutionContext,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { timingSafeEqual } from 'node:crypto';

@Injectable()
export class MetricsAuthGuard implements CanActivate {
  private readonly enabled: boolean;
  private readonly expectedToken: string;

  constructor(config: ConfigService) {
    this.enabled = config.getOrThrow<boolean>('METRICS_ENABLED');
    this.expectedToken = config.getOrThrow<string>('METRICS_BEARER_TOKEN');
  }

  canActivate(context: ExecutionContext): boolean {
    if (!this.enabled) throw new NotFoundException();
    const authorization = context.switchToHttp().getRequest<Request>().headers.authorization;
    const suppliedToken = authorization?.startsWith('Bearer ')
      ? authorization.slice('Bearer '.length)
      : '';
    const supplied = Buffer.from(suppliedToken);
    const expected = Buffer.from(this.expectedToken);
    if (
      !supplied.length ||
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    ) {
      throw new UnauthorizedException({
        code: 'METRICS_UNAUTHORIZED',
        message: 'Metrics authentication is required',
      });
    }
    return true;
  }
}
