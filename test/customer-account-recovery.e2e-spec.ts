import { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test, TestingModule } from '@nestjs/testing';
import type { Server } from 'node:http';
import { Model } from 'mongoose';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/bootstrap';
import { MigrationRunner } from '../src/database/migrations/migration-runner.service';
import { MigrationModule } from '../src/database/migrations/migration.module';
import {
  Customer,
  CustomerActionToken,
  CustomerSession,
} from '../src/database/schemas/identity.schema';
import { OutboxEvent } from '../src/database/schemas/integration.schema';
import { Notification } from '../src/database/schemas/notification.schema';
import { AuditLog } from '../src/database/schemas/operations.schema';
import { CustomerActionPurpose } from '../src/domain/enums';
import { CustomerTokenService } from '../src/modules/customer/customer-token.service';
import { NotificationProcessor } from '../src/modules/notifications/notification.processor';
import { NotificationQueueScheduler } from '../src/modules/notifications/notification-queue.scheduler';
import { NotificationTemplateService } from '../src/modules/notifications/notification-template.service';

interface CsrfBody {
  csrfToken: string;
}

interface CustomerBody {
  customer: { id: string; email: string; emailVerified: boolean };
}

function actionTokenFromEmail(text: string, expectedPath: string): string {
  const actionUrl = text
    .split(/\s+/)
    .find((value) => value.startsWith('http://') || value.startsWith('https://'));
  if (!actionUrl) throw new Error('Expected customer action URL in email fixture');
  const url = new URL(actionUrl);
  if (url.pathname !== expectedPath) throw new Error('Customer action URL used an unexpected path');
  const token = url.searchParams.get('token');
  if (!token) throw new Error('Expected customer action token in email fixture');
  return token;
}

