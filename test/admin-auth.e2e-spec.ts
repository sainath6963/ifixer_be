import { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test, TestingModule } from '@nestjs/testing';
import type { Server } from 'node:http';
import { Model, Types } from 'mongoose';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/bootstrap';
import { MigrationModule } from '../src/database/migrations/migration.module';
import { MigrationRunner } from '../src/database/migrations/migration-runner.service';
import { AdminSession, AdminUser } from '../src/database/schemas/identity.schema';
import { AuditLog } from '../src/database/schemas/operations.schema';
import { AccountStatus, AdminRole } from '../src/domain/enums';
import {
  ADMIN_ACCESS_COOKIE,
  ADMIN_CSRF_COOKIE,
  ADMIN_REFRESH_COOKIE,
} from '../src/modules/admin-auth/auth.constants';
import { PasswordService } from '../src/modules/admin-auth/password.service';

interface AuthResponseBody {
  admin: {
    id: string;
    name: string;
    email: string;
    roles: AdminRole[];
  };
}

interface CsrfResponseBody {
  csrfToken: string;
  expiresInSeconds: number;
}

function responseCookie(response: request.Response, name: string): string {
  const headers = response.headers as Record<string, string | string[] | undefined>;
  const setCookies = headers['set-cookie'];
  const values = Array.isArray(setCookies) ? setCookies : setCookies ? [setCookies] : [];
  const cookie = values.find((value) => value.startsWith(`${name}=`));
  if (!cookie) {
    throw new Error(`Expected ${name} cookie`);
  }
  return cookie.split(';', 1)[0];
}

function fullResponseCookie(response: request.Response, name: string): string {
  const headers = response.headers as Record<string, string | string[] | undefined>;
  const setCookies = headers['set-cookie'];
  const values = Array.isArray(setCookies) ? setCookies : setCookies ? [setCookies] : [];
  const cookie = values.find((value) => value.startsWith(`${name}=`));
  if (!cookie) {
    throw new Error(`Expected ${name} cookie`);
  }
  return cookie;
}

