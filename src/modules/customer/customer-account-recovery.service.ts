import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { MongoServerError } from 'mongodb';
import { randomBytes } from 'node:crypto';
import { ClientSession, Connection, Model, Types } from 'mongoose';

import {
  Customer,
  CustomerActionToken,
  CustomerActionTokenDocument,
  CustomerDocument,
  CustomerSession,
} from '../../database/schemas/identity.schema';
import { OutboxEvent } from '../../database/schemas/integration.schema';
import { AccountStatus, CustomerActionPurpose, OutboxStatus } from '../../domain/enums';
import type { AuthRequestContext } from '../admin-auth/auth.types';
import { PasswordService } from '../admin-auth/password.service';
import { CustomerAuditService } from './customer-audit.service';
import { CustomerTokenService } from './customer-token.service';
import type { AuthenticatedCustomer } from './customer.types';
import { encryptCustomerActionToken } from './customer-action-token-envelope';

class InvalidCustomerActionTokenError extends Error {}
class CustomerRecoveryUnavailableError extends Error {}

@Injectable()
export class CustomerAccountRecoveryService {
  private readonly verificationTtlMs: number;
  private readonly passwordResetTtlMs: number;
  private readonly cooldownMs: number;
  private readonly tokenEnvelopeSecret: string;

  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(Customer.name) private readonly customers: Model<Customer>,
    @InjectModel(CustomerActionToken.name)
    private readonly actionTokens: Model<CustomerActionToken>,
    @InjectModel(CustomerSession.name)
    private readonly customerSessions: Model<CustomerSession>,
    @InjectModel(OutboxEvent.name) private readonly outbox: Model<OutboxEvent>,
    private readonly passwords: PasswordService,
    private readonly tokens: CustomerTokenService,
    private readonly audit: CustomerAuditService,
    config: ConfigService,
  ) {
    this.verificationTtlMs =
      config.getOrThrow<number>('CUSTOMER_EMAIL_VERIFICATION_TTL_SECONDS') * 1000;
    this.passwordResetTtlMs =
      config.getOrThrow<number>('CUSTOMER_PASSWORD_RESET_TTL_SECONDS') * 1000;
    this.cooldownMs = config.getOrThrow<number>('CUSTOMER_AUTH_EMAIL_COOLDOWN_SECONDS') * 1000;
    this.tokenEnvelopeSecret = config.getOrThrow<string>('CUSTOMER_TOKEN_PEPPER');
  }

  async queueInitialEmailVerification(
    customer: CustomerDocument,
    context: AuthRequestContext,
    session: ClientSession,
  ): Promise<void> {
    if (!customer.email || customer.emailVerifiedAt) return;
    await this.issue(customer, CustomerActionPurpose.EmailVerification, context, session);
  }

  async requestEmailVerification(
    customer: AuthenticatedCustomer,
    context: AuthRequestContext,
  ): Promise<void> {
    if (customer.emailVerified) return;
    try {
      await this.connection.transaction(async (session): Promise<void> => {
        const current = await this.customers
          .findOne({ _id: customer.id, status: AccountStatus.Active })
          .session(session)
          .exec();
        if (!current?.email || current.emailVerifiedAt) return;
        if (
          await this.wasRecentlyIssued(
            current._id,
            CustomerActionPurpose.EmailVerification,
            session,
          )
        ) {
          return;
        }
        await this.issue(current, CustomerActionPurpose.EmailVerification, context, session);
      });
    } catch (error: unknown) {
      if (this.isActiveTokenRace(error)) return;
      throw error;
    }
  }

  async requestPasswordReset(emailInput: string, context: AuthRequestContext): Promise<void> {
    const email = emailInput.trim().toLowerCase();
    const customer = await this.customers
      .findOne({ email, status: AccountStatus.Active })
      .select('+passwordHash')
      .exec();
    if (!customer?.email || !customer.passwordHash) {
      await this.audit.record({
        action: 'CUSTOMER_PASSWORD_RESET_REQUESTED',
        resourceType: 'CUSTOMER_AUTH',
        resourceId: this.tokens.hashToken(email),
        context,
        metadata: { eligible: false },
      });
      return;
    }

    try {
      await this.connection.transaction(async (session): Promise<void> => {
        const current = await this.customers
          .findOne({ _id: customer._id, email, status: AccountStatus.Active })
          .session(session)
          .exec();
        if (!current?.email) return;
        if (
          await this.wasRecentlyIssued(current._id, CustomerActionPurpose.PasswordReset, session)
        ) {
          return;
        }
        await this.issue(current, CustomerActionPurpose.PasswordReset, context, session);
      });
    } catch (error: unknown) {
      if (this.isActiveTokenRace(error)) return;
      throw error;
    }
  }

  async requestEmailChange(
    customer: AuthenticatedCustomer,
    newEmailInput: string,
    currentPassword: string,
    context: AuthRequestContext,
  ): Promise<void> {
    const newEmail = newEmailInput.trim().toLowerCase();
    const current = await this.customers
      .findOne({ _id: customer.id, status: AccountStatus.Active })
      .select('+passwordHash')
      .exec();
    if (
      !current?.passwordHash ||
      !(await this.passwords.verify(current.passwordHash, currentPassword))
    ) {
      throw new UnauthorizedException({
        code: 'CUSTOMER_PASSWORD_INVALID',
        message: 'Current password is incorrect',
      });
    }
    if (current.email === newEmail) {
      throw new BadRequestException({
        code: 'CUSTOMER_EMAIL_UNCHANGED',
        message: 'New email must differ from the current email',
      });
    }
    if (await this.customers.exists({ email: newEmail, _id: { $ne: current._id } })) {
      throw this.emailExists();
    }

    try {
      await this.connection.transaction(async (session): Promise<void> => {
        const eligible = await this.customers
          .findOne({ _id: current._id, email: current.email, status: AccountStatus.Active })
          .session(session)
          .exec();
        if (!eligible) throw new CustomerRecoveryUnavailableError();
        if (
          await this.wasRecentlyIssued(eligible._id, CustomerActionPurpose.EmailChange, session)
        ) {
          return;
        }
        await this.issue(eligible, CustomerActionPurpose.EmailChange, context, session, newEmail);
      });
    } catch (error: unknown) {
      if (this.isActiveTokenRace(error)) return;
      if (error instanceof CustomerRecoveryUnavailableError) throw this.invalidActionToken();
      throw error;
    }
  }

  async confirmEmailChange(rawToken: string, context: AuthRequestContext): Promise<void> {
    const tokenHash = this.tokens.hashToken(rawToken);
    const now = new Date();
    try {
      await this.connection.transaction(async (session): Promise<void> => {
        const action = await this.claim(tokenHash, CustomerActionPurpose.EmailChange, now, session);
        const customer = await this.customers
          .findOneAndUpdate(
            { _id: action.customerId, status: AccountStatus.Active },
            {
              $set: { email: action.targetEmail, emailVerifiedAt: now },
              $inc: { version: 1 },
            },
            { session, returnDocument: 'after' },
          )
          .exec();
        if (!customer) throw new CustomerRecoveryUnavailableError();
        await this.customerSessions.updateMany(
          { customerId: customer._id, revokedAt: { $exists: false } },
          { $set: { revokedAt: now, revokedReason: 'EMAIL_CHANGED' } },
          { session },
        );
        await this.actionTokens.updateMany(
          { customerId: customer._id, active: true },
          { $set: { active: false, invalidatedAt: now } },
          { session },
        );
        await this.audit.record(
          {
            action: 'CUSTOMER_EMAIL_CHANGED',
            resourceType: 'CUSTOMER_ACTION_TOKEN',
            resourceId: action.id,
            actorId: customer.id,
            context,
          },
          session,
        );
      });
    } catch (error: unknown) {
      if (error instanceof MongoServerError && error.code === 11000) throw this.emailExists();
      if (
        error instanceof InvalidCustomerActionTokenError ||
        error instanceof CustomerRecoveryUnavailableError
      ) {
        throw this.invalidActionToken();
      }
      throw error;
    }
  }

  async verifyEmail(rawToken: string, context: AuthRequestContext): Promise<void> {
    const tokenHash = this.tokens.hashToken(rawToken);
    const now = new Date();
    try {
      await this.connection.transaction(async (session): Promise<void> => {
        const action = await this.claim(
          tokenHash,
          CustomerActionPurpose.EmailVerification,
          now,
          session,
        );
        const customer = await this.customers
          .findOneAndUpdate(
            {
              _id: action.customerId,
              email: action.targetEmail,
              status: AccountStatus.Active,
            },
            { $set: { emailVerifiedAt: now } },
            { session, returnDocument: 'after' },
          )
          .exec();
        if (!customer) throw new CustomerRecoveryUnavailableError();
        await this.invalidateOtherTokens(
          customer._id,
          CustomerActionPurpose.EmailVerification,
          action._id,
          now,
          session,
        );
        await this.audit.record(
          {
            action: 'CUSTOMER_EMAIL_VERIFIED',
            resourceType: 'CUSTOMER_ACTION_TOKEN',
            resourceId: action.id,
            actorId: customer.id,
            context,
          },
          session,
        );
      });
    } catch (error: unknown) {
      if (
        error instanceof InvalidCustomerActionTokenError ||
        error instanceof CustomerRecoveryUnavailableError
      ) {
        throw this.invalidActionToken();
      }
      throw error;
    }
  }

  async resetPassword(
    rawToken: string,
    newPassword: string,
    context: AuthRequestContext,
  ): Promise<void> {
    const tokenHash = this.tokens.hashToken(rawToken);
    const now = new Date();
    const action = await this.actionTokens
      .findOne({
        tokenHash,
        purpose: CustomerActionPurpose.PasswordReset,
        active: true,
        expiresAt: { $gt: now },
      })
      .exec();
    if (!action) throw this.invalidActionToken();
    const customer = await this.customers
      .findOne({
        _id: action.customerId,
        email: action.targetEmail,
        status: AccountStatus.Active,
      })
      .select('+passwordHash')
      .exec();
    if (!customer?.passwordHash) throw this.invalidActionToken();
    if (await this.passwords.verify(customer.passwordHash, newPassword)) {
      throw new BadRequestException({
        code: 'PASSWORD_UNCHANGED',
        message: 'New password must differ from the current password',
      });
    }
    const passwordHash = await this.passwords.hash(newPassword);

    try {
      await this.connection.transaction(async (session): Promise<void> => {
        const claimed = await this.claim(
          tokenHash,
          CustomerActionPurpose.PasswordReset,
          new Date(),
          session,
        );
        const resetAt = new Date();
        const updated = await this.customers.updateOne(
          {
            _id: claimed.customerId,
            email: claimed.targetEmail,
            status: AccountStatus.Active,
          },
          {
            $set: {
              passwordHash,
              passwordChangedAt: resetAt,
              ...(customer.emailVerifiedAt ? {} : { emailVerifiedAt: resetAt }),
            },
          },
          { session },
        );
        if (updated.modifiedCount !== 1) throw new CustomerRecoveryUnavailableError();
        await this.customerSessions.updateMany(
          { customerId: claimed.customerId, revokedAt: { $exists: false } },
          { $set: { revokedAt: resetAt, revokedReason: 'PASSWORD_RESET' } },
          { session },
        );
        await this.actionTokens.updateMany(
          { customerId: claimed.customerId, active: true },
          { $set: { active: false, invalidatedAt: resetAt } },
          { session },
        );
        await this.audit.record(
          {
            action: 'CUSTOMER_PASSWORD_RESET_COMPLETED',
            resourceType: 'CUSTOMER_ACTION_TOKEN',
            resourceId: claimed.id,
            actorId: claimed.customerId.toHexString(),
            context,
          },
          session,
        );
      });
    } catch (error: unknown) {
      if (
        error instanceof InvalidCustomerActionTokenError ||
        error instanceof CustomerRecoveryUnavailableError
      ) {
        throw this.invalidActionToken();
      }
      throw error;
    }
  }

  private async issue(
    customer: CustomerDocument,
    purpose: CustomerActionPurpose,
    context: AuthRequestContext,
    session: ClientSession,
    requestedTargetEmail?: string,
  ): Promise<void> {
    const targetEmail = requestedTargetEmail ?? customer.email;
    if (!targetEmail) return;
    const now = new Date();
    const rawToken = randomBytes(32).toString('base64url');
    const actionId = new Types.ObjectId();
    await this.actionTokens.updateMany(
      { customerId: customer._id, purpose, active: true },
      { $set: { active: false, invalidatedAt: now } },
      { session },
    );
    await this.actionTokens.create(
      [
        {
          _id: actionId,
          customerId: customer._id,
          purpose,
          tokenHash: this.tokens.hashToken(rawToken),
          targetEmail,
          expiresAt: new Date(
            now.getTime() +
              (purpose === CustomerActionPurpose.EmailVerification ||
              purpose === CustomerActionPurpose.EmailChange
                ? this.verificationTtlMs
                : this.passwordResetTtlMs),
          ),
          active: true,
        },
      ],
      { session },
    );
    const eventType =
      purpose === CustomerActionPurpose.EmailVerification
        ? 'CUSTOMER_EMAIL_VERIFICATION_REQUESTED'
        : purpose === CustomerActionPurpose.EmailChange
          ? 'CUSTOMER_EMAIL_CHANGE_REQUESTED'
          : 'CUSTOMER_PASSWORD_RESET_REQUESTED';
    await this.outbox.create(
      [
        {
          eventId: `customer-auth-${actionId.toHexString()}`,
          aggregateType: 'CUSTOMER_ACTION_TOKEN',
          aggregateId: actionId,
          eventType,
          payload: {
            tokenEnvelope: encryptCustomerActionToken(rawToken, this.tokenEnvelopeSecret),
          },
          status: OutboxStatus.Pending,
          processingAttempts: 0,
          availableAt: now,
        },
      ],
      { session },
    );
    await this.audit.record(
      {
        action: eventType,
        resourceType: 'CUSTOMER_ACTION_TOKEN',
        resourceId: actionId.toHexString(),
        actorId: customer.id,
        context,
      },
      session,
    );
  }

  private async claim(
    tokenHash: string,
    purpose: CustomerActionPurpose,
    now: Date,
    session: ClientSession,
  ): Promise<CustomerActionTokenDocument> {
    const action = await this.actionTokens
      .findOneAndUpdate(
        { tokenHash, purpose, active: true, expiresAt: { $gt: now } },
        { $set: { active: false, usedAt: now } },
        { session, returnDocument: 'after' },
      )
      .exec();
    if (!action) throw new InvalidCustomerActionTokenError();
    return action;
  }

  private async invalidateOtherTokens(
    customerId: Types.ObjectId,
    purpose: CustomerActionPurpose,
    usedTokenId: Types.ObjectId,
    now: Date,
    session: ClientSession,
  ): Promise<void> {
    await this.actionTokens.updateMany(
      { _id: { $ne: usedTokenId }, customerId, purpose, active: true },
      { $set: { active: false, invalidatedAt: now } },
      { session },
    );
  }

  private wasRecentlyIssued(
    customerId: Types.ObjectId,
    purpose: CustomerActionPurpose,
    session?: ClientSession,
  ): Promise<boolean> {
    return this.actionTokens
      .exists({
        customerId,
        purpose,
        active: true,
        expiresAt: { $gt: new Date() },
        createdAt: { $gte: new Date(Date.now() - this.cooldownMs) },
      })
      .session(session ?? null)
      .then(Boolean);
  }

  private isActiveTokenRace(error: unknown): boolean {
    return (
      error instanceof MongoServerError &&
      error.code === 11000 &&
      String(error.message).includes('uq_customer_action_tokens_active_purpose')
    );
  }

  private invalidActionToken(): BadRequestException {
    return new BadRequestException({
      code: 'CUSTOMER_ACTION_TOKEN_INVALID',
      message: 'This link is invalid, expired, or has already been used',
    });
  }

  private emailExists(): ConflictException {
    return new ConflictException({
      code: 'CUSTOMER_EMAIL_EXISTS',
      message: 'An account with this email already exists',
    });
  }
}
