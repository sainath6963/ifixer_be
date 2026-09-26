import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { CustomerCookieService } from './customer-cookie.service';

@Injectable()
export class CustomerCsrfService {
  private readonly secret: string;
  readonly ttlSeconds: number;

  constructor(
    config: ConfigService,
    private readonly cookies: CustomerCookieService,
  ) {
    this.secret = config.getOrThrow<string>('CSRF_SECRET');
    this.ttlSeconds = config.getOrThrow<number>('CSRF_TTL_SECONDS');
  }

  issue(response: Response): string {
    const issuedAt = Math.floor(Date.now() / 1000);
    const nonce = randomBytes(32).toString('base64url');
    const unsignedToken = `customer.${issuedAt}.${nonce}`;
    const token = `${unsignedToken}.${this.sign(unsignedToken)}`;
    this.cookies.setCsrfCookie(response, token, this.ttlSeconds);
    return token;
  }

  verify(cookieToken: string, headerToken: string): boolean {
    if (!this.safeEqual(cookieToken, headerToken)) return false;
    const [context, issuedAtText, nonce, signature, extra] = headerToken.split('.');
    if (extra !== undefined || context !== 'customer') return false;
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
    return this.safeEqual(signature, this.sign(`customer.${issuedAtText}.${nonce}`));
  }

  private sign(value: string): string {
    return createHmac('sha256', this.secret).update(value).digest('base64url');
  }

  private safeEqual(left: string, right: string): boolean {
    if (left.length !== right.length) return false;
    return timingSafeEqual(Buffer.from(left), Buffer.from(right));
  }
}
