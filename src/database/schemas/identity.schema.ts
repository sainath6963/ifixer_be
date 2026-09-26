import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';

import { embeddedSchemaOptions, rootSchemaOptions } from '../schema-options';
import { isNonNegativeSafeInteger } from '../value-validators';
import { AccountStatus, AdminRole, CustomerActionPurpose } from '../../domain/enums';

@Schema(embeddedSchemaOptions)
export class SavedAddress {
  @Prop({ type: MongooseSchema.Types.ObjectId, default: () => new Types.ObjectId() })
  addressId!: Types.ObjectId;

  @Prop({ required: true, trim: true, maxlength: 50 })
  label!: string;

  @Prop({ required: true, trim: true, maxlength: 120 })
  fullName!: string;

  @Prop({ required: true, trim: true, match: /^\+?[1-9]\d{7,14}$/ })
  phone!: string;

  @Prop({ required: true, trim: true, maxlength: 200 })
  line1!: string;

  @Prop({ trim: true, maxlength: 200 })
  line2?: string;

  @Prop({ required: true, trim: true, maxlength: 100 })
  city!: string;

  @Prop({ required: true, trim: true, maxlength: 100 })
  state!: string;

  @Prop({ required: true, trim: true, match: /^\d{6}$/ })
  postalCode!: string;

  @Prop({ required: true, uppercase: true, minlength: 2, maxlength: 2, default: 'IN' })
  countryCode!: string;

  @Prop({ default: false })
  isDefault!: boolean;
}

export const SavedAddressSchema = SchemaFactory.createForClass(SavedAddress);

function isValidAddressBook(addresses: SavedAddress[]): boolean {
  if (addresses.length > 10) return false;
  const identifiers = new Set(addresses.map((address) => address.addressId.toHexString()));
  const defaultCount = addresses.filter((address) => address.isDefault).length;
  return identifiers.size === addresses.length && defaultCount === (addresses.length ? 1 : 0);
}

@Schema(embeddedSchemaOptions)
export class CustomerCommunicationPreferences {
  @Prop({ required: true, default: false })
  marketingEmail!: boolean;

  @Prop({ required: true, default: true })
  backInStockEmail!: boolean;

  @Prop({ required: true, default: false })
  orderUpdatesSms!: boolean;

  @Prop({ required: true, default: false })
  orderUpdatesWhatsapp!: boolean;
}

export const CustomerCommunicationPreferencesSchema = SchemaFactory.createForClass(
  CustomerCommunicationPreferences,
);

@Schema({ ...rootSchemaOptions, collection: 'admin_users' })
export class AdminUser {
  @Prop({ required: true, trim: true, maxlength: 120 })
  name!: string;

  @Prop({ required: true, trim: true, lowercase: true, maxlength: 254 })
  email!: string;

  @Prop({ required: true, select: false })
  passwordHash!: string;

  @Prop({ type: [String], enum: AdminRole, default: [AdminRole.Staff] })
  roles!: AdminRole[];

  @Prop({ enum: AccountStatus, default: AccountStatus.Active })
  status!: AccountStatus;

  @Prop()
  lastLoginAt?: Date;

  @Prop()
  passwordChangedAt?: Date;
}

export type AdminUserDocument = HydratedDocument<AdminUser>;
export const AdminUserSchema = SchemaFactory.createForClass(AdminUser);
AdminUserSchema.index({ email: 1 }, { unique: true, name: 'uq_admin_users_email' });
AdminUserSchema.index({ status: 1, createdAt: -1 }, { name: 'ix_admin_users_status_created' });

@Schema({ ...rootSchemaOptions, collection: 'admin_sessions' })
export class AdminSession {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: AdminUser.name, required: true })
  adminUserId!: Types.ObjectId;

  @Prop({ required: true, select: false })
  tokenHash!: string;

  @Prop({ type: Number, default: 0, validate: isNonNegativeSafeInteger })
  refreshGeneration!: number;

  @Prop({ required: true })
  expiresAt!: Date;

  @Prop()
  revokedAt?: Date;

  @Prop({ trim: true, maxlength: 160 })
  revokedReason?: string;

  @Prop()
  reuseDetectedAt?: Date;

  @Prop()
  lastUsedAt?: Date;

  @Prop({ maxlength: 128 })
  ipHash?: string;

  @Prop({ maxlength: 500 })
  userAgent?: string;
}

