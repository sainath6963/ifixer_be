import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Types } from 'mongoose';

import { AdminCookieService } from '../admin-auth/cookie.service';
import { CsrfService } from '../admin-auth/csrf.service';
import { CustomerCookieService } from './customer-cookie.service';
import { CustomerCsrfService } from './customer-csrf.service';
import { CustomerTokenService } from './customer-token.service';

function configFrom(values: Record<string, unknown>): ConfigService {
  return {
    getOrThrow<T>(key: string): T {
      if (!(key in values)) throw new Error(`Missing test configuration: ${key}`);
      return values[key] as T;
    },
  } as ConfigService;
}

describe('Customer authentication security primitives', () => {
  it('issues context-bound customer CSRF tokens', () => {
    jest.useFakeTimers({ now: new Date('2026-08-08T00:00:00Z') });
    const config = configFrom({
      CSRF_SECRET: 'test-csrf-secret-with-at-least-32-characters',
      CSRF_TTL_SECONDS: 600,
    });
    const customerCookies = {
      setCsrfCookie: jest.fn(),
    } as unknown as CustomerCookieService;
    const customerCsrf = new CustomerCsrfService(config, customerCookies);
    const response = {} as Parameters<CustomerCsrfService['issue']>[0];
    const token = customerCsrf.issue(response);
    const adminCsrf = new CsrfService(config, {} as AdminCookieService);

    expect(customerCsrf.verify(token, token)).toBe(true);
    expect(adminCsrf.verify(token, token)).toBe(false);
    expect(customerCsrf.verify(token, `${token.slice(0, -1)}x`)).toBe(false);
    jest.advanceTimersByTime(601_000);
    expect(customerCsrf.verify(token, token)).toBe(false);
    jest.useRealTimers();
  });

  it('keeps customer access and refresh JWTs separate', async () => {
    const service = new CustomerTokenService(
      new JwtService(),
      configFrom({
        CUSTOMER_JWT_ACCESS_SECRET: 'unit-customer-access-secret-with-at-least-32-characters',
        CUSTOMER_JWT_REFRESH_SECRET: 'unit-customer-refresh-secret-with-at-least-32-characters',
        CUSTOMER_TOKEN_PEPPER: 'unit-customer-token-pepper-with-at-least-32-characters',
        JWT_ACCESS_TTL_SECONDS: 900,
        JWT_REFRESH_TTL_SECONDS: 3600,
      }),
    );
    const customerId = new Types.ObjectId().toHexString();
    const sessionId = new Types.ObjectId().toHexString();
    const issued = await service.issue(customerId, sessionId, 2);

    await expect(service.verifyAccess(issued.accessToken)).resolves.toMatchObject({
      customerId,
      sessionId,
      generation: 2,
    });
    await expect(service.verifyAccess(issued.refreshToken)).rejects.toMatchObject({ status: 401 });
    expect(service.hashToken(issued.refreshToken)).toHaveLength(64);
    expect(service.hashToken(issued.refreshToken)).not.toContain(issued.refreshToken);
  });
});
