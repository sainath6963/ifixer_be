import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { CookieOptions, Response } from 'express';

import { ADMIN_ACCESS_COOKIE, ADMIN_CSRF_COOKIE, ADMIN_REFRESH_COOKIE } from './auth.constants';
import type { IssuedAuthTokens } from './auth.types';

@Injectable()
export class AdminCookieService {
  private readonly secure: boolean;
  private readonly sameSite: 'strict' | 'lax' | 'none';
  private readonly domain?: string;
  private readonly adminPath: string;
  private readonly refreshPath: string;

  constructor(config: ConfigService) {
    this.secure = config.getOrThrow<boolean>('COOKIE_SECURE');
    this.sameSite = config.getOrThrow<'strict' | 'lax' | 'none'>('COOKIE_SAME_SITE');
    const domain = config.getOrThrow<string>('COOKIE_DOMAIN');
    this.domain = domain || undefined;
    const apiPrefix = config.getOrThrow<string>('API_PREFIX').replace(/^\/+|\/+$/g, '');
    this.adminPath = `/${apiPrefix}/admin`;
    this.refreshPath = `${this.adminPath}/auth`;
  }

  setAuthCookies(response: Response, tokens: IssuedAuthTokens): void {
    response.cookie(ADMIN_ACCESS_COOKIE, tokens.accessToken, {
      ...this.baseOptions(),
      httpOnly: true,
      path: this.adminPath,
      maxAge: tokens.accessExpiresInSeconds * 1000,
    });
    response.cookie(ADMIN_REFRESH_COOKIE, tokens.refreshToken, {
      ...this.baseOptions(),
      httpOnly: true,
      path: this.refreshPath,
      maxAge: tokens.refreshExpiresInSeconds * 1000,
    });
  }

  setCsrfCookie(response: Response, token: string, ttlSeconds: number): void {
    response.cookie(ADMIN_CSRF_COOKIE, token, {
      ...this.baseOptions(),
      httpOnly: false,
      path: this.adminPath,
      maxAge: ttlSeconds * 1000,
    });
  }

  clearAuthCookies(response: Response): void {
    response.clearCookie(ADMIN_ACCESS_COOKIE, {
      ...this.baseOptions(),
      httpOnly: true,
      path: this.adminPath,
    });
    response.clearCookie(ADMIN_REFRESH_COOKIE, {
      ...this.baseOptions(),
      httpOnly: true,
      path: this.refreshPath,
    });
  }

  clearAllCookies(response: Response): void {
    this.clearAuthCookies(response);
    response.clearCookie(ADMIN_CSRF_COOKIE, {
      ...this.baseOptions(),
      httpOnly: false,
      path: this.adminPath,
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
