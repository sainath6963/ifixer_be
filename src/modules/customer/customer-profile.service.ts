import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { MongoServerError } from 'mongodb';
import { randomInt } from 'node:crypto';
import { Connection, Model, Types } from 'mongoose';

import {
  Customer,
  CustomerActionToken,
  CustomerDocument,
  CustomerMobileChallenge,
  CustomerSession,
} from '../../database/schemas/identity.schema';
import { OutboxEvent } from '../../database/schemas/integration.schema';
import { Order } from '../../database/schemas/order.schema';
import { ReturnRequest } from '../../database/schemas/return-request.schema';
import { StockAlert } from '../../database/schemas/wishlist.schema';
import {
  AccountStatus,
  OutboxStatus,
  OrderLifecycleStatus,
  ReturnRequestStatus,
  StockAlertStatus,
} from '../../domain/enums';
import type { AuthRequestContext } from '../admin-auth/auth.types';
import { PasswordService } from '../admin-auth/password.service';
import { CustomerAuditService } from './customer-audit.service';
import { encryptCustomerMobileOtp } from './customer-otp-envelope';
import { CustomerTokenService } from './customer-token.service';
import type { AuthenticatedCustomer, CustomerView } from './customer.types';

export interface MobileChallengeView {
  challengeId: string;
  expiresAt: string;
  developmentOtp?: string;
}

