import { deleteModel, Error as MongooseError, model, Types } from 'mongoose';

import { Product, ProductSchema } from './catalog.schema';
import { Cart, CartSchema } from './cart.schema';
import { Coupon, CouponRedemption, CouponRedemptionSchema, CouponSchema } from './coupon.schema';
import {
  Customer,
  CustomerMobileChallenge,
  CustomerMobileChallengeSchema,
  CustomerSchema,
  type SavedAddress,
} from './identity.schema';
import {
  InventoryLevel,
  InventoryLevelSchema,
  InventoryReservation,
  InventoryReservationSchema,
} from './inventory.schema';
import { Order, OrderSchema } from './order.schema';
import {
  ProductReview,
  ProductReviewSchema,
  ProductReviewSummary,
  ProductReviewSummarySchema,
} from './product-review.schema';
import { StockAlert, StockAlertSchema } from './wishlist.schema';

const ProductValidationModel = model<Product>('ProductValidationTest', ProductSchema.clone());
const InventoryValidationModel = model<InventoryLevel>(
  'InventoryValidationTest',
  InventoryLevelSchema.clone(),
);
const ReservationValidationModel = model<InventoryReservation>(
  'ReservationValidationTest',
  InventoryReservationSchema.clone(),
);
const OrderValidationModel = model<Order>('OrderValidationTest', OrderSchema.clone());
const CartValidationModel = model<Cart>('CartValidationTest', CartSchema.clone());
const CustomerValidationModel = model<Customer>('CustomerValidationTest', CustomerSchema.clone());
const CustomerMobileChallengeValidationModel = model<CustomerMobileChallenge>(
  'CustomerMobileChallengeValidationTest',
  CustomerMobileChallengeSchema.clone(),
);
const CouponValidationModel = model<Coupon>('CouponValidationTest', CouponSchema.clone());
const CouponRedemptionValidationModel = model<CouponRedemption>(
  'CouponRedemptionValidationTest',
  CouponRedemptionSchema.clone(),
);
const ProductReviewValidationModel = model<ProductReview>(
  'ProductReviewValidationTest',
  ProductReviewSchema.clone(),
);
const ProductReviewSummaryValidationModel = model<ProductReviewSummary>(
  'ProductReviewSummaryValidationTest',
  ProductReviewSummarySchema.clone(),
);
const StockAlertValidationModel = model<StockAlert>(
  'StockAlertValidationTest',
  StockAlertSchema.clone(),
);

async function captureValidationError(
  validation: Promise<unknown>,
): Promise<MongooseError.ValidationError> {
  try {
    await validation;
  } catch (error: unknown) {
    if (error instanceof MongooseError.ValidationError) {
      return error;
    }
    throw error;
  }

  throw new Error('Expected Mongoose validation to fail');
}

