import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { CookieOptions, Response } from 'express';

import {
  CUSTOMER_ACCESS_COOKIE,
  CUSTOMER_CART_COOKIE,
  CUSTOMER_CSRF_COOKIE,
  CUSTOMER_REFRESH_COOKIE,
  GUEST_CART_TTL_SECONDS,
} from './customer.constants';
import type { IssuedCustomerTokens } from './customer.types';

@Injectable()
export class CustomerCookieService {
  private readonly secure: boolean;
  private readonly sameSite: 'strict' | 'lax' | 'none';
  private readonly domain?: string;
  private readonly apiPath: string;
  private readonly refreshPath: string;

  constructor(config: ConfigService) {
    this.secure = config.getOrThrow<boolean>('COOKIE_SECURE');
    this.sameSite = config.getOrThrow<'strict' | 'lax' | 'none'>('COOKIE_SAME_SITE');
    const domain = config.getOrThrow<string>('COOKIE_DOMAIN');
    this.domain = domain || undefined;
    const apiPrefix = config.getOrThrow<string>('API_PREFIX').replace(/^\/+|\/+$/g, '');
    this.apiPath = `/${apiPrefix}`;
    this.refreshPath = `${this.apiPath}/customer/auth`;
  }

  setAuthCookies(response: Response, tokens: IssuedCustomerTokens): void {
    response.cookie(CUSTOMER_ACCESS_COOKIE, tokens.accessToken, {
      ...this.baseOptions(),
      httpOnly: true,
      path: this.apiPath,
      maxAge: tokens.accessExpiresInSeconds * 1000,
    });
    response.cookie(CUSTOMER_REFRESH_COOKIE, tokens.refreshToken, {
      ...this.baseOptions(),
      httpOnly: true,
      path: this.refreshPath,
      maxAge: tokens.refreshExpiresInSeconds * 1000,
    });
  }

  setCsrfCookie(response: Response, token: string, ttlSeconds: number): void {
    response.cookie(CUSTOMER_CSRF_COOKIE, token, {
      ...this.baseOptions(),
      httpOnly: false,
      path: this.apiPath,
      maxAge: ttlSeconds * 1000,
    });
  }

  setGuestCartCookie(response: Response, token: string): void {
    response.cookie(CUSTOMER_CART_COOKIE, token, {
      ...this.baseOptions(),
      httpOnly: true,
      path: this.apiPath,
      maxAge: GUEST_CART_TTL_SECONDS * 1000,
    });
  }

  clearGuestCartCookie(response: Response): void {
    response.clearCookie(CUSTOMER_CART_COOKIE, {
      ...this.baseOptions(),
      httpOnly: true,
      path: this.apiPath,
    });
  }

  clearAuthCookies(response: Response): void {
    response.clearCookie(CUSTOMER_ACCESS_COOKIE, {
      ...this.baseOptions(),
      httpOnly: true,
      path: this.apiPath,
    });
    response.clearCookie(CUSTOMER_REFRESH_COOKIE, {
      ...this.baseOptions(),
      httpOnly: true,
      path: this.refreshPath,
    });
  }

  clearAllAuthCookies(response: Response): void {
    this.clearAuthCookies(response);
    response.clearCookie(CUSTOMER_CSRF_COOKIE, {
      ...this.baseOptions(),
      httpOnly: false,
      path: this.apiPath,
    });
  }

  private baseOptions(): CookieOptions {
    return {
      secure: this.secure,
      sameSite: this.sameSite,
      domain: this.domain,
      priority: 'high',
    };
  }
}
