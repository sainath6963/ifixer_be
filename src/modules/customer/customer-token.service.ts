import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { Types } from 'mongoose';

import { CUSTOMER_JWT_AUDIENCE, CUSTOMER_JWT_ISSUER } from './customer.constants';
import type { IssuedCustomerTokens, VerifiedCustomerToken } from './customer.types';

type CustomerTokenKind = 'access' | 'refresh';

@Injectable()
export class CustomerTokenService {
  private readonly accessSecret: string;
  private readonly refreshSecret: string;
  private readonly tokenPepper: string;
  private readonly accessTtlSeconds: number;
  private readonly refreshTtlSeconds: number;

  constructor(
    private readonly jwt: JwtService,
    config: ConfigService,
  ) {
    this.accessSecret = config.getOrThrow<string>('CUSTOMER_JWT_ACCESS_SECRET');
    this.refreshSecret = config.getOrThrow<string>('CUSTOMER_JWT_REFRESH_SECRET');
    this.tokenPepper = config.getOrThrow<string>('CUSTOMER_TOKEN_PEPPER');
    this.accessTtlSeconds = config.getOrThrow<number>('JWT_ACCESS_TTL_SECONDS');
    this.refreshTtlSeconds = config.getOrThrow<number>('JWT_REFRESH_TTL_SECONDS');
  }

  async issue(
    customerId: string,
    sessionId: string,
    generation: number,
  ): Promise<IssuedCustomerTokens> {
    const claims = { sid: sessionId, gen: generation };
    const [accessToken, refreshToken] = await Promise.all([
      this.jwt.signAsync(
        { ...claims, kind: 'access' satisfies CustomerTokenKind },
        {
          secret: this.accessSecret,
          algorithm: 'HS256',
          audience: CUSTOMER_JWT_AUDIENCE,
          issuer: CUSTOMER_JWT_ISSUER,
          subject: customerId,
          jwtid: randomUUID(),
          expiresIn: this.accessTtlSeconds,
        },
      ),
      this.jwt.signAsync(
        { ...claims, kind: 'refresh' satisfies CustomerTokenKind },
        {
          secret: this.refreshSecret,
          algorithm: 'HS256',
          audience: CUSTOMER_JWT_AUDIENCE,
          issuer: CUSTOMER_JWT_ISSUER,
          subject: customerId,
          jwtid: randomUUID(),
          expiresIn: this.refreshTtlSeconds,
        },
      ),
    ]);

    return {
      accessToken,
      refreshToken,
      accessExpiresInSeconds: this.accessTtlSeconds,
      refreshExpiresInSeconds: this.refreshTtlSeconds,
    };
  }

  verifyAccess(token: string): Promise<VerifiedCustomerToken> {
    return this.verify(token, 'access', this.accessSecret);
  }

  verifyRefresh(token: string): Promise<VerifiedCustomerToken> {
    return this.verify(token, 'refresh', this.refreshSecret);
  }

  hashToken(token: string): string {
    return createHmac('sha256', this.tokenPepper).update(token).digest('hex');
  }

  tokenHashesMatch(left: string, right: string): boolean {
    if (left.length !== right.length) return false;
    return timingSafeEqual(Buffer.from(left), Buffer.from(right));
  }

  private async verify(
    token: string,
    expectedKind: CustomerTokenKind,
    secret: string,
  ): Promise<VerifiedCustomerToken> {
    try {
      const decoded = await this.jwt.verifyAsync<Record<string, unknown>>(token, {
        secret,
        algorithms: ['HS256'],
        audience: CUSTOMER_JWT_AUDIENCE,
        issuer: CUSTOMER_JWT_ISSUER,
      });
      const customerId = decoded.sub;
      const sessionId = decoded.sid;
      const generation = decoded.gen;
      const kind = decoded.kind;
      const expiresAt = decoded.exp;
      if (
        typeof customerId !== 'string' ||
        typeof sessionId !== 'string' ||
        typeof generation !== 'number' ||
        !Number.isSafeInteger(generation) ||
        generation < 0 ||
        kind !== expectedKind ||
        typeof expiresAt !== 'number' ||
        !Types.ObjectId.isValid(customerId) ||
        !Types.ObjectId.isValid(sessionId)
      ) {
        throw new Error('Invalid customer session token claims');
      }
      return { customerId, sessionId, generation, expiresAt };
    } catch {
      throw new UnauthorizedException({
        code: 'CUSTOMER_SESSION_INVALID',
        message: 'Customer session is invalid or expired',
      });
    }
  }
}
