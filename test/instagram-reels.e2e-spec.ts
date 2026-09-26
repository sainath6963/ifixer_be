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
import { instagramReelsMigration } from '../src/database/migrations/027-instagram-reels';
import { AdminUser } from '../src/database/schemas/identity.schema';
import { InstagramReel } from '../src/database/schemas/instagram-reel.schema';
import { AdminRole, AccountStatus } from '../src/domain/enums';
import { PasswordService } from '../src/modules/admin-auth/password.service';
import type { ReelView, ReelsPage } from '../src/modules/instagram-reels/instagram-reels.service';
interface Actor {
  agent: ReturnType<typeof request.agent>;
  csrf: string;
  id: Types.ObjectId;
}
const body = <T>(response: request.Response): T => response.body as T;
describe('Instagram Reel publishing (e2e)', () => {
  let app: INestApplication;
  let server: Server;
  let connection: Connection;
  let users: Model<AdminUser>;
  let reels: Model<InstagramReel>;
  let owner: Actor;
  let staff: Actor;
  let reception: Actor;
  let technician: Actor;
  const actors: Actor[] = [];
  const prefix = `REEL-${randomUUID().slice(0, 8)}`;
  const adminPath = '/api/v1/admin/repair/reels';
  const publicPath = '/api/v1/repair/reels';
  const input = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    url: `https://www.instagram.com/reel/${randomUUID().replaceAll('-', '')}/`,
    title: prefix,
    active: true,
    sortOrder: 10,
    ...extra,
  });
  const create = (data = input(), actor = owner): request.Test =>
    actor.agent.post(adminPath).set('x-csrf-token', actor.csrf).send(data);
  const update = (row: ReelView, extra: Record<string, unknown>): request.Test =>
    owner.agent
      .patch(`${adminPath}/${row.id}`)
      .set('x-csrf-token', owner.csrf)
      .send({
        url: row.url,
        title: row.title,
        active: row.active,
        sortOrder: row.sortOrder,
        expectedVersion: row.version,
        ...extra,
      });
  const login = async (role: AdminRole): Promise<Actor> => {
    const password = randomUUID() + '-Reels';
    const user = await users.create({
      name: prefix,
      email: `${prefix}-${role}@example.test`,
      passwordHash: await app.get(PasswordService).hash(password),
      roles: [role],
      status: AccountStatus.Active,
    });
    const agent = request.agent(server);
    const csrf = body<{ csrfToken: string }>(await agent.get('/api/v1/admin/auth/csrf')).csrfToken;
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
            timeToExpire: 60000,
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
    reels = app.get(getModelToken(InstagramReel.name));
    await app.get(MigrationRunner).run();
    owner = await login(AdminRole.Owner);
    staff = await login(AdminRole.Staff);
    reception = await login(AdminRole.Reception);
    technician = await login(AdminRole.Technician);
  }, 60000);
  afterEach(async () => {
    await reels?.deleteMany({ title: prefix });
  });
  afterAll(async () => {
    if (!app) return;
    const ids = actors.map((actor) => actor.id);
    await connection.db!.collection('audit_logs').deleteMany({ actorId: { $in: ids } });
    await connection.db!.collection('admin_sessions').deleteMany({ adminUserId: { $in: ids } });
    await users.deleteMany({ _id: { $in: ids } });
    await app.close();
  });
  it('publishes canonical links, excludes hidden records and paginates by display order', async () => {
    const code = randomUUID().replaceAll('-', '');
    const first = body<ReelView>(
      await create(
        input({ url: `https://instagram.com/reels/${code}?igsh=tracking#shared`, sortOrder: 0 }),
      ).expect(201),
    );
    expect(first.url).toBe(`https://www.instagram.com/reel/${code}/`);
    for (let index = 1; index <= 6; index++) await create(input({ sortOrder: index })).expect(201);
    const hidden = body<ReelView>(await create(input({ active: false })).expect(201));
    const response = await request(server).get(publicPath).expect(200);
    const page = body<ReelsPage>(response);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(page.total).toBe(7);
    expect(page.items).toHaveLength(6);
    expect(page.items[0].id).toBe(first.id);
    expect(page.items.some((row) => row.id === hidden.id)).toBe(false);
    expect(page.items[0]).not.toHaveProperty('version');
    expect(page.items[0]).not.toHaveProperty('active');
    expect(
      body<ReelsPage>(await request(server).get(publicPath).query({ page: 2 })).items,
    ).toHaveLength(1);
    expect(body<ReelsPage>(await owner.agent.get(adminPath)).total).toBe(8);
    await request(server).get(publicPath).query({ page: -1 }).expect(400);
  });
  it('rejects non-Reel URLs, executable content, credentials and misleading hosts', async () => {
    for (const url of [
      'javascript:alert(1)',
      '<iframe src="https://evil.test"></iframe>',
      'https://instagram.com.evil.test/reel/ABCDE/',
      'https://www.instagram.com@evil.test/reel/ABCDE/',
      'https://evil.test@www.instagram.com/reel/ABCDE/',
      'http://www.instagram.com/reel/ABCDE/',
      'https://www.instagram.com:444/reel/ABCDE/',
      'https://www.instagram.com/profile/',
      'https://www.instagram.com/share/reel/ABCDE/',
      'https://www.instagram.com/reel/%2FABCDE/',
      'https://www.instagram.com/p/ABCDE/',
    ])
      await create(input({ url })).expect(400);
    await create(input({ sortOrder: 1.5 })).expect(400);
    await create(input({ title: 'a'.repeat(121) })).expect(400);
    expect(await reels.countDocuments()).toBe(0);
  });
  it('prevents duplicate records for the same Reel, including concurrent submissions', async () => {
    const data = input();
    const results = await Promise.all([
      create(data),
      create({ ...data, url: String(data.url) + '?igsh=second' }),
    ]);
    expect(results.map((row) => row.status).sort()).toEqual([201, 409]);
    expect(await reels.countDocuments({ title: prefix })).toBe(1);
  });
  it('allows authorized editors only and enforces CSRF on writes', async () => {
    await request(server).get(adminPath).expect(401);
    for (const actor of [reception, technician]) {
      await actor.agent.get(adminPath).expect(403);
      await create(input(), actor).expect(403);
    }
    await staff.agent.post(adminPath).send(input()).expect(403);
    await create(input(), staff).expect(201);
    const audit = await connection
      .db!.collection('audit_logs')
      .findOne({ actorId: staff.id, action: 'INSTAGRAM_REEL_CREATED' });
    expect(audit).toBeTruthy();
  });
  it('supports hiding and republishing with version checks and preserves the saved title', async () => {
    const row = body<ReelView>(await create().expect(201));
    const hidden = body<ReelView>(await update(row, { active: false }).expect(200));
    expect(body<ReelsPage>(await request(server).get(publicPath)).total).toBe(0);
    await update(row, { sortOrder: 50 }).expect(409);
    await update(hidden, { expectedVersion: undefined }).expect(400);
    const published = body<ReelView>(
      await update(hidden, { active: true, sortOrder: 5 }).expect(200),
    );
    expect(published.title).toBe(prefix);
    expect(published.sortOrder).toBe(5);
    expect(body<ReelsPage>(await request(server).get(publicPath)).items[0].id).toBe(row.id);
  });
  it('enforces database validation and preserves records when the migration runs twice', async () => {
    const row = body<ReelView>(await create().expect(201));
    const collection = connection.db!.collection('instagram_reels');
    await expect(
      collection.updateOne(
        { _id: new Types.ObjectId(row.id) },
        { $set: { url: 'https://evil.test' } },
      ),
    ).rejects.toMatchObject({ code: 121 });
    await expect(
      collection.updateOne({ _id: new Types.ObjectId(row.id) }, { $set: { sortOrder: -1 } }),
    ).rejects.toMatchObject({ code: 121 });
    for (let i = 0; i < 2; i++)
      await instagramReelsMigration.up({ connection, database: connection.db! });
    expect(body<ReelsPage>(await owner.agent.get(adminPath)).items[0]).toEqual(row);
  });
});
