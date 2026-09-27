import type { INestApplication } from '@nestjs/common';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Connection, Model, Types } from 'mongoose';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/bootstrap';
import { MigrationModule } from '../src/database/migrations/migration.module';
import { MigrationRunner } from '../src/database/migrations/migration-runner.service';
import { websiteInsightsMigration } from '../src/database/migrations/028-website-insights';
import { AdminUser } from '../src/database/schemas/identity.schema';
import { StoreSetting } from '../src/database/schemas/operations.schema';
import { WebsiteEvent } from '../src/database/schemas/website-event.schema';
import { AccountStatus, AdminRole } from '../src/domain/enums';
import { PasswordService } from '../src/modules/admin-auth/password.service';
import type { WebsiteInsightsOverview } from '../src/modules/website-insights/website-insights.types';

interface Actor {
  agent: ReturnType<typeof request.agent>;
  csrf: string;
  id: Types.ObjectId;
}

const responseBody = <T>(response: request.Response): T => response.body as T;
const settingKey = 'repair.googleReviewUrl';

describe('Website traffic and Google review settings (e2e)', () => {
  let app: INestApplication;
  let server: Server;
  let connection: Connection;
  let users: Model<AdminUser>;
  let events: Model<WebsiteEvent>;
  let settings: Model<StoreSetting>;
  let owner: Actor;
  let staff: Actor;
  const actors: Actor[] = [];
  const pagePath = `/phase28-${randomUUID().slice(0, 8)}`;

  const login = async (role: AdminRole): Promise<Actor> => {
    const password = randomUUID() + '-Website';
    const user = await users.create({
      name: `Website ${role}`,
      email: `website-${role}-${randomUUID()}@example.test`,
      passwordHash: await app.get(PasswordService).hash(password),
      roles: [role],
      status: AccountStatus.Active,
    });
    const agent = request.agent(server);
    const csrf = responseBody<{ csrfToken: string }>(
      await agent.get('/api/v1/admin/auth/csrf').expect(200),
    ).csrfToken;
    await agent
      .post('/api/v1/admin/auth/login')
      .set('x-csrf-token', csrf)
      .send({ email: user.email, password })
      .expect(200);
    const actor = { agent, csrf, id: user._id };
    actors.push(actor);
    return actor;
  };

  beforeAll(async () => {
    const fixture = await Test.createTestingModule({ imports: [AppModule, MigrationModule] })
      .overrideProvider(ThrottlerStorage)
      .useValue({
        increment: () =>
          Promise.resolve({
            totalHits: 1,
            timeToExpire: 60_000,
            isBlocked: false,
            timeToBlockExpire: 0,
          }),
      })
      .compile();
    const express = fixture.createNestApplication<NestExpressApplication>();
    configureApplication(express);
    await express.listen(0, '127.0.0.1');
    app = express;
    server = app.getHttpServer() as Server;
    connection = app.get(getConnectionToken());
    users = app.get(getModelToken(AdminUser.name));
    events = app.get(getModelToken(WebsiteEvent.name));
    settings = app.get(getModelToken(StoreSetting.name));
    await app.get(MigrationRunner).run();
    await events.deleteMany({ path: pagePath });
    await settings.deleteOne({ key: settingKey });
    owner = await login(AdminRole.Owner);
    staff = await login(AdminRole.Staff);
  }, 60_000);

  afterAll(async () => {
    if (!app) return;
    const ids = actors.map((actor) => actor.id);
    await events.deleteMany({ path: pagePath });
    await settings.deleteOne({ key: settingKey });
    await connection.db!.collection('audit_logs').deleteMany({ actorId: { $in: ids } });
    await connection.db!.collection('admin_sessions').deleteMany({ adminUserId: { $in: ids } });
    await users.deleteMany({ _id: { $in: ids } });
    await app.close();
  });

  it('records anonymous visits and reports traffic, sources, devices and review clicks', async () => {
    const visitorId = randomUUID();
    const firstSession = randomUUID();
    const input = (sessionId: string, viewportWidth: number): Record<string, string | number> => ({
      visitorId,
      sessionId,
      path: pagePath,
      referrer: 'https://www.google.com/search?q=ifixerpune',
      viewportWidth,
    });
    const browser = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)';
    await request(server)
      .post('/api/v1/website/page-view')
      .set('user-agent', browser)
      .send(input(firstSession, 390))
      .expect(201, { recorded: true });
    await request(server)
      .post('/api/v1/website/page-view')
      .set('user-agent', browser)
      .send(input(firstSession, 390))
      .expect(201, { recorded: true });
    await request(server)
      .post('/api/v1/website/page-view')
      .set('user-agent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')
      .send(input(randomUUID(), 1440))
      .expect(201, { recorded: true });
    await request(server)
      .post('/api/v1/website/google-review-click')
      .set('user-agent', browser)
      .send(input(firstSession, 390))
      .expect(201, { recorded: true });

    const today = new Date(Date.now() + 330 * 60 * 1000).toISOString().slice(0, 10);
    await request(server).get('/api/v1/admin/website/insights').expect(401);
    const report = responseBody<WebsiteInsightsOverview>(
      await staff.agent
        .get('/api/v1/admin/website/insights')
        .query({ dateFrom: today, dateTo: today })
        .expect('Cache-Control', 'private, no-store')
        .expect(200),
    );
    expect(report.kpis).toMatchObject({
      pageViews: { value: 3 },
      visits: { value: 2 },
      uniqueVisitors: { value: 1 },
      googleReviewClicks: { value: 1 },
    });
    expect(report.topPages[0]).toEqual({ path: pagePath, pageViews: 3, visits: 2 });
    expect(report.sources).toContainEqual({ source: 'GOOGLE', visits: 2 });
    expect(report.devices).toEqual(
      expect.arrayContaining([
        { device: 'MOBILE', pageViews: 2, visits: 1 },
        { device: 'DESKTOP', pageViews: 1, visits: 1 },
      ]),
    );
    const stored = await events.findOne({ path: pagePath }).lean();
    expect(stored).not.toHaveProperty('ip');
    expect(stored).not.toHaveProperty('userAgent');
    expect(stored?.visitorHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('lets the owner manage a safe Google review link and exposes it publicly', async () => {
    const path = '/api/v1/admin/website/review-settings';
    expect(
      responseBody<{ configured: boolean; version: number }>(await owner.agent.get(path)),
    ).toEqual(expect.objectContaining({ configured: false, version: 0 }));
    await staff.agent
      .post(path)
      .set('x-csrf-token', staff.csrf)
      .send({ googleReviewUrl: 'https://g.page/r/example/review', expectedVersion: 0 })
      .expect(403);
    await owner.agent
      .post(path)
      .send({ googleReviewUrl: 'https://g.page/r/example/review', expectedVersion: 0 })
      .expect(403);
    const saved = responseBody<{ googleReviewUrl: string; configured: boolean; version: number }>(
      await owner.agent
        .post(path)
        .set('x-csrf-token', owner.csrf)
        .send({ googleReviewUrl: 'https://g.page/r/example/review', expectedVersion: 0 })
        .expect(201),
    );
    expect(saved).toMatchObject({
      googleReviewUrl: 'https://g.page/r/example/review',
      configured: true,
    });
    await request(server)
      .get('/api/v1/website/review-link')
      .expect(200, { googleReviewUrl: 'https://g.page/r/example/review' });
    await owner.agent
      .post(path)
      .set('x-csrf-token', owner.csrf)
      .send({
        googleReviewUrl: 'https://google.example.test/review',
        expectedVersion: saved.version,
      })
      .expect(400);
    await owner.agent
      .post(path)
      .set('x-csrf-token', owner.csrf)
      .send({ googleReviewUrl: '', expectedVersion: saved.version })
      .expect(201)
      .expect(({ body }: request.Response) => expect(body).toMatchObject({ configured: false }));
    await request(server).get('/api/v1/website/review-link').expect(200, { googleReviewUrl: null });
  });

  it('ignores bots, validates event input and keeps the migration repeatable', async () => {
    const payload = {
      visitorId: randomUUID(),
      sessionId: randomUUID(),
      path: pagePath,
      referrer: '',
      viewportWidth: 390,
    };
    await request(server)
      .post('/api/v1/website/page-view')
      .set('user-agent', 'Googlebot/2.1')
      .send(payload)
      .expect(201, { recorded: false });
    await request(server)
      .post('/api/v1/website/page-view')
      .set('user-agent', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)')
      .send(payload)
      .expect(201, { recorded: true });
    await request(server)
      .post('/api/v1/website/page-view')
      .set('user-agent', 'Mozilla/5.0')
      .send({ ...payload, path: '//evil.test', visitorId: 'short' })
      .expect(400);
    await expect(
      connection.db!.collection('website_events').insertOne({
        eventType: 'PAGE_VIEW',
        visitorHash: 'invalid',
        sessionHash: 'invalid',
        path: '/',
        source: 'DIRECT',
        referrerHost: '',
        device: 'MOBILE',
        recordedAt: new Date(),
        expiresAt: new Date(),
      }),
    ).rejects.toMatchObject({ code: 121 });
    const before = await events.countDocuments({ path: pagePath });
    await websiteInsightsMigration.up({ connection, database: connection.db! });
    expect(await events.countDocuments({ path: pagePath })).toBe(before);
  });
});
