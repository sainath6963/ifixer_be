import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { MongoServerError } from 'mongodb';
import { Connection, Model, Types } from 'mongoose';

import {
  Customer,
  CustomerDocument,
  CustomerSession,
  CustomerSessionDocument,
} from '../../database/schemas/identity.schema';
import { AccountStatus } from '../../domain/enums';
import type { AuthRequestContext } from '../admin-auth/auth.types';
import { PasswordService } from '../admin-auth/password.service';
import { CustomerAccountRecoveryService } from './customer-account-recovery.service';
import { CustomerAuditService } from './customer-audit.service';
import { CustomerTokenService } from './customer-token.service';
import type {
  AuthenticatedCustomer,
  CustomerAuthResult,
  CustomerView,
  VerifiedCustomerToken,
} from './customer.types';

class CustomerRefreshConflictError extends Error {}
class CustomerUnavailableError extends Error {}

@Injectable()
export class CustomerAuthService {
  private readonly refreshTtlSeconds: number;

  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(Customer.name) private readonly customers: Model<Customer>,
    @InjectModel(CustomerSession.name)
    private readonly customerSessions: Model<CustomerSession>,
    private readonly passwords: PasswordService,
    private readonly tokens: CustomerTokenService,
    private readonly audit: CustomerAuditService,
    private readonly recovery: CustomerAccountRecoveryService,
    config: ConfigService,
  ) {
    this.refreshTtlSeconds = config.getOrThrow<number>('JWT_REFRESH_TTL_SECONDS');
  }

  async register(
    nameInput: string,
    emailInput: string,
    password: string,
    context: AuthRequestContext,
  ): Promise<CustomerAuthResult> {
    const name = nameInput.trim();
    const email = emailInput.trim().toLowerCase();
    if (await this.customers.exists({ email })) {
      throw this.emailExists();
    }

    const passwordHash = await this.passwords.hash(password);
    const customerId = new Types.ObjectId();
    const sessionId = new Types.ObjectId();
    const issued = await this.tokens.issue(customerId.toHexString(), sessionId.toHexString(), 0);
    const now = new Date();

    try {
      const customer = await this.connection.transaction(
        async (databaseSession): Promise<CustomerDocument> => {
          const [created] = await this.customers.create(
            [
              {
                _id: customerId,
                name,
                email,
                passwordHash,
                status: AccountStatus.Active,
                addresses: [],
                lastLoginAt: now,
              },
            ],
            { session: databaseSession },
          );
          await this.customerSessions.create(
            [
              {
                _id: sessionId,
                customerId,
                tokenHash: this.tokens.hashToken(issued.refreshToken),
                refreshGeneration: 0,
                expiresAt: this.refreshExpiryFrom(now),
                ipHash: this.tokens.hashToken(context.ipAddress),
                userAgent: context.userAgent,
              },
            ],
            { session: databaseSession },
          );
          await this.audit.record(
            {
              action: 'CUSTOMER_REGISTERED',
              resourceType: 'CUSTOMER_USER',
              resourceId: customerId.toHexString(),
              actorId: customerId.toHexString(),
              context,
            },
            databaseSession,
          );
          await this.recovery.queueInitialEmailVerification(created, context, databaseSession);
          return created;
        },
      );
      return { ...issued, customer: this.toCustomerView(customer) };
    } catch (error: unknown) {
      if (error instanceof MongoServerError && error.code === 11000) {
        throw this.emailExists();
      }
      throw error;
    }
  }

  async login(
    emailInput: string,
    password: string,
    context: AuthRequestContext,
  ): Promise<CustomerAuthResult> {
    const email = emailInput.trim().toLowerCase();
    const customer = await this.customers.findOne({ email }).select('+passwordHash').exec();
    if (!customer?.passwordHash) {
      await this.passwords.verifyAgainstDummy(password);
      await this.recordFailedLogin(email, context);
      throw this.invalidCredentials();
    }

    const matches = await this.passwords.verify(customer.passwordHash, password);
    if (!matches || customer.status !== AccountStatus.Active) {
      await this.recordFailedLogin(email, context);
      throw this.invalidCredentials();
    }

    const sessionId = new Types.ObjectId();
    const issued = await this.tokens.issue(customer.id, sessionId.toHexString(), 0);
    const now = new Date();
    const upgradedHash = this.passwords.needsRehash(customer.passwordHash)
      ? await this.passwords.hash(password)
      : undefined;

    try {
      await this.connection.transaction(async (databaseSession): Promise<void> => {
        const current = await this.customers
          .findOneAndUpdate(
            { _id: customer._id, status: AccountStatus.Active },
            {
              $set: {
                lastLoginAt: now,
                ...(upgradedHash ? { passwordHash: upgradedHash } : {}),
              },
            },
            { session: databaseSession, returnDocument: 'after' },
          )
          .exec();
        if (!current) throw new CustomerUnavailableError();

        await this.customerSessions.create(
          [
            {
              _id: sessionId,
              customerId: customer._id,
              tokenHash: this.tokens.hashToken(issued.refreshToken),
              refreshGeneration: 0,
              expiresAt: this.refreshExpiryFrom(now),
              ipHash: this.tokens.hashToken(context.ipAddress),
              userAgent: context.userAgent,
            },
          ],
          { session: databaseSession },
        );
        await this.audit.record(
          {
            action: 'CUSTOMER_LOGIN_SUCCEEDED',
            resourceType: 'CUSTOMER_SESSION',
            resourceId: sessionId.toHexString(),
            actorId: customer.id,
            context,
          },
          databaseSession,
        );
      });
    } catch (error: unknown) {
      if (error instanceof CustomerUnavailableError) throw this.invalidCredentials();
      throw error;
    }

    return { ...issued, customer: this.toCustomerView(customer) };
  }

  async authenticateAccess(accessToken: string): Promise<AuthenticatedCustomer> {
    const verified = await this.tokens.verifyAccess(accessToken);
    const now = new Date();
    const session = await this.customerSessions
      .findOne({
        _id: verified.sessionId,
        customerId: verified.customerId,
        refreshGeneration: verified.generation,
        revokedAt: { $exists: false },
        expiresAt: { $gt: now },
      })
      .exec();
    if (!session) throw this.invalidSession();

    const customer = await this.customers
      .findOne({ _id: verified.customerId, status: AccountStatus.Active })
      .exec();
    if (!customer) throw this.invalidSession();
    return { ...this.toCustomerView(customer), sessionId: session.id };
  }

  async refresh(refreshToken: string, context: AuthRequestContext): Promise<CustomerAuthResult> {
    const verified = await this.tokens.verifyRefresh(refreshToken);
    const presentedHash = this.tokens.hashToken(refreshToken);
    const existing = await this.customerSessions
      .findById(verified.sessionId)
      .select('+tokenHash')
      .exec();
    if (
      !existing ||
      existing.customerId.toHexString() !== verified.customerId ||
      existing.revokedAt ||
      existing.expiresAt.getTime() <= Date.now()
    ) {
      throw this.invalidSession();
    }

    if (
      existing.refreshGeneration !== verified.generation ||
      !this.tokens.tokenHashesMatch(existing.tokenHash, presentedHash)
    ) {
      await this.revokeForRefreshReuse(existing, context);
      throw this.invalidSession();
    }

    const nextGeneration = verified.generation + 1;
    const issued = await this.tokens.issue(verified.customerId, verified.sessionId, nextGeneration);
    const now = new Date();

    try {
      const customer = await this.connection.transaction(
        async (databaseSession): Promise<CustomerDocument> => {
          const rotated = await this.customerSessions
            .findOneAndUpdate(
              {
                _id: existing._id,
                customerId: existing.customerId,
                tokenHash: presentedHash,
                refreshGeneration: verified.generation,
                revokedAt: { $exists: false },
                expiresAt: { $gt: now },
              },
              {
                $set: {
                  tokenHash: this.tokens.hashToken(issued.refreshToken),
                  refreshGeneration: nextGeneration,
                  expiresAt: this.refreshExpiryFrom(now),
                  lastUsedAt: now,
                  ipHash: this.tokens.hashToken(context.ipAddress),
                  userAgent: context.userAgent,
                },
              },
              { session: databaseSession, returnDocument: 'after' },
            )
            .exec();
          if (!rotated) throw new CustomerRefreshConflictError();

          const current = await this.customers
            .findOne({ _id: verified.customerId, status: AccountStatus.Active })
            .session(databaseSession)
            .exec();
          if (!current) throw new CustomerUnavailableError();
          await this.audit.record(
            {
              action: 'CUSTOMER_REFRESH_ROTATED',
              resourceType: 'CUSTOMER_SESSION',
              resourceId: existing.id,
              actorId: current.id,
              context,
              metadata: { generation: nextGeneration },
            },
            databaseSession,
          );
          return current;
        },
      );
      return { ...issued, customer: this.toCustomerView(customer) };
    } catch (error: unknown) {
      if (error instanceof CustomerRefreshConflictError) {
        const latest = await this.customerSessions.findById(existing._id).select('+tokenHash');
        if (latest) await this.revokeForRefreshReuse(latest, context);
        throw this.invalidSession();
      }
      if (error instanceof CustomerUnavailableError) {
        await this.revokeSession(existing.id, 'CUSTOMER_UNAVAILABLE', context);
        throw this.invalidSession();
      }
      throw error;
    }
  }

  async logout(refreshToken: string | undefined, context: AuthRequestContext): Promise<void> {
    if (!refreshToken) return;
    let verified: VerifiedCustomerToken;
    try {
      verified = await this.tokens.verifyRefresh(refreshToken);
    } catch {
      return;
    }
    await this.revokeSession(verified.sessionId, 'LOGOUT', context, verified.customerId);
  }

  async logoutAll(customer: AuthenticatedCustomer, context: AuthRequestContext): Promise<void> {
    const now = new Date();
    await this.connection.transaction(async (databaseSession): Promise<void> => {
      await this.customerSessions.updateMany(
        { customerId: new Types.ObjectId(customer.id), revokedAt: { $exists: false } },
        { $set: { revokedAt: now, revokedReason: 'LOGOUT_ALL' } },
        { session: databaseSession },
      );
      await this.audit.record(
        {
          action: 'CUSTOMER_LOGOUT_ALL',
          resourceType: 'CUSTOMER_USER',
          resourceId: customer.id,
          actorId: customer.id,
          context,
        },
        databaseSession,
      );
    });
  }

  async changePassword(
    customer: AuthenticatedCustomer,
    currentPassword: string,
    newPassword: string,
    context: AuthRequestContext,
  ): Promise<void> {
    const current = await this.customers
      .findOne({ _id: customer.id, status: AccountStatus.Active })
      .select('+passwordHash')
      .exec();
    if (
      !current?.passwordHash ||
      !(await this.passwords.verify(current.passwordHash, currentPassword))
    ) {
      throw new UnauthorizedException({
        code: 'CURRENT_PASSWORD_INVALID',
        message: 'Current password is incorrect',
      });
    }
    if (await this.passwords.verify(current.passwordHash, newPassword)) {
      throw new BadRequestException({
        code: 'PASSWORD_UNCHANGED',
        message: 'New password must differ from the current password',
      });
    }

    const passwordHash = await this.passwords.hash(newPassword);
    const now = new Date();
    await this.connection.transaction(async (databaseSession): Promise<void> => {
      const updated = await this.customers.updateOne(
        { _id: current._id, status: AccountStatus.Active },
        { $set: { passwordHash, passwordChangedAt: now } },
        { session: databaseSession },
      );
      if (updated.modifiedCount !== 1) throw new CustomerUnavailableError();
      await this.customerSessions.updateMany(
        { customerId: current._id, revokedAt: { $exists: false } },
        { $set: { revokedAt: now, revokedReason: 'PASSWORD_CHANGED' } },
        { session: databaseSession },
      );
      await this.audit.record(
        {
          action: 'CUSTOMER_PASSWORD_CHANGED',
          resourceType: 'CUSTOMER_USER',
          resourceId: customer.id,
          actorId: customer.id,
          context,
        },
        databaseSession,
      );
    });
  }

  private async recordFailedLogin(email: string, context: AuthRequestContext): Promise<void> {
    await this.audit.record({
      action: 'CUSTOMER_LOGIN_FAILED',
      resourceType: 'CUSTOMER_AUTH',
      resourceId: this.tokens.hashToken(email),
      context,
    });
  }

  private async revokeForRefreshReuse(
    session: CustomerSessionDocument,
    context: AuthRequestContext,
  ): Promise<void> {
    const now = new Date();
    await this.connection.transaction(async (databaseSession): Promise<void> => {
      const result = await this.customerSessions.updateOne(
        { _id: session._id, revokedAt: { $exists: false } },
        {
          $set: {
            revokedAt: now,
            revokedReason: 'REFRESH_TOKEN_REUSE',
            reuseDetectedAt: now,
          },
        },
        { session: databaseSession },
      );
      if (result.modifiedCount === 1) {
        await this.audit.record(
          {
            action: 'CUSTOMER_REFRESH_REUSE_DETECTED',
            resourceType: 'CUSTOMER_SESSION',
            resourceId: session.id,
            actorId: session.customerId.toHexString(),
            context,
          },
          databaseSession,
        );
      }
    });
  }

  private async revokeSession(
    sessionId: string,
    reason: string,
    context: AuthRequestContext,
    expectedCustomerId?: string,
  ): Promise<void> {
    if (!Types.ObjectId.isValid(sessionId)) return;
    const now = new Date();
    await this.connection.transaction(async (databaseSession): Promise<void> => {
      const session = await this.customerSessions
        .findOneAndUpdate(
          {
            _id: sessionId,
            ...(expectedCustomerId ? { customerId: new Types.ObjectId(expectedCustomerId) } : {}),
            revokedAt: { $exists: false },
          },
          { $set: { revokedAt: now, revokedReason: reason } },
          { session: databaseSession, returnDocument: 'after' },
        )
        .exec();
      if (session) {
        await this.audit.record(
          {
            action: 'CUSTOMER_SESSION_REVOKED',
            resourceType: 'CUSTOMER_SESSION',
            resourceId: session.id,
            actorId: session.customerId.toHexString(),
            context,
            metadata: { reason },
          },
          databaseSession,
        );
      }
    });
  }

  private refreshExpiryFrom(date: Date): Date {
    return new Date(date.getTime() + this.refreshTtlSeconds * 1000);
  }

  private toCustomerView(customer: CustomerDocument): CustomerView {
    return {
      id: customer.id,
      name: customer.name,
      email: customer.email,
      mobile: customer.mobile,
      emailVerified: Boolean(customer.emailVerifiedAt),
      mobileVerified: Boolean(customer.mobileVerifiedAt),
      version: customer.get('version') as number,
      communicationPreferences: {
        marketingEmail: customer.communicationPreferences?.marketingEmail ?? false,
        backInStockEmail: customer.communicationPreferences?.backInStockEmail ?? true,
        orderUpdatesSms: customer.communicationPreferences?.orderUpdatesSms ?? false,
        orderUpdatesWhatsapp: customer.communicationPreferences?.orderUpdatesWhatsapp ?? false,
      },
    };
  }

  private emailExists(): ConflictException {
    return new ConflictException({
      code: 'CUSTOMER_EMAIL_EXISTS',
      message: 'An account with this email already exists',
    });
  }

  private invalidCredentials(): UnauthorizedException {
    return new UnauthorizedException({
      code: 'CUSTOMER_CREDENTIALS_INVALID',
      message: 'Invalid email or password',
    });
  }

  private invalidSession(): UnauthorizedException {
    return new UnauthorizedException({
      code: 'CUSTOMER_SESSION_INVALID',
      message: 'Customer session is invalid or expired',
    });
  }
}
