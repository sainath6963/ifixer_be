import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';

import { CouponDiscountType, CouponRedemptionStatus, CouponStatus } from '../../domain/enums';
import { rootSchemaOptions } from '../schema-options';
import { isNonNegativeSafeInteger, isPositiveSafeInteger } from '../value-validators';

@Schema({ ...rootSchemaOptions, collection: 'coupons' })
export class Coupon {
  @Prop({ required: true, trim: true, uppercase: true, match: /^[A-Z0-9][A-Z0-9-]{2,31}$/ })
  code!: string;

  @Prop({ required: true, trim: true, maxlength: 120 })
  name!: string;

  @Prop({ trim: true, maxlength: 500 })
  description?: string;

  @Prop({ required: true, enum: CouponStatus, default: CouponStatus.Draft })
  status!: CouponStatus;

  @Prop({ required: true, enum: CouponDiscountType })
  discountType!: CouponDiscountType;

  @Prop({ type: Number, min: 1, max: 90 })
  percentageOff?: number;

  @Prop({ type: Number, validate: isPositiveSafeInteger })
  fixedAmountInPaise?: number;

  @Prop({ type: Number, validate: isPositiveSafeInteger })
  maximumDiscountInPaise?: number;

  @Prop({ type: Number, required: true, default: 0, validate: isNonNegativeSafeInteger })
  minimumSubtotalInPaise!: number;

  @Prop({ type: Number, required: true, validate: isPositiveSafeInteger, max: 1_000_000 })
  usageLimit!: number;

  @Prop({ type: Number, required: true, default: 0, validate: isNonNegativeSafeInteger })
  reservedCount!: number;

  @Prop({ type: Number, required: true, default: 0, validate: isNonNegativeSafeInteger })
  redeemedCount!: number;

  @Prop({ required: true })
  startsAt!: Date;

  @Prop({ required: true })
  endsAt!: Date;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'AdminUser', required: true })
  createdBy!: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'AdminUser', required: true })
  updatedBy!: Types.ObjectId;
}

export type CouponDocument = HydratedDocument<Coupon>;
export const CouponSchema = SchemaFactory.createForClass(Coupon);
CouponSchema.index({ code: 1 }, { unique: true, name: 'uq_coupons_code' });
CouponSchema.index({ status: 1, startsAt: 1, endsAt: 1 }, { name: 'ix_coupons_status_window' });
CouponSchema.index({ updatedAt: -1, _id: -1 }, { name: 'ix_coupons_updated' });
CouponSchema.index({ name: 'text', code: 'text' }, { name: 'tx_coupons_admin_search' });
CouponSchema.pre('validate', function validateCoupon(): void {
  if (this.startsAt.getTime() >= this.endsAt.getTime()) {
    this.invalidate('endsAt', 'Coupon end must be after its start');
  }
  if (this.reservedCount + this.redeemedCount > this.usageLimit) {
    this.invalidate('usageLimit', 'Usage limit cannot be lower than allocated uses');
  }
  if (this.discountType === CouponDiscountType.Percentage) {
    if (!this.percentageOff || this.fixedAmountInPaise !== undefined) {
      this.invalidate('discountType', 'Percentage coupons require only percentageOff');
    }
  } else if (!this.fixedAmountInPaise || this.percentageOff !== undefined) {
    this.invalidate('discountType', 'Fixed coupons require only fixedAmountInPaise');
  }
});

@Schema({ ...rootSchemaOptions, collection: 'coupon_redemptions' })
export class CouponRedemption {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Coupon', required: true })
  couponId!: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Customer', required: true })
  customerId!: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Order', required: true })
  orderId!: Types.ObjectId;

  @Prop({ required: true, trim: true, uppercase: true, maxlength: 32 })
  code!: string;

  @Prop({ required: true, enum: CouponRedemptionStatus })
  status!: CouponRedemptionStatus;

  @Prop({ required: true, default: true })
  active!: boolean;

  @Prop({ type: Number, required: true, validate: isPositiveSafeInteger })
  discountInPaise!: number;

  @Prop({ required: true })
  reservedAt!: Date;

  @Prop({ required: true })
  expiresAt!: Date;

  @Prop()
  finalizedAt?: Date;
}

export type CouponRedemptionDocument = HydratedDocument<CouponRedemption>;
export const CouponRedemptionSchema = SchemaFactory.createForClass(CouponRedemption);
CouponRedemptionSchema.index({ orderId: 1 }, { unique: true, name: 'uq_coupon_redemptions_order' });
CouponRedemptionSchema.index(
  { couponId: 1, customerId: 1 },
  {
    unique: true,
    name: 'uq_coupon_redemptions_customer_active',
    partialFilterExpression: { active: true },
  },
);
CouponRedemptionSchema.index(
  { couponId: 1, status: 1, createdAt: -1 },
  { name: 'ix_coupon_redemptions_coupon_status' },
);
CouponRedemptionSchema.index({ status: 1, expiresAt: 1 }, { name: 'ix_coupon_redemptions_expiry' });
CouponRedemptionSchema.pre('validate', function validateRedemption(): void {
  const shouldBeActive =
    this.status === CouponRedemptionStatus.Reserved ||
    this.status === CouponRedemptionStatus.Redeemed;
  if (this.active !== shouldBeActive) {
    this.invalidate('active', 'Redemption active marker does not match its status');
  }
  if (this.status === CouponRedemptionStatus.Reserved && this.finalizedAt) {
    this.invalidate('finalizedAt', 'Reserved redemption cannot be finalized');
  }
  if (this.status !== CouponRedemptionStatus.Reserved && !this.finalizedAt) {
    this.invalidate('finalizedAt', 'Finalized redemption requires finalizedAt');
  }
});
