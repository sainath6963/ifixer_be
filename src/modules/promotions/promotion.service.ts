import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { MongoServerError } from 'mongodb';
import { ClientSession, Connection, Error as MongooseError, Model, Types } from 'mongoose';

import { Coupon, CouponDocument, CouponRedemption } from '../../database/schemas/coupon.schema';
import { CouponDiscountType, CouponRedemptionStatus, CouponStatus } from '../../domain/enums';
import { AuthAuditService } from '../admin-auth/auth-audit.service';
import type { AuthenticatedAdmin, AuthRequestContext } from '../admin-auth/auth.types';
import type { CouponListQueryDto, CreateCouponDto, UpdateCouponDto } from './dto/promotion.dto';
import type { AppliedCoupon, CouponPage, CouponView } from './promotion.types';

const MINIMUM_PAYABLE_IN_PAISE = 100;

@Injectable()
export class PromotionService {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(Coupon.name) private readonly coupons: Model<Coupon>,
    @InjectModel(CouponRedemption.name)
    private readonly redemptions: Model<CouponRedemption>,
    private readonly audit: AuthAuditService,
  ) {}

  async create(
    input: CreateCouponDto,
    admin: AuthenticatedAdmin,
    context: AuthRequestContext,
  ): Promise<CouponView> {
    this.assertCreateInput(input);
    const couponId = new Types.ObjectId();
    try {
      const created = await this.connection.transaction(
        async (session): Promise<CouponDocument> => {
          const [document] = await this.coupons.create(
            [
              {
                _id: couponId,
                code: this.normalizeCode(input.code),
                name: input.name.trim(),
                description: input.description?.trim() || undefined,
                status: CouponStatus.Draft,
                discountType: input.discountType,
                percentageOff: input.percentageOff,
                fixedAmountInPaise: input.fixedAmountInPaise,
                maximumDiscountInPaise: input.maximumDiscountInPaise,
                minimumSubtotalInPaise: input.minimumSubtotalInPaise,
                usageLimit: input.usageLimit,
                reservedCount: 0,
                redeemedCount: 0,
                startsAt: new Date(input.startsAt),
                endsAt: new Date(input.endsAt),
                createdBy: new Types.ObjectId(admin.id),
                updatedBy: new Types.ObjectId(admin.id),
              },
            ],
            { session },
          );
          await this.audit.record(
            {
              action: 'COUPON_CREATED',
              resourceType: 'COUPON',
              resourceId: document.id,
              actorId: admin.id,
              context,
              metadata: { code: document.code, status: document.status },
            },
            session,
          );
          return document;
        },
      );
      return this.toView(created);
    } catch (error: unknown) {
      this.rethrowDuplicate(error);
      throw error;
    }
  }

  async list(query: CouponListQueryDto): Promise<CouponPage> {
    const filter: Record<string, unknown> = {};
    if (query.status) filter.status = query.status;
    const search = query.search?.trim();
    if (search) {
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = [
        { code: { $regex: escaped, $options: 'i' } },
        { name: { $regex: escaped, $options: 'i' } },
      ];
    }
    const [documents, total] = await Promise.all([
      this.coupons
        .find(filter)
        .sort({ updatedAt: -1, _id: -1 })
        .skip((query.page - 1) * query.limit)
        .limit(query.limit)
        .exec(),
      this.coupons.countDocuments(filter),
    ]);
    return {
      items: documents.map((document) => this.toView(document)),
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.ceil(total / query.limit),
    };
  }

  async get(id: string): Promise<CouponView> {
    return this.toView(await this.findCoupon(id));
  }

  async update(
    id: string,
    input: UpdateCouponDto,
    admin: AuthenticatedAdmin,
    context: AuthRequestContext,
  ): Promise<CouponView> {
    if (!Types.ObjectId.isValid(id)) throw this.notFound();
    try {
      const updated = await this.connection.transaction(
        async (session): Promise<CouponDocument> => {
          const coupon = await this.coupons.findById(id).session(session).exec();
          if (!coupon) throw this.notFound();
          if (coupon.get('version') !== input.expectedVersion) throw this.versionConflict();
          if (coupon.status === CouponStatus.Archived && input.status !== CouponStatus.Archived) {
            throw new ConflictException({
              code: 'COUPON_ARCHIVED',
              message: 'Archived coupons cannot be reactivated',
            });
          }
          const allocated = coupon.reservedCount + coupon.redeemedCount;
          const changesTerms =
            input.code !== undefined ||
            input.discountType !== undefined ||
            input.percentageOff !== undefined ||
            input.fixedAmountInPaise !== undefined ||
            input.maximumDiscountInPaise !== undefined;
          if (allocated > 0 && changesTerms) {
            throw new ConflictException({
              code: 'COUPON_TERMS_LOCKED',
              message: 'Discount terms cannot change after coupon usage has been allocated',
            });
          }

          if (input.code !== undefined) coupon.code = this.normalizeCode(input.code);
          if (input.name !== undefined) coupon.name = input.name.trim();
          if (input.description !== undefined)
            coupon.description = input.description?.trim() || undefined;
          if (input.status !== undefined) coupon.status = input.status;
          if (input.minimumSubtotalInPaise !== undefined) {
            coupon.minimumSubtotalInPaise = input.minimumSubtotalInPaise;
          }
          if (input.usageLimit !== undefined) coupon.usageLimit = input.usageLimit;
          if (input.startsAt !== undefined) coupon.startsAt = new Date(input.startsAt);
          if (input.endsAt !== undefined) coupon.endsAt = new Date(input.endsAt);

          const nextDiscountType = input.discountType ?? coupon.discountType;
          coupon.discountType = nextDiscountType;
          if (nextDiscountType === CouponDiscountType.Percentage) {
            if (input.percentageOff !== undefined)
              coupon.percentageOff = input.percentageOff ?? undefined;
            coupon.fixedAmountInPaise = undefined;
            if (input.maximumDiscountInPaise !== undefined) {
              coupon.maximumDiscountInPaise = input.maximumDiscountInPaise ?? undefined;
            }
          } else {
            if (input.fixedAmountInPaise !== undefined) {
              coupon.fixedAmountInPaise = input.fixedAmountInPaise ?? undefined;
            }
            coupon.percentageOff = undefined;
            coupon.maximumDiscountInPaise = undefined;
          }
          if (coupon.status === CouponStatus.Active && coupon.endsAt.getTime() <= Date.now()) {
            throw new ConflictException({
              code: 'COUPON_WINDOW_ENDED',
              message: 'Extend the coupon end date before activating it',
            });
          }
          this.assertCouponConfiguration(coupon);
          coupon.updatedBy = new Types.ObjectId(admin.id);
          await coupon.save({ session });
          await this.audit.record(
            {
              action: 'COUPON_UPDATED',
              resourceType: 'COUPON',
              resourceId: coupon.id,
              actorId: admin.id,
              context,
              metadata: { code: coupon.code, status: coupon.status },
            },
            session,
          );
          return coupon;
        },
      );
      return this.toView(updated);
    } catch (error: unknown) {
      this.rethrowDuplicate(error);
      if (error instanceof MongooseError.VersionError) throw this.versionConflict();
      throw error;
    }
  }

  async evaluate(
    customerId: string,
    codeInput: string | undefined,
    subtotalInPaise: number,
    session?: ClientSession,
  ): Promise<AppliedCoupon | undefined> {
    if (!codeInput?.trim()) return undefined;
    const code = this.normalizeCode(codeInput);
    const query = this.coupons.findOne({ code });
    if (session) query.session(session);
    const coupon = await query.exec();
    if (!coupon) throw this.unavailable('Coupon code is invalid');
    await this.assertEligible(coupon, customerId, subtotalInPaise, session);
    return this.appliedCoupon(coupon, subtotalInPaise);
  }

  async reserve(
    orderId: Types.ObjectId,
    customerId: Types.ObjectId,
    codeInput: string | undefined,
    subtotalInPaise: number,
    expiresAt: Date,
    session: ClientSession,
  ): Promise<AppliedCoupon | undefined> {
    const applied = await this.evaluate(
      customerId.toHexString(),
      codeInput,
      subtotalInPaise,
      session,
    );
    if (!applied) return undefined;
    const now = new Date();
    const couponId = new Types.ObjectId(applied.couponId);
    const allocated = await this.coupons.updateOne(
      {
        _id: couponId,
        status: CouponStatus.Active,
        startsAt: { $lte: now },
        endsAt: { $gt: now },
        minimumSubtotalInPaise: { $lte: subtotalInPaise },
        $expr: { $lt: [{ $add: ['$reservedCount', '$redeemedCount'] }, '$usageLimit'] },
      },
      { $inc: { reservedCount: 1 } },
      { session },
    );
    if (allocated.modifiedCount !== 1) {
      throw this.unavailable('Coupon is no longer available');
    }
    try {
      await this.redemptions.create(
        [
          {
            couponId,
            customerId,
            orderId,
            code: applied.code,
            status: CouponRedemptionStatus.Reserved,
            active: true,
            discountInPaise: applied.discountInPaise,
            reservedAt: now,
            expiresAt,
          },
        ],
        { session },
      );
    } catch (error: unknown) {
      if (error instanceof MongoServerError && error.code === 11000) {
        throw new ConflictException({
          code: 'COUPON_ALREADY_USED',
          message: 'This coupon is limited to one use per customer',
        });
      }
      throw error;
    }
    return applied;
  }

  async redeemOrder(orderId: Types.ObjectId, session: ClientSession): Promise<void> {
    const redemption = await this.redemptions
      .findOne({ orderId, status: CouponRedemptionStatus.Reserved })
      .session(session)
      .exec();
    if (!redemption) return;
    const count = await this.coupons.updateOne(
      { _id: redemption.couponId, reservedCount: { $gte: 1 } },
      { $inc: { reservedCount: -1, redeemedCount: 1 } },
      { session },
    );
    if (count.modifiedCount !== 1) throw new Error('Coupon redemption counter invariant failed');
    redemption.status = CouponRedemptionStatus.Redeemed;
    redemption.finalizedAt = new Date();
    await redemption.save({ session });
  }

  async releaseOrder(orderId: Types.ObjectId, session: ClientSession): Promise<void> {
    const redemption = await this.redemptions
      .findOne({ orderId, status: CouponRedemptionStatus.Reserved })
      .session(session)
      .exec();
    if (!redemption) return;
    const count = await this.coupons.updateOne(
      { _id: redemption.couponId, reservedCount: { $gte: 1 } },
      { $inc: { reservedCount: -1 } },
      { session },
    );
    if (count.modifiedCount !== 1) throw new Error('Coupon release counter invariant failed');
    redemption.status = CouponRedemptionStatus.Released;
    redemption.active = false;
    redemption.finalizedAt = new Date();
    await redemption.save({ session });
  }

  private async assertEligible(
    coupon: CouponDocument,
    customerId: string,
    subtotalInPaise: number,
    session?: ClientSession,
  ): Promise<void> {
    const now = Date.now();
    if (
      coupon.status !== CouponStatus.Active ||
      coupon.startsAt.getTime() > now ||
      coupon.endsAt.getTime() <= now
    ) {
      throw this.unavailable('Coupon is not active for this checkout');
    }
    if (subtotalInPaise < coupon.minimumSubtotalInPaise) {
      throw new ConflictException({
        code: 'COUPON_MINIMUM_NOT_MET',
        message: `Coupon requires a subtotal of at least ₹${(
          coupon.minimumSubtotalInPaise / 100
        ).toLocaleString('en-IN')}`,
      });
    }
    if (coupon.reservedCount + coupon.redeemedCount >= coupon.usageLimit) {
      throw this.unavailable('Coupon usage limit has been reached');
    }
    const usageQuery = this.redemptions.exists({
      couponId: coupon._id,
      customerId: new Types.ObjectId(customerId),
      active: true,
    });
    if (session) usageQuery.session(session);
    if (await usageQuery) {
      throw new ConflictException({
        code: 'COUPON_ALREADY_USED',
        message: 'This coupon is limited to one use per customer',
      });
    }
  }

  private appliedCoupon(coupon: CouponDocument, subtotalInPaise: number): AppliedCoupon {
    const rawDiscount =
      coupon.discountType === CouponDiscountType.Percentage
        ? Number((BigInt(subtotalInPaise) * BigInt(coupon.percentageOff ?? 0)) / 100n)
        : (coupon.fixedAmountInPaise ?? 0);
    const cappedDiscount = coupon.maximumDiscountInPaise
      ? Math.min(rawDiscount, coupon.maximumDiscountInPaise)
      : rawDiscount;
    const discountInPaise = Math.min(
      cappedDiscount,
      Math.max(0, subtotalInPaise - MINIMUM_PAYABLE_IN_PAISE),
    );
    if (discountInPaise < 1) {
      throw new ConflictException({
        code: 'COUPON_NO_DISCOUNT',
        message: 'Coupon does not apply a discount to this order',
      });
    }
    return {
      couponId: coupon.id,
      code: coupon.code,
      name: coupon.name,
      discountType: coupon.discountType,
      configuredValue:
        coupon.discountType === CouponDiscountType.Percentage
          ? (coupon.percentageOff ?? 0)
          : (coupon.fixedAmountInPaise ?? 0),
      discountInPaise,
      endsAt: coupon.endsAt,
    };
  }

  private toView(coupon: CouponDocument): CouponView {
    const now = Date.now();
    const used = coupon.reservedCount + coupon.redeemedCount;
    let availability: CouponView['availability'];
    if (coupon.status === CouponStatus.Archived) availability = 'ARCHIVED';
    else if (coupon.status === CouponStatus.Draft) availability = 'DRAFT';
    else if (coupon.status === CouponStatus.Paused) availability = 'PAUSED';
    else if (used >= coupon.usageLimit) availability = 'EXHAUSTED';
    else if (coupon.endsAt.getTime() <= now) availability = 'ENDED';
    else if (coupon.startsAt.getTime() > now) availability = 'SCHEDULED';
    else availability = 'LIVE';
    return {
      id: coupon.id,
      code: coupon.code,
      name: coupon.name,
      description: coupon.description,
      status: coupon.status,
      discountType: coupon.discountType,
      percentageOff: coupon.percentageOff,
      fixedAmountInPaise: coupon.fixedAmountInPaise,
      maximumDiscountInPaise: coupon.maximumDiscountInPaise,
      minimumSubtotalInPaise: coupon.minimumSubtotalInPaise,
      usageLimit: coupon.usageLimit,
      reservedCount: coupon.reservedCount,
      redeemedCount: coupon.redeemedCount,
      remainingUses: Math.max(0, coupon.usageLimit - used),
      startsAt: coupon.startsAt,
      endsAt: coupon.endsAt,
      availability,
      version: coupon.get('version') as number,
      createdAt: coupon.get('createdAt') as Date,
      updatedAt: coupon.get('updatedAt') as Date,
    };
  }

  private async findCoupon(id: string): Promise<CouponDocument> {
    if (!Types.ObjectId.isValid(id)) throw this.notFound();
    const coupon = await this.coupons.findById(id).exec();
    if (!coupon) throw this.notFound();
    return coupon;
  }

  private normalizeCode(code: string): string {
    return code.trim().toUpperCase();
  }

  private assertCreateInput(input: CreateCouponDto): void {
    const startsAt = new Date(input.startsAt);
    const endsAt = new Date(input.endsAt);
    if (startsAt.getTime() >= endsAt.getTime()) {
      throw new BadRequestException({
        code: 'COUPON_WINDOW_INVALID',
        message: 'Coupon end must be after its start',
      });
    }
    if (
      (input.discountType === CouponDiscountType.Percentage &&
        (!input.percentageOff || input.fixedAmountInPaise !== undefined)) ||
      (input.discountType === CouponDiscountType.FixedAmount &&
        (!input.fixedAmountInPaise ||
          input.percentageOff !== undefined ||
          input.maximumDiscountInPaise !== undefined))
    ) {
      throw new BadRequestException({
        code: 'COUPON_DISCOUNT_INVALID',
        message: 'Discount fields do not match the selected coupon type',
      });
    }
  }

  private assertCouponConfiguration(coupon: CouponDocument): void {
    if (coupon.startsAt.getTime() >= coupon.endsAt.getTime()) {
      throw new BadRequestException({
        code: 'COUPON_WINDOW_INVALID',
        message: 'Coupon end must be after its start',
      });
    }
    if (coupon.reservedCount + coupon.redeemedCount > coupon.usageLimit) {
      throw new ConflictException({
        code: 'COUPON_USAGE_LIMIT_INVALID',
        message: 'Usage limit cannot be lower than current allocated usage',
      });
    }
    if (
      (coupon.discountType === CouponDiscountType.Percentage &&
        (!coupon.percentageOff || coupon.fixedAmountInPaise !== undefined)) ||
      (coupon.discountType === CouponDiscountType.FixedAmount &&
        (!coupon.fixedAmountInPaise ||
          coupon.percentageOff !== undefined ||
          coupon.maximumDiscountInPaise !== undefined))
    ) {
      throw new BadRequestException({
        code: 'COUPON_DISCOUNT_INVALID',
        message: 'Discount fields do not match the selected coupon type',
      });
    }
  }

  private unavailable(message: string): ConflictException {
    return new ConflictException({ code: 'COUPON_NOT_AVAILABLE', message });
  }

  private notFound(): NotFoundException {
    return new NotFoundException({ code: 'COUPON_NOT_FOUND', message: 'Coupon was not found' });
  }

  private versionConflict(): ConflictException {
    return new ConflictException({
      code: 'COUPON_VERSION_CONFLICT',
      message: 'Coupon changed after it was loaded; refresh and retry',
    });
  }

  private rethrowDuplicate(error: unknown): void {
    if (error instanceof MongoServerError && error.code === 11000) {
      throw new ConflictException({
        code: 'COUPON_CODE_CONFLICT',
        message: 'Coupon code already exists',
      });
    }
  }
}