export type AdminSessionDocument = HydratedDocument<AdminSession>;
export const AdminSessionSchema = SchemaFactory.createForClass(AdminSession);
AdminSessionSchema.index({ tokenHash: 1 }, { unique: true, name: 'uq_admin_sessions_token_hash' });
AdminSessionSchema.index(
  { adminUserId: 1, revokedAt: 1 },
  { name: 'ix_admin_sessions_user_revoked' },
);
AdminSessionSchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: 0, name: 'ttl_admin_sessions_expiry' },
);

@Schema({ ...rootSchemaOptions, collection: 'customers' })
export class Customer {
  @Prop({ trim: true, maxlength: 120 })
  name?: string;

  @Prop({ trim: true, lowercase: true, maxlength: 254 })
  email?: string;

  @Prop({ select: false })
  passwordHash?: string;

  @Prop({ trim: true, match: /^\+?[1-9]\d{7,14}$/ })
  mobile?: string;

  @Prop()
  mobileVerifiedAt?: Date;

  @Prop({ enum: AccountStatus, default: AccountStatus.Active })
  status!: AccountStatus;

  @Prop({
    type: [SavedAddressSchema],
    default: [],
    validate: {
      validator: isValidAddressBook,
      message: 'Address book must contain at most 10 unique addresses and exactly one default',
    },
  })
  addresses!: SavedAddress[];

  @Prop({
    type: CustomerCommunicationPreferencesSchema,
    required: true,
    default: () => ({
      marketingEmail: false,
      backInStockEmail: true,
      orderUpdatesSms: false,
      orderUpdatesWhatsapp: false,
    }),
  })
  communicationPreferences!: CustomerCommunicationPreferences;

  @Prop()
  lastOrderAt?: Date;

  @Prop()
  lastLoginAt?: Date;

  @Prop()
  passwordChangedAt?: Date;

  @Prop()
  emailVerifiedAt?: Date;

  @Prop()
  deactivatedAt?: Date;

  @Prop({ trim: true, maxlength: 500 })
  deactivationReason?: string;
}

export type CustomerDocument = HydratedDocument<Customer>;
export const CustomerSchema = SchemaFactory.createForClass(Customer);
CustomerSchema.index(
  { email: 1 },
  {
    unique: true,
    partialFilterExpression: { email: { $type: 'string' } },
    name: 'uq_customers_email_when_present',
  },
);
CustomerSchema.index(
  { mobile: 1 },
  {
    unique: true,
    partialFilterExpression: { mobile: { $type: 'string' } },
    name: 'uq_customers_mobile_when_present',
  },
);
CustomerSchema.index({ status: 1, lastOrderAt: -1 }, { name: 'ix_customers_status_last_order' });
CustomerSchema.index({ status: 1, createdAt: -1 }, { name: 'ix_customers_status_created' });
CustomerSchema.index({ createdAt: 1 }, { name: 'ix_customers_created_analytics' });

@Schema({ ...rootSchemaOptions, collection: 'customer_action_tokens' })
export class CustomerActionToken {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: Customer.name, required: true })
  customerId!: Types.ObjectId;

  @Prop({ enum: CustomerActionPurpose, required: true })
  purpose!: CustomerActionPurpose;

  @Prop({ required: true, select: false, lowercase: true, match: /^[a-f0-9]{64}$/ })
  tokenHash!: string;

  @Prop({ required: true, trim: true, lowercase: true, maxlength: 254 })
  targetEmail!: string;

  @Prop({ required: true })
  expiresAt!: Date;

  @Prop({ required: true, default: true })
  active!: boolean;

  @Prop()
  usedAt?: Date;

  @Prop()
  invalidatedAt?: Date;
}

