import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Types } from 'mongoose';

import { AdminCookieService } from './cookie.service';
import { CsrfService } from './csrf.service';
import { PasswordService } from './password.service';
import { AdminTokenService } from './token.service';

function configFrom(values: Record<string, unknown>): ConfigService {
  return {
    getOrThrow<T>(key: string): T {
      if (!(key in values)) {
        throw new Error(`Missing test configuration: ${key}`);
      }
      return values[key] as T;
    },
  } as ConfigService;
}

describe('Admin authentication security primitives', () => {
  it('issues, verifies, expires, and rejects tampered CSRF tokens', () => {
    jest.useFakeTimers({ now: new Date('2026-08-08T00:00:00Z') });
    const setCsrfCookie = jest.fn();
    const cookies = { setCsrfCookie } as unknown as AdminCookieService;
    const csrf = new CsrfService(
      configFrom({
        CSRF_SECRET: 'test-csrf-secret-with-at-least-32-characters',
        CSRF_TTL_SECONDS: 600,
      }),
      cookies,
    );
    const response = {} as Parameters<CsrfService['issue']>[0];
    const token = csrf.issue(response);

    expect(setCsrfCookie).toHaveBeenCalledWith(response, token, 600);
    expect(csrf.verify(token, token)).toBe(true);
    expect(csrf.verify(token, `${token.slice(0, -1)}x`)).toBe(false);

    jest.advanceTimersByTime(601_000);
    expect(csrf.verify(token, token)).toBe(false);
    jest.useRealTimers();
  });

  it('keeps access and refresh JWTs cryptographically separate', async () => {
    const service = new AdminTokenService(
      new JwtService(),
      configFrom({
        JWT_ACCESS_SECRET: 'unit-access-secret-with-at-least-32-characters',
        JWT_REFRESH_SECRET: 'unit-refresh-secret-with-at-least-32-characters',
        AUTH_TOKEN_PEPPER: 'unit-token-pepper-with-at-least-32-characters',
        JWT_ACCESS_TTL_SECONDS: 900,
        JWT_REFRESH_TTL_SECONDS: 3600,
      }),
    );
    const adminId = new Types.ObjectId().toHexString();
    const sessionId = new Types.ObjectId().toHexString();
    const issued = await service.issue(adminId, sessionId, 3);

    await expect(service.verifyAccess(issued.accessToken)).resolves.toMatchObject({
      adminId,
      sessionId,
      generation: 3,
    });
    await expect(service.verifyRefresh(issued.refreshToken)).resolves.toMatchObject({
      generation: 3,
    });
    await expect(service.verifyAccess(issued.refreshToken)).rejects.toMatchObject({ status: 401 });
    expect(service.hashRefreshToken(issued.refreshToken)).not.toContain(issued.refreshToken);
  });

  it('hashes and verifies admin passwords with Argon2id', async () => {
    const passwords = new PasswordService();
    const hash = await passwords.hash('phase3-unit-password');

    expect(hash.startsWith('$argon2id$')).toBe(true);
    await expect(passwords.verify(hash, 'phase3-unit-password')).resolves.toBe(true);
    await expect(passwords.verify(hash, 'wrong-password')).resolves.toBe(false);
    expect(passwords.needsRehash(hash)).toBe(false);
  });
});
