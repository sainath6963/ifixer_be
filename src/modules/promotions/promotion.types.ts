import type { CouponDiscountType, CouponStatus } from '../../domain/enums';

export interface CouponView {
  id: string;
  code: string;
  name: string;
  description?: string;
  status: CouponStatus;
  discountType: CouponDiscountType;
  percentageOff?: number;
  fixedAmountInPaise?: number;
  maximumDiscountInPaise?: number;
  minimumSubtotalInPaise: number;
  usageLimit: number;
  reservedCount: number;
  redeemedCount: number;
  remainingUses: number;
  startsAt: Date;
  endsAt: Date;
  availability: 'DRAFT' | 'SCHEDULED' | 'LIVE' | 'PAUSED' | 'ENDED' | 'EXHAUSTED' | 'ARCHIVED';
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface CouponPage {
  items: CouponView[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface AppliedCoupon {
  couponId: string;
  code: string;
  name: string;
  discountType: CouponDiscountType;
  configuredValue: number;
  discountInPaise: number;
  endsAt: Date;
}