export type CustomerActionTokenDocument = HydratedDocument<CustomerActionToken>;
export const CustomerActionTokenSchema = SchemaFactory.createForClass(CustomerActionToken);
CustomerActionTokenSchema.index(
  { tokenHash: 1 },
  { unique: true, name: 'uq_customer_action_tokens_hash' },
);

@Schema({ ...rootSchemaOptions, collection: 'customer_mobile_challenges' })
export class CustomerMobileChallenge {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: Customer.name, required: true })
  customerId!: Types.ObjectId;

  @Prop({ required: true, trim: true, match: /^\+?[1-9]\d{7,14}$/ })
  targetMobile!: string;

  @Prop({ required: true, select: false, lowercase: true, match: /^[a-f0-9]{64}$/ })
  codeHash!: string;

  @Prop({ required: true })
  expiresAt!: Date;

  @Prop({ required: true, default: true })
  active!: boolean;

  @Prop({ type: Number, required: true, default: 0, validate: isNonNegativeSafeInteger })
  attempts!: number;

  @Prop()
  usedAt?: Date;

  @Prop()
  invalidatedAt?: Date;
}

export type CustomerMobileChallengeDocument = HydratedDocument<CustomerMobileChallenge>;
export const CustomerMobileChallengeSchema = SchemaFactory.createForClass(CustomerMobileChallenge);
CustomerMobileChallengeSchema.index(
  { customerId: 1 },
  {
    unique: true,
    partialFilterExpression: { active: true },
    name: 'uq_customer_mobile_challenges_active_customer',
  },
);
CustomerMobileChallengeSchema.index(
  { targetMobile: 1, active: 1 },
  { name: 'ix_customer_mobile_challenges_target_active' },
);
CustomerMobileChallengeSchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: 0, name: 'ttl_customer_mobile_challenges_expiry' },
);
CustomerMobileChallengeSchema.pre('validate', function validateMobileChallengeState(): void {
  const terminalCount = Number(Boolean(this.usedAt)) + Number(Boolean(this.invalidatedAt));
  const valid = (this.active && terminalCount === 0) || (!this.active && terminalCount === 1);
  if (!valid) {
    this.invalidate('active', 'Mobile challenge state and terminal timestamps are inconsistent');
  }
});
CustomerActionTokenSchema.index(
  { customerId: 1, purpose: 1, createdAt: -1 },
  { name: 'ix_customer_action_tokens_customer_purpose_created' },
);
CustomerActionTokenSchema.index(
  { customerId: 1, purpose: 1 },
  {
    unique: true,
    partialFilterExpression: { active: true },
    name: 'uq_customer_action_tokens_active_purpose',
  },
);
CustomerActionTokenSchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: 0, name: 'ttl_customer_action_tokens_expiry' },
);

@Schema({ ...rootSchemaOptions, collection: 'customer_sessions' })
export class CustomerSession {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: Customer.name, required: true })
  customerId!: Types.ObjectId;

  @Prop({ required: true, select: false })
  tokenHash!: string;

  @Prop({ type: Number, default: 0, validate: isNonNegativeSafeInteger })
  refreshGeneration!: number;

  @Prop({ required: true })
  expiresAt!: Date;

  @Prop()
  revokedAt?: Date;

  @Prop({ trim: true, maxlength: 160 })
  revokedReason?: string;

  @Prop()
  reuseDetectedAt?: Date;

  @Prop()
  lastUsedAt?: Date;

  @Prop({ maxlength: 128 })
  ipHash?: string;

  @Prop({ maxlength: 500 })
  userAgent?: string;
}

export type CustomerSessionDocument = HydratedDocument<CustomerSession>;
export const CustomerSessionSchema = SchemaFactory.createForClass(CustomerSession);
CustomerSessionSchema.index(
  { tokenHash: 1 },
  { unique: true, name: 'uq_customer_sessions_token_hash' },
);
CustomerSessionSchema.index(
  { customerId: 1, revokedAt: 1 },
  { name: 'ix_customer_sessions_customer_revoked' },
);
CustomerSessionSchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: 0, name: 'ttl_customer_sessions_expiry' },
);