describe('core commerce schema invariants', () => {
  afterAll(() => {
    deleteModel(ProductValidationModel.modelName);
    deleteModel(InventoryValidationModel.modelName);
    deleteModel(ReservationValidationModel.modelName);
    deleteModel(OrderValidationModel.modelName);
    deleteModel(CartValidationModel.modelName);
    deleteModel(CustomerValidationModel.modelName);
    deleteModel(CustomerMobileChallengeValidationModel.modelName);
    deleteModel(CouponValidationModel.modelName);
    deleteModel(CouponRedemptionValidationModel.modelName);
    deleteModel(ProductReviewValidationModel.modelName);
    deleteModel(ProductReviewSummaryValidationModel.modelName);
    deleteModel(StockAlertValidationModel.modelName);
  });

  it('rejects duplicate product variant SKUs and attribute combinations', async () => {
    const product = new ProductValidationModel({
      name: 'Validation Product',
      slug: 'validation-product',
      description: 'Validates embedded product variant invariants.',
      variants: [
        {
          sku: 'RC-TEST-S',
          title: 'Small',
          attributes: [{ name: 'size', value: 'S' }],
          priceInPaise: 10000,
        },
        {
          sku: 'rc-test-s',
          title: 'Small duplicate',
          attributes: [{ name: 'size', value: 'S' }],
          priceInPaise: 10000,
        },
      ],
    });

    const error = await captureValidationError(product.validate());
    expect(error.errors.variants.message).toContain('unique');
  });

  it('rejects reserved inventory greater than on-hand inventory', async () => {
    const inventory = new InventoryValidationModel({
      productId: new Types.ObjectId(),
      variantId: new Types.ObjectId(),
      sku: 'RC-STOCK-TEST',
      onHand: 5,
      reserved: 6,
      sold: 0,
    });

    const error = await captureValidationError(inventory.validate());
    expect(error.errors.reserved.message).toBe('Reserved stock cannot exceed on-hand stock');
  });

  it('isolates checkout and exchange reservation ownership', async () => {
    const reservation = new ReservationValidationModel({
      reservationGroupId: `exchange:${new Types.ObjectId().toHexString()}`,
      orderId: new Types.ObjectId(),
      returnRequestId: new Types.ObjectId(),
      productId: new Types.ObjectId(),
      variantId: new Types.ObjectId(),
      quantity: 1,
      expiresAt: new Date(Date.now() + 60_000),
    });

    const error = await captureValidationError(reservation.validate());
    expect(error.errors.orderId.message).toContain('exactly one');
  });

  it('rejects inconsistent order subtotal, line total, and grand total', async () => {
    const productId = new Types.ObjectId();
    const variantId = new Types.ObjectId();
    const order = new OrderValidationModel({
      orderNumber: 'RC-TEST-0001',
      idempotencyKey: 'phase2-order-validation',
      customer: { name: 'Test Customer', mobile: '+919999999999' },
      shippingAddress: {
        fullName: 'Test Customer',
        phone: '+919999999999',
        line1: 'Test address',
        city: 'Pune',
        state: 'Maharashtra',
        postalCode: '411001',
      },
      items: [
        {
          productId,
          variantId,
          productName: 'Test Product',
          productSlug: 'test-product',
          sku: 'RC-ORDER-TEST',
          variantTitle: 'Default',
          unitPriceInPaise: 10000,
          discountInPaise: 500,
          taxInPaise: 0,
          quantity: 2,
          lineTotalInPaise: 20000,
        },
      ],
      totals: {
        subtotalInPaise: 19000,
        itemDiscountInPaise: 500,
        couponDiscountInPaise: 0,
        shippingInPaise: 0,
        taxInPaise: 0,
        grandTotalInPaise: 20000,
      },
      paymentExpiresAt: new Date(Date.now() + 15 * 60 * 1000),
    });

    const error = await captureValidationError(order.validate());
    expect(error.errors['totals.subtotalInPaise']).toBeDefined();
    expect(error.errors['totals.grandTotalInPaise']).toBeDefined();
    expect(error.errors['items.0.lineTotalInPaise']).toBeDefined();
  });

  it('rejects conflicting coupon terms and redemption active markers', async () => {
    const adminId = new Types.ObjectId();
    const coupon = new CouponValidationModel({
      code: 'SCHEMA10',
      name: 'Schema coupon',
      status: 'ACTIVE',
      discountType: 'PERCENTAGE',
      percentageOff: 10,
      fixedAmountInPaise: 1_000,
      minimumSubtotalInPaise: 0,
      usageLimit: 10,
      startsAt: new Date(Date.now() - 60_000),
      endsAt: new Date(Date.now() + 60_000),
      createdBy: adminId,
      updatedBy: adminId,
    });
    const couponError = await captureValidationError(coupon.validate());
    expect(couponError.errors.discountType.message).toContain('only percentageOff');

    const redemption = new CouponRedemptionValidationModel({
      couponId: new Types.ObjectId(),
      customerId: new Types.ObjectId(),
      orderId: new Types.ObjectId(),
      code: 'SCHEMA10',
      status: 'RELEASED',
      active: true,
      discountInPaise: 1_000,
      reservedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      finalizedAt: new Date(),
    });
    const redemptionError = await captureValidationError(redemption.validate());
    expect(redemptionError.errors.active.message).toContain('does not match');
  });

  it('requires one cart identity and unique product variants', async () => {
    const productId = new Types.ObjectId();
    const variantId = new Types.ObjectId();
    const cart = new CartValidationModel({
      customerId: new Types.ObjectId(),
      guestTokenHash: 'a'.repeat(64),
      items: [
        { productId, variantId, quantity: 1 },
        { productId, variantId, quantity: 2 },
      ],
      expiresAt: new Date(Date.now() + 60_000),
    });

    const error = await captureValidationError(cart.validate());
    expect(error.errors.customerId.message).toContain('exactly one');
    expect(error.errors.items.message).toContain('unique');
  });

  it('requires exactly one default in a bounded customer address book', async () => {
    const address = (index: number): SavedAddress => ({
      addressId: new Types.ObjectId(),
      label: `Address ${index}`,
      fullName: 'Schema Customer',
      phone: '+919999999999',
      line1: `${index} Test Street`,
      city: 'Pune',
      state: 'Maharashtra',
      postalCode: '411001',
      countryCode: 'IN',
      isDefault: false,
    });
    const customer = new CustomerValidationModel({
      name: 'Schema Customer',
      email: 'schema-addresses@richculture.test',
      addresses: Array.from({ length: 11 }, (_, index) => address(index)),
    });

    const error = await captureValidationError(customer.validate());
    expect(error.errors.addresses.message).toContain('at most 10');
  });

  it('defaults customer communication consent safely and never selects mobile codes', async () => {
    const customer = new CustomerValidationModel({
      name: 'Preference Customer',
      email: 'preferences@richculture.test',
      addresses: [],
    });
    await expect(customer.validate()).resolves.toBeUndefined();
    expect(customer.communicationPreferences).toMatchObject({
      marketingEmail: false,
      backInStockEmail: true,
      orderUpdatesSms: false,
      orderUpdatesWhatsapp: false,
    });

    const codePath = CustomerMobileChallengeSchema.path('codeHash');
    expect(codePath.options.select).toBe(false);
    const challenge = new CustomerMobileChallengeValidationModel({
      customerId: new Types.ObjectId(),
      targetMobile: '+919999999999',
      codeHash: 'not-a-plaintext-code',
      expiresAt: new Date(Date.now() + 60_000),
    });
    const error = await captureValidationError(challenge.validate());
    expect(error.errors.codeHash).toBeDefined();

    const inconsistent = new CustomerMobileChallengeValidationModel({
      customerId: new Types.ObjectId(),
      targetMobile: '+919999999998',
      codeHash: 'a'.repeat(64),
      expiresAt: new Date(Date.now() + 60_000),
      active: false,
    });
    const stateError = await captureValidationError(inconsistent.validate());
    expect(stateError.errors.active.message).toContain('inconsistent');
  });

  it('rejects invalid product-review moderation and summary states', async () => {
    const review = new ProductReviewValidationModel({
      productId: new Types.ObjectId(),
      customerId: new Types.ObjectId(),
      orderId: new Types.ObjectId(),
      orderNumber: 'RC-TEST-REVIEW',
      productName: 'Review Product',
      productSlug: 'review-product',
      displayName: 'Asha K.',
      rating: 5,
      title: 'Excellent piece',
      body: 'The finish and fit are both excellent.',
      status: 'PUBLISHED',
    });
    const reviewError = await captureValidationError(review.validate());
    expect(reviewError.errors.status.message).toContain('moderation metadata');

    const summary = new ProductReviewSummaryValidationModel({
      productId: new Types.ObjectId(),
      reviewCount: 2,
      ratingTotal: 11,
    });
    const summaryError = await captureValidationError(summary.validate());
    expect(summaryError.errors.ratingTotal.message).toContain('inconsistent');
  });

  it('rejects inconsistent active and terminal stock-alert states', async () => {
    const alert = new StockAlertValidationModel({
      customerId: new Types.ObjectId(),
      productId: new Types.ObjectId(),
      variantId: new Types.ObjectId(),
      productName: 'Stock Alert Product',
      productSlug: 'stock-alert-product',
      variantTitle: 'Medium',
      sku: 'STOCK-ALERT-M',
      status: 'NOTIFIED',
      active: true,
      requestedAt: new Date(),
    });
    const error = await captureValidationError(alert.validate());
    expect(error.errors.status.message).toContain('inconsistent');
  });
});
