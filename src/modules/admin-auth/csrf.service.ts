import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { AdminCookieService } from './cookie.service';

@Injectable()
export class CsrfService {
  private readonly secret: string;
  readonly ttlSeconds: number;

  constructor(
    config: ConfigService,
    private readonly cookies: AdminCookieService,
  ) {
    this.secret = config.getOrThrow<string>('CSRF_SECRET');
    this.ttlSeconds = config.getOrThrow<number>('CSRF_TTL_SECONDS');
  }

  issue(response: Response): string {
    const issuedAt = Math.floor(Date.now() / 1000);
    const nonce = randomBytes(32).toString('base64url');
    const unsignedToken = `${issuedAt}.${nonce}`;
    const signature = this.sign(unsignedToken);
    const token = `${unsignedToken}.${signature}`;
    this.cookies.setCsrfCookie(response, token, this.ttlSeconds);
    return token;
  }

  verify(cookieToken: string, headerToken: string): boolean {
    if (!this.safeEqual(cookieToken, headerToken)) {
      return false;
    }

    const parts = headerToken.split('.');
    if (parts.length !== 3) {
      return false;
    }

    const [issuedAtText, nonce, signature] = parts;
    const issuedAt = Number(issuedAtText);
    const now = Math.floor(Date.now() / 1000);
    if (
      !Number.isSafeInteger(issuedAt) ||
      issuedAt > now + 60 ||
      now - issuedAt > this.ttlSeconds ||
      !/^[a-zA-Z0-9_-]{32,}$/.test(nonce)
    ) {
      return false;
    }

    return this.safeEqual(signature, this.sign(`${issuedAtText}.${nonce}`));
  }

  private sign(value: string): string {
    return createHmac('sha256', this.secret).update(value).digest('base64url');
  }

  private safeEqual(left: string, right: string): boolean {
    if (left.length !== right.length) {
      return false;
    }
    return timingSafeEqual(Buffer.from(left), Buffer.from(right));
  }
}