describe('Admin authentication (e2e)', () => {
  const email = 'phase3-owner@richculture.test';
  const originalPassword = 'Phase3-original-password';
  const changedPassword = 'Phase3-changed-password';
  const startedAt = new Date();

  let app: INestApplication;
  let httpServer: Server;
  let adminUsers: Model<AdminUser>;
  let adminSessions: Model<AdminSession>;
  let auditLogs: Model<AuditLog>;
  let adminId: Types.ObjectId;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule, MigrationModule],
    }).compile();
    const expressApp = moduleFixture.createNestApplication<NestExpressApplication>();
    configureApplication(expressApp);
    await expressApp.init();
    app = expressApp;
    httpServer = app.getHttpServer() as Server;
    adminUsers = app.get<Model<AdminUser>>(getModelToken(AdminUser.name));
    adminSessions = app.get<Model<AdminSession>>(getModelToken(AdminSession.name));
    auditLogs = app.get<Model<AuditLog>>(getModelToken(AuditLog.name));
    await app.get(MigrationRunner).run();

    const previous = await adminUsers.findOne({ email }).exec();
    if (previous) {
      await adminSessions.deleteMany({ adminUserId: previous._id });
      await adminUsers.deleteOne({ _id: previous._id });
    }

    const passwordHash = await app.get(PasswordService).hash(originalPassword);
    const created = await adminUsers.create({
      name: 'Phase 3 Owner',
      email,
      passwordHash,
      roles: [AdminRole.Owner],
      status: AccountStatus.Active,
    });
    adminId = created._id;
  }, 60_000);

  afterAll(async () => {
    if (adminId) {
      await adminSessions.deleteMany({ adminUserId: adminId });
      await adminUsers.deleteOne({ _id: adminId });
    }
    await auditLogs.deleteMany({ action: /^ADMIN_/, occurredAt: { $gte: startedAt } });
    await app.close();
  });

  it('protects login with CSRF and returns generic credential errors', async () => {
    await request(httpServer)
      .post('/api/v1/admin/auth/login')
      .send({ email, password: originalPassword })
      .expect(403)
      .expect(({ body }: request.Response) => {
        expect(body).toMatchObject({ code: 'CSRF_TOKEN_INVALID' });
      });

    const browser = request.agent(httpServer);
    const csrfResponse = await browser.get('/api/v1/admin/auth/csrf').expect(200);
    const csrf = csrfResponse.body as CsrfResponseBody;
    expect(csrf.csrfToken).toEqual(expect.any(String));

    await browser
      .post('/api/v1/admin/auth/login')
      .set('x-csrf-token', csrf.csrfToken)
      .send({ email: 'missing@richculture.test', password: originalPassword })
      .expect(401)
      .expect(({ body }: request.Response) => {
        expect(body).toMatchObject({
          code: 'ADMIN_CREDENTIALS_INVALID',
          message: 'Invalid email or password',
        });
      });
  });

  it('rotates refresh tokens, detects reuse, changes password, and revokes sessions', async () => {
    const browser = request.agent(httpServer);
    const csrfResponse = await browser.get('/api/v1/admin/auth/csrf').expect(200);
    let csrf = (csrfResponse.body as CsrfResponseBody).csrfToken;
    const csrfCookie = responseCookie(csrfResponse, ADMIN_CSRF_COOKIE);

    const loginResponse = await browser
      .post('/api/v1/admin/auth/login')
      .set('x-csrf-token', csrf)
      .send({ email, password: originalPassword })
      .expect(200);
    expect(loginResponse.body as AuthResponseBody).toMatchObject({
      admin: { email, roles: [AdminRole.Owner] },
    });
    expect(loginResponse.headers['cache-control']).toBe('no-store');
    const accessSetCookie = fullResponseCookie(loginResponse, ADMIN_ACCESS_COOKIE);
    expect(accessSetCookie).toContain('HttpOnly');
    expect(accessSetCookie).toContain('Path=/api/v1/admin');
    expect(accessSetCookie).toContain('SameSite=Strict');
    const refreshSetCookie = fullResponseCookie(loginResponse, ADMIN_REFRESH_COOKIE);
    expect(refreshSetCookie).toContain('HttpOnly');
    expect(refreshSetCookie).toContain('Path=/api/v1/admin/auth');
    expect(refreshSetCookie).toContain('SameSite=Strict');
    const oldRefreshCookie = responseCookie(loginResponse, ADMIN_REFRESH_COOKIE);

    await browser
      .get('/api/v1/admin/auth/me')
      .expect(200)
      .expect(({ body }: request.Response) => {
        expect(body).toMatchObject({ admin: { email, roles: [AdminRole.Owner] } });
      });

    await browser
      .get('/api/v1/admin/health/ready')
      .expect(200)
      .expect(({ body }: request.Response) => {
        expect(body).toMatchObject({
          status: 'ok',
          details: {
            mongodb: { status: 'up' },
            redis: { status: 'up' },
            mediaStorage: { status: 'up' },
          },
        });
      });

    const refreshResponse = await browser
      .post('/api/v1/admin/auth/refresh')
      .set('x-csrf-token', csrf)
      .expect(200);
    const rotatedAccessCookie = responseCookie(refreshResponse, ADMIN_ACCESS_COOKIE);

    await request(httpServer)
      .post('/api/v1/admin/auth/refresh')
      .set('Cookie', [csrfCookie, oldRefreshCookie])
      .set('x-csrf-token', csrf)
      .expect(401);

    await request(httpServer)
      .get('/api/v1/admin/auth/me')
      .set('Cookie', rotatedAccessCookie)
      .expect(401);

    const secondLogin = await browser
      .post('/api/v1/admin/auth/login')
      .set('x-csrf-token', csrf)
      .send({ email, password: originalPassword })
      .expect(200);
    expect(responseCookie(secondLogin, ADMIN_ACCESS_COOKIE)).toContain(`${ADMIN_ACCESS_COOKIE}=`);

    await browser
      .patch('/api/v1/admin/auth/password')
      .set('x-csrf-token', csrf)
      .send({ currentPassword: originalPassword, newPassword: changedPassword })
      .expect(204);
    await browser.get('/api/v1/admin/auth/me').expect(401);

    const renewedCsrf = await browser.get('/api/v1/admin/auth/csrf').expect(200);
    csrf = (renewedCsrf.body as CsrfResponseBody).csrfToken;
    await browser
      .post('/api/v1/admin/auth/login')
      .set('x-csrf-token', csrf)
      .send({ email, password: changedPassword })
      .expect(200);

    await browser.post('/api/v1/admin/auth/logout-all').set('x-csrf-token', csrf).expect(204);
    await browser.get('/api/v1/admin/auth/me').expect(401);

    const actions = await auditLogs.distinct('action', { actorId: adminId });
    expect(actions).toEqual(
      expect.arrayContaining([
        'ADMIN_LOGIN_SUCCEEDED',
        'ADMIN_REFRESH_ROTATED',
        'ADMIN_REFRESH_REUSE_DETECTED',
        'ADMIN_PASSWORD_CHANGED',
        'ADMIN_LOGOUT_ALL',
      ]),
    );
  });
});