describe('Customer email verification and account recovery (e2e)', () => {
  const email = 'phase12-customer@richculture.test';
  const unknownEmail = 'phase12-missing@richculture.test';
  const originalPassword = 'Phase12-original-password';
  const newPassword = 'Phase12-new-secure-password';
  const startedAt = new Date();
  let app: INestApplication;
  let httpServer: Server;
  let customers: Model<Customer>;
  let sessions: Model<CustomerSession>;
  let actionTokens: Model<CustomerActionToken>;
  let outbox: Model<OutboxEvent>;
  let notifications: Model<Notification>;
  let auditLogs: Model<AuditLog>;
  let tokenService: CustomerTokenService;
  let templates: NotificationTemplateService;

  async function cleanFixtures(): Promise<void> {
    const customerDocuments = await customers.find({ email: /^phase12-/ }).select('_id');
    const customerIds = customerDocuments.map((customer) => customer._id);
    const tokenDocuments = await actionTokens
      .find({ customerId: { $in: customerIds } })
      .select('_id');
    const tokenIds = tokenDocuments.map((token) => token._id);
    const events = await outbox
      .find({ aggregateType: 'CUSTOMER_ACTION_TOKEN', aggregateId: { $in: tokenIds } })
      .select('_id');
    await notifications.deleteMany({ outboxEventId: { $in: events.map((event) => event._id) } });
    await outbox.deleteMany({ aggregateId: { $in: tokenIds } });
    await actionTokens.deleteMany({ customerId: { $in: customerIds } });
    await sessions.deleteMany({ customerId: { $in: customerIds } });
    await customers.deleteMany({ _id: { $in: customerIds } });
    await auditLogs.deleteMany({
      action: { $in: [/^CUSTOMER_EMAIL_/, /^CUSTOMER_PASSWORD_RESET_/] },
      occurredAt: { $gte: startedAt },
    });
  }

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule, MigrationModule],
    })
      .overrideProvider(NotificationProcessor)
      .useValue({})
      .overrideProvider(NotificationQueueScheduler)
      .useValue({})
      .compile();
    const expressApp = moduleFixture.createNestApplication<NestExpressApplication>();
    configureApplication(expressApp);
    await expressApp.init();
    app = expressApp;
    httpServer = app.getHttpServer() as Server;
    customers = app.get(getModelToken(Customer.name));
    sessions = app.get(getModelToken(CustomerSession.name));
    actionTokens = app.get(getModelToken(CustomerActionToken.name));
    outbox = app.get(getModelToken(OutboxEvent.name));
    notifications = app.get(getModelToken(Notification.name));
    auditLogs = app.get(getModelToken(AuditLog.name));
    tokenService = app.get(CustomerTokenService);
    templates = app.get(NotificationTemplateService);
    await app.get(MigrationRunner).run();
    await cleanFixtures();
  }, 60_000);

  afterAll(async () => {
    if (!app) return;
    await cleanFixtures();
    await app.close();
  });

  it('enforces one-time verification and generic session-revoking password recovery', async () => {
    const indexes = (await actionTokens.collection.indexes()).map((index) => index.name);
    expect(indexes).toEqual(
      expect.arrayContaining([
        'uq_customer_action_tokens_hash',
        'uq_customer_action_tokens_active_purpose',
        'ttl_customer_action_tokens_expiry',
      ]),
    );

    const browser = request.agent(httpServer);
    const csrfResponse = await browser.get('/api/v1/customer/auth/csrf').expect(200);
    const csrf = (csrfResponse.body as CsrfBody).csrfToken;
    const registration = await browser
      .post('/api/v1/customer/auth/register')
      .set('x-csrf-token', csrf)
      .send({ name: 'Phase 12 Customer', email, password: originalPassword })
      .expect(201);
    expect(registration.body).toMatchObject({ customer: { email, emailVerified: false } });

    const customer = await customers.findOne({ email }).orFail();
    const verificationAction = await actionTokens
      .findOne({ customerId: customer._id, purpose: CustomerActionPurpose.EmailVerification })
      .select('+tokenHash')
      .orFail();
    const verificationEvent = await outbox
      .findOne({ aggregateId: verificationAction._id })
      .orFail();
    expect(verificationEvent.payload).not.toHaveProperty('token');
    expect(verificationEvent.payload.tokenEnvelope).toEqual(expect.any(String));
    const [verificationEmail] = await templates.render(verificationEvent);
    const verificationToken = actionTokenFromEmail(verificationEmail.text, '/verify-email');
    expect(verificationAction.tokenHash).toBe(tokenService.hashToken(verificationToken));
    expect(verificationAction.tokenHash).not.toBe(verificationToken);
    expect(verificationEmail).toMatchObject({
      recipient: email,
      templateKey: 'CUSTOMER_EMAIL_VERIFICATION_REQUESTED',
    });
    expect(verificationEmail.text).toContain(
      `http://localhost:3000/verify-email?token=${verificationToken}`,
    );

    await browser
      .post('/api/v1/customer/auth/verify-email')
      .set('x-csrf-token', csrf)
      .send({ token: verificationToken })
      .expect(204);
    await browser
      .get('/api/v1/customer/auth/me')
      .expect(200)
      .expect(({ body }: request.Response) => {
        expect((body as CustomerBody).customer.emailVerified).toBe(true);
      });
    await browser
      .post('/api/v1/customer/auth/verify-email')
      .set('x-csrf-token', csrf)
      .send({ token: verificationToken })
      .expect(400)
      .expect(({ body }: request.Response) => {
        expect(body).toMatchObject({ code: 'CUSTOMER_ACTION_TOKEN_INVALID' });
      });

    const verificationCount = await actionTokens.countDocuments({
      customerId: customer._id,
      purpose: CustomerActionPurpose.EmailVerification,
    });
    await browser
      .post('/api/v1/customer/auth/verification-email')
      .set('x-csrf-token', csrf)
      .expect(202);
    expect(
      await actionTokens.countDocuments({
        customerId: customer._id,
        purpose: CustomerActionPurpose.EmailVerification,
      }),
    ).toBe(verificationCount);

    const genericMessage = 'If an eligible account exists, reset instructions will be sent.';
    await browser
      .post('/api/v1/customer/auth/forgot-password')
      .set('x-csrf-token', csrf)
      .send({ email: unknownEmail })
      .expect(202)
      .expect(({ body }: request.Response) => expect(body).toEqual({ message: genericMessage }));
    await browser
      .post('/api/v1/customer/auth/forgot-password')
      .set('x-csrf-token', csrf)
      .send({ email })
      .expect(202)
      .expect(({ body }: request.Response) => expect(body).toEqual({ message: genericMessage }));

    const resetAction = await actionTokens
      .findOne({ customerId: customer._id, purpose: CustomerActionPurpose.PasswordReset })
      .select('+tokenHash')
      .orFail();
    const resetEvent = await outbox.findOne({ aggregateId: resetAction._id }).orFail();
    const [resetEmail] = await templates.render(resetEvent);
    const resetToken = actionTokenFromEmail(resetEmail.text, '/reset-password');
    expect(resetEmail.text).toContain(`http://localhost:3000/reset-password?token=${resetToken}`);

    await browser
      .post('/api/v1/customer/auth/login')
      .set('x-csrf-token', csrf)
      .send({ email, password: originalPassword })
      .expect(200);
    expect(
      await sessions.countDocuments({ customerId: customer._id, revokedAt: { $exists: false } }),
    ).toBeGreaterThanOrEqual(2);

    await browser
      .post('/api/v1/customer/auth/reset-password')
      .set('x-csrf-token', csrf)
      .send({ token: resetToken, newPassword: originalPassword })
      .expect(400)
      .expect(({ body }: request.Response) => {
        expect(body).toMatchObject({ code: 'PASSWORD_UNCHANGED' });
      });
    expect((await actionTokens.findById(resetAction._id).orFail()).active).toBe(true);

    await browser
      .post('/api/v1/customer/auth/reset-password')
      .set('x-csrf-token', csrf)
      .send({ token: resetToken, newPassword })
      .expect(204);
    expect(
      await sessions.countDocuments({ customerId: customer._id, revokedAt: { $exists: false } }),
    ).toBe(0);
    expect((await actionTokens.findById(resetAction._id).orFail()).usedAt).toBeInstanceOf(Date);

    const signedOutBrowser = request.agent(httpServer);
    const renewedCsrfResponse = await signedOutBrowser
      .get('/api/v1/customer/auth/csrf')
      .expect(200);
    const renewedCsrf = (renewedCsrfResponse.body as CsrfBody).csrfToken;
    await signedOutBrowser
      .post('/api/v1/customer/auth/login')
      .set('x-csrf-token', renewedCsrf)
      .send({ email, password: originalPassword })
      .expect(401);
    await signedOutBrowser
      .post('/api/v1/customer/auth/login')
      .set('x-csrf-token', renewedCsrf)
      .send({ email, password: newPassword })
      .expect(200)
      .expect(({ body }: request.Response) => {
        expect(body).toMatchObject({ customer: { emailVerified: true } });
      });
    await signedOutBrowser
      .post('/api/v1/customer/auth/reset-password')
      .set('x-csrf-token', renewedCsrf)
      .send({ token: resetToken, newPassword: 'Phase12-another-secure-password' })
      .expect(400);

    const actions = await auditLogs.distinct('action', {
      actorId: customer._id,
      occurredAt: { $gte: startedAt },
    });
    expect(actions).toEqual(
      expect.arrayContaining([
        'CUSTOMER_EMAIL_VERIFICATION_REQUESTED',
        'CUSTOMER_EMAIL_VERIFIED',
        'CUSTOMER_PASSWORD_RESET_REQUESTED',
        'CUSTOMER_PASSWORD_RESET_COMPLETED',
      ]),
    );
  }, 60_000);
});
