import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { Types } from 'mongoose';

import { ADMIN_JWT_AUDIENCE, ADMIN_JWT_ISSUER } from './auth.constants';
import type { IssuedAuthTokens, VerifiedSessionToken } from './auth.types';

type TokenKind = 'access' | 'refresh';

@Injectable()
export class AdminTokenService {
  private readonly accessSecret: string;
  private readonly refreshSecret: string;
  private readonly tokenPepper: string;
  private readonly accessTtlSeconds: number;
  private readonly refreshTtlSeconds: number;

  constructor(
    private readonly jwt: JwtService,
    config: ConfigService,
  ) {
    this.accessSecret = config.getOrThrow<string>('JWT_ACCESS_SECRET');
    this.refreshSecret = config.getOrThrow<string>('JWT_REFRESH_SECRET');
    this.tokenPepper = config.getOrThrow<string>('AUTH_TOKEN_PEPPER');
    this.accessTtlSeconds = config.getOrThrow<number>('JWT_ACCESS_TTL_SECONDS');
    this.refreshTtlSeconds = config.getOrThrow<number>('JWT_REFRESH_TTL_SECONDS');
  }

  async issue(adminId: string, sessionId: string, generation: number): Promise<IssuedAuthTokens> {
    const claims = { sid: sessionId, gen: generation };
    const [accessToken, refreshToken] = await Promise.all([
      this.jwt.signAsync(
        { ...claims, kind: 'access' satisfies TokenKind },
        {
          secret: this.accessSecret,
          algorithm: 'HS256',
          audience: ADMIN_JWT_AUDIENCE,
          issuer: ADMIN_JWT_ISSUER,
          subject: adminId,
          jwtid: randomUUID(),
          expiresIn: this.accessTtlSeconds,
        },
      ),
      this.jwt.signAsync(
        { ...claims, kind: 'refresh' satisfies TokenKind },
        {
          secret: this.refreshSecret,
          algorithm: 'HS256',
          audience: ADMIN_JWT_AUDIENCE,
          issuer: ADMIN_JWT_ISSUER,
          subject: adminId,
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

  verifyAccess(token: string): Promise<VerifiedSessionToken> {
    return this.verify(token, 'access', this.accessSecret);
  }

  verifyRefresh(token: string): Promise<VerifiedSessionToken> {
    return this.verify(token, 'refresh', this.refreshSecret);
  }

  hashRefreshToken(token: string): string {
    return createHmac('sha256', this.tokenPepper).update(token).digest('hex');
  }

  hashSensitiveValue(value: string): string {
    return createHmac('sha256', this.tokenPepper).update(value).digest('hex');
  }

  tokenHashesMatch(left: string, right: string): boolean {
    if (left.length !== right.length) {
      return false;
    }
    return timingSafeEqual(Buffer.from(left), Buffer.from(right));
  }

  private async verify(
    token: string,
    expectedKind: TokenKind,
    secret: string,
  ): Promise<VerifiedSessionToken> {
    try {
      const decoded = await this.jwt.verifyAsync<Record<string, unknown>>(token, {
        secret,
        algorithms: ['HS256'],
        audience: ADMIN_JWT_AUDIENCE,
        issuer: ADMIN_JWT_ISSUER,
      });

      const adminId = decoded.sub;
      const sessionId = decoded.sid;
      const generation = decoded.gen;
      const kind = decoded.kind;
      const expiresAt = decoded.exp;

      if (
        typeof adminId !== 'string' ||
        typeof sessionId !== 'string' ||
        typeof generation !== 'number' ||
        !Number.isSafeInteger(generation) ||
        generation < 0 ||
        kind !== expectedKind ||
        typeof expiresAt !== 'number' ||
        !Types.ObjectId.isValid(adminId) ||
        !Types.ObjectId.isValid(sessionId)
      ) {
        throw new Error('Invalid session token claims');
      }

      return { adminId, sessionId, generation, expiresAt };
    } catch {
      throw new UnauthorizedException({
        code: 'ADMIN_SESSION_INVALID',
        message: 'Admin session is invalid or expired',
      });
    }
  }
}