@Injectable()
export class CustomerProfileService {
  private readonly otpTtlMs: number;
  private readonly otpCooldownMs: number;
  private readonly otpMaxAttempts: number;
  private readonly isProduction: boolean;
  private readonly smsDeliveryEnabled: boolean;
  private readonly otpEnvelopeSecret: string;

  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(Customer.name) private readonly customers: Model<Customer>,
    @InjectModel(CustomerMobileChallenge.name)
    private readonly mobileChallenges: Model<CustomerMobileChallenge>,
    @InjectModel(CustomerSession.name) private readonly sessions: Model<CustomerSession>,
    @InjectModel(CustomerActionToken.name)
    private readonly actionTokens: Model<CustomerActionToken>,
    @InjectModel(Order.name) private readonly orders: Model<Order>,
    @InjectModel(ReturnRequest.name) private readonly returns: Model<ReturnRequest>,
    @InjectModel(StockAlert.name) private readonly stockAlerts: Model<StockAlert>,
    @InjectModel(OutboxEvent.name) private readonly outbox: Model<OutboxEvent>,
    private readonly passwords: PasswordService,
    private readonly tokens: CustomerTokenService,
    private readonly audit: CustomerAuditService,
    config: ConfigService,
  ) {
    this.otpTtlMs = config.getOrThrow<number>('CUSTOMER_MOBILE_OTP_TTL_SECONDS') * 1000;
    this.otpCooldownMs = config.getOrThrow<number>('CUSTOMER_MOBILE_OTP_COOLDOWN_SECONDS') * 1000;
    this.otpMaxAttempts = config.getOrThrow<number>('CUSTOMER_MOBILE_OTP_MAX_ATTEMPTS');
    this.isProduction = config.getOrThrow<string>('NODE_ENV') === 'production';
    this.smsDeliveryEnabled = config.getOrThrow<boolean>('SMS_DELIVERY_ENABLED');
    this.otpEnvelopeSecret = config.getOrThrow<string>('CUSTOMER_TOKEN_PEPPER');
  }

  async updateName(
    customer: AuthenticatedCustomer,
    nameInput: string,
    expectedVersion: number,
    context: AuthRequestContext,
  ): Promise<CustomerView> {
    const updated = await this.customers
      .findOneAndUpdate(
        { _id: customer.id, status: AccountStatus.Active, version: expectedVersion },
        { $set: { name: nameInput.trim() }, $inc: { version: 1 } },
        { returnDocument: 'after' },
      )
      .exec();
    if (!updated) throw this.profileConflict();
    await this.audit.record({
      action: 'CUSTOMER_PROFILE_UPDATED',
      resourceType: 'CUSTOMER_USER',
      resourceId: updated.id,
      actorId: updated.id,
      context,
      metadata: { fields: ['name'] },
    });
    return this.toView(updated);
  }

  async updatePreferences(
    customer: AuthenticatedCustomer,
    marketingEmail: boolean,
    backInStockEmail: boolean,
    orderUpdatesSms: boolean,
    orderUpdatesWhatsapp: boolean,
    expectedVersion: number,
    context: AuthRequestContext,
  ): Promise<CustomerView> {
    if ((orderUpdatesSms || orderUpdatesWhatsapp) && !customer.mobileVerified) {
      throw new BadRequestException({
        code: 'CUSTOMER_MOBILE_VERIFICATION_REQUIRED',
        message: 'Verify your mobile number before enabling mobile order updates',
      });
    }
    const now = new Date();
    return this.connection.transaction(async (session): Promise<CustomerView> => {
      const updated = await this.customers
        .findOneAndUpdate(
          { _id: customer.id, status: AccountStatus.Active, version: expectedVersion },
          {
            $set: {
              communicationPreferences: {
                marketingEmail,
                backInStockEmail,
                orderUpdatesSms,
                orderUpdatesWhatsapp,
              },
            },
            $inc: { version: 1 },
          },
          { session, returnDocument: 'after' },
        )
        .exec();
      if (!updated) throw this.profileConflict();
      if (!backInStockEmail) {
        await this.stockAlerts.updateMany(
          { customerId: updated._id, active: true },
          {
            $set: {
              active: false,
              status: StockAlertStatus.Cancelled,
              cancelledAt: now,
            },
          },
          { session },
        );
      }
      await this.audit.record(
        {
          action: 'CUSTOMER_COMMUNICATION_PREFERENCES_UPDATED',
          resourceType: 'CUSTOMER_USER',
          resourceId: updated.id,
          actorId: updated.id,
          context,
        },
        session,
      );
      return this.toView(updated);
    });
  }

  async requestMobileChange(
    customer: AuthenticatedCustomer,
    mobileInput: string,
    currentPassword: string,
    context: AuthRequestContext,
  ): Promise<MobileChallengeView> {
    if (!this.smsDeliveryEnabled) {
      throw new ServiceUnavailableException({
        code: 'MOBILE_OTP_DELIVERY_UNAVAILABLE',
        message: 'Mobile verification is unavailable because SMS delivery is disabled',
      });
    }
    const mobile = mobileInput.trim();
    const current = await this.customers
      .findOne({ _id: customer.id, status: AccountStatus.Active })
      .select('+passwordHash')
      .exec();
    if (
      !current?.passwordHash ||
      !(await this.passwords.verify(current.passwordHash, currentPassword))
    ) {
      throw this.invalidPassword();
    }
    if (current.mobile === mobile && current.mobileVerifiedAt) {
      throw new BadRequestException({
        code: 'CUSTOMER_MOBILE_UNCHANGED',
        message: 'This mobile number is already verified on your account',
      });
    }
    if (await this.customers.exists({ mobile, _id: { $ne: current._id } })) {
      throw this.mobileExists();
    }
    const recent = await this.mobileChallenges.exists({
      customerId: current._id,
      active: true,
      expiresAt: { $gt: new Date() },
      createdAt: { $gte: new Date(Date.now() - this.otpCooldownMs) },
    });
    if (recent) {
      throw this.mobileOtpCooldown();
    }

    const now = new Date();
    const challengeId = new Types.ObjectId();
    const otp = String(randomInt(100_000, 1_000_000));
    const expiresAt = new Date(now.getTime() + this.otpTtlMs);
    try {
      await this.connection.transaction(async (session): Promise<void> => {
        await this.mobileChallenges.updateMany(
          { customerId: current._id, active: true },
          { $set: { active: false, invalidatedAt: now } },
          { session },
        );
        await this.mobileChallenges.create(
          [
            {
              _id: challengeId,
              customerId: current._id,
              targetMobile: mobile,
              codeHash: this.mobileCodeHash(challengeId, mobile, otp),
              expiresAt,
              active: true,
              attempts: 0,
            },
          ],
          { session },
        );
        await this.outbox.create(
          [
            {
              eventId: `customer-mobile-otp:${challengeId.toHexString()}`,
              aggregateType: 'CUSTOMER_MOBILE_CHALLENGE',
              aggregateId: challengeId,
              eventType: 'CUSTOMER_MOBILE_OTP_REQUESTED',
              payload: {
                otpEnvelope: encryptCustomerMobileOtp(otp, this.otpEnvelopeSecret),
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
            action: 'CUSTOMER_MOBILE_CHANGE_REQUESTED',
            resourceType: 'CUSTOMER_USER',
            resourceId: current.id,
            actorId: current.id,
            context,
          },
          session,
        );
      });
    } catch (error: unknown) {
      if (error instanceof MongoServerError && error.code === 11000) {
        throw this.mobileOtpCooldown();
      }
      throw error;
    }
    return {
      challengeId: challengeId.toHexString(),
      expiresAt: expiresAt.toISOString(),
      ...(!this.isProduction ? { developmentOtp: otp } : {}),
    };
  }

  async confirmMobileChange(
    customer: AuthenticatedCustomer,
    challengeIdInput: string,
    otp: string,
    expectedVersion: number,
    context: AuthRequestContext,
  ): Promise<CustomerView> {
    const challengeId = new Types.ObjectId(challengeIdInput);
    const now = new Date();
    const challenge = await this.mobileChallenges
      .findOne({
        _id: challengeId,
        customerId: customer.id,
        active: true,
        expiresAt: { $gt: now },
        attempts: { $lt: this.otpMaxAttempts },
      })
      .select('+codeHash')
      .exec();
    if (!challenge) throw this.invalidOtp();
    const submittedHash = this.mobileCodeHash(challengeId, challenge.targetMobile, otp);
    if (!this.tokens.tokenHashesMatch(challenge.codeHash, submittedHash)) {
      const nextAttempts = challenge.attempts + 1;
      await this.mobileChallenges.updateOne(
        { _id: challenge._id, active: true },
        {
          $inc: { attempts: 1 },
          ...(nextAttempts >= this.otpMaxAttempts
            ? { $set: { active: false, invalidatedAt: now } }
            : {}),
        },
      );
      throw this.invalidOtp();
    }

    try {
      return await this.connection.transaction(async (session): Promise<CustomerView> => {
        const consumed = await this.mobileChallenges
          .findOneAndUpdate(
            {
              _id: challenge._id,
              customerId: customer.id,
              codeHash: challenge.codeHash,
              active: true,
              expiresAt: { $gt: new Date() },
            },
            { $set: { active: false, usedAt: now } },
            { session, returnDocument: 'after' },
          )
          .select('+codeHash')
          .exec();
        if (!consumed) throw this.invalidOtp();
        const updated = await this.customers
          .findOneAndUpdate(
            { _id: customer.id, status: AccountStatus.Active, version: expectedVersion },
            {
              $set: { mobile: consumed.targetMobile, mobileVerifiedAt: now },
              $inc: { version: 1 },
            },
            { session, returnDocument: 'after' },
          )
          .exec();
        if (!updated) throw this.profileConflict();
        await this.audit.record(
          {
            action: 'CUSTOMER_MOBILE_VERIFIED',
            resourceType: 'CUSTOMER_USER',
            resourceId: updated.id,
            actorId: updated.id,
            context,
          },
          session,
        );
        return this.toView(updated);
      });
    } catch (error: unknown) {
      if (error instanceof MongoServerError && error.code === 11000) throw this.mobileExists();
      throw error;
    }
  }

  async deactivate(
    customer: AuthenticatedCustomer,
    currentPassword: string,
    reason: string | undefined,
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
      throw this.invalidPassword();
    }
    const now = new Date();
    await this.connection.transaction(async (session): Promise<void> => {
      const openOrder = await this.orders
        .exists({
          customerId: current._id,
          lifecycleStatus: {
            $nin: [
              OrderLifecycleStatus.Completed,
              OrderLifecycleStatus.Cancelled,
              OrderLifecycleStatus.Expired,
            ],
          },
        })
        .session(session);
      const openReturn = await this.returns
        .exists({
          customerId: current._id,
          status: {
            $in: [
              ReturnRequestStatus.Requested,
              ReturnRequestStatus.Approved,
              ReturnRequestStatus.Received,
            ],
          },
        })
        .session(session);
      if (openOrder || openReturn) {
        throw new ConflictException({
          code: 'ACCOUNT_DEACTIVATION_BLOCKED',
          message: 'Resolve active orders and return requests before deactivating this account',
        });
      }
      const updated = await this.customers.updateOne(
        { _id: current._id, status: AccountStatus.Active },
        {
          $set: {
            status: AccountStatus.Disabled,
            deactivatedAt: now,
            ...(reason ? { deactivationReason: reason } : {}),
          },
          $inc: { version: 1 },
        },
        { session },
      );
      if (updated.modifiedCount !== 1) throw this.profileConflict();
      await this.sessions.updateMany(
        { customerId: current._id, revokedAt: { $exists: false } },
        { $set: { revokedAt: now, revokedReason: 'ACCOUNT_DEACTIVATED' } },
        { session },
      );
      await this.actionTokens.updateMany(
        { customerId: current._id, active: true },
        { $set: { active: false, invalidatedAt: now } },
        { session },
      );
      await this.mobileChallenges.updateMany(
        { customerId: current._id, active: true },
        { $set: { active: false, invalidatedAt: now } },
        { session },
      );
      await this.stockAlerts.updateMany(
        { customerId: current._id, active: true },
        {
          $set: {
            active: false,
            status: StockAlertStatus.Cancelled,
            cancelledAt: now,
          },
        },
        { session },
      );
      await this.audit.record(
        {
          action: 'CUSTOMER_ACCOUNT_DEACTIVATED',
          resourceType: 'CUSTOMER_USER',
          resourceId: current.id,
          actorId: current.id,
          context,
          metadata: { reasonProvided: Boolean(reason) },
        },
        session,
      );
    });
  }

  private mobileCodeHash(challengeId: Types.ObjectId, mobile: string, otp: string): string {
    return this.tokens.hashToken(`${challengeId.toHexString()}:${mobile}:${otp}`);
  }

  private toView(customer: CustomerDocument): CustomerView {
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

  private invalidPassword(): UnauthorizedException {
    return new UnauthorizedException({
      code: 'CUSTOMER_PASSWORD_INVALID',
      message: 'Current password is incorrect',
    });
  }

  private invalidOtp(): BadRequestException {
    return new BadRequestException({
      code: 'CUSTOMER_MOBILE_OTP_INVALID',
      message: 'This verification code is invalid, expired, or has already been used',
    });
  }

  private profileConflict(): ConflictException {
    return new ConflictException({
      code: 'CUSTOMER_PROFILE_CONFLICT',
      message: 'Your profile changed in another session. Refresh and try again',
    });
  }

  private mobileExists(): ConflictException {
    return new ConflictException({
      code: 'CUSTOMER_MOBILE_EXISTS',
      message: 'An account with this mobile number already exists',
    });
  }

  private mobileOtpCooldown(): HttpException {
    return new HttpException(
      {
        code: 'CUSTOMER_MOBILE_OTP_COOLDOWN',
        message: 'Please wait before requesting another code',
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
