import { InstagramReel, InstagramReelSchema } from './schemas/instagram-reel.schema';
import { WebsiteEvent, WebsiteEventSchema } from './schemas/website-event.schema';
import {
  RepairBillingSettings,
  RepairBillingSettingsSchema,
  RepairInvoice,
  RepairInvoiceSchema,
  RepairMoneyEntry,
  RepairMoneyEntrySchema,
  RepairWarranty,
  RepairWarrantySchema,
  RepairBillingOperation,
  RepairBillingOperationSchema,
  RepairBillingSequence,
  RepairBillingSequenceSchema,
} from './schemas/repair-billing.schema';
import {
  SparePartProfile,
  SparePartProfileSchema,
  RepairSupplier,
  RepairSupplierSchema,
  RepairStockLot,
  RepairStockLotSchema,
  RepairPurchase,
  RepairPurchaseSchema,
  RepairGoodsReceipt,
  RepairGoodsReceiptSchema,
  RepairPartUsage,
  RepairPartUsageSchema,
  RepairStockOperation,
  RepairStockOperationSchema,
} from './schemas/repair-inventory.schema';
import {
  RepairJob,
  RepairJobSchema,
  RepairJobPhoto,
  RepairJobPhotoSchema,
} from './schemas/repair-job.schema';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  DeviceBrand,
  DeviceBrandSchema,
  DeviceModel,
  DeviceModelSchema,
  RepairService,
  RepairServiceSchema,
  RepairServiceOption,
  RepairServiceOptionSchema,
  RepairBooking,
  RepairBookingSchema,
} from './schemas/repair.schema';

import {
  Category,
  CategorySchema,
  MediaAsset,
  MediaAssetSchema,
  Product,
  ProductSchema,
} from './schemas/catalog.schema';
import { Cart, CartSchema } from './schemas/cart.schema';
import {
  Coupon,
  CouponRedemption,
  CouponRedemptionSchema,
  CouponSchema,
} from './schemas/coupon.schema';
import {
  AdminSession,
  AdminSessionSchema,
  AdminUser,
  AdminUserSchema,
  Customer,
  CustomerActionToken,
  CustomerActionTokenSchema,
  CustomerMobileChallenge,
  CustomerMobileChallengeSchema,
  CustomerSession,
  CustomerSessionSchema,
  CustomerSchema,
} from './schemas/identity.schema';
import {
  OutboxEvent,
  OutboxEventSchema,
  WebhookEvent,
  WebhookEventSchema,
} from './schemas/integration.schema';
import {
  InventoryLevel,
  InventoryLevelSchema,
  InventoryMovement,
  InventoryMovementSchema,
  InventoryReservation,
  InventoryReservationSchema,
} from './schemas/inventory.schema';
import { Notification, NotificationSchema } from './schemas/notification.schema';
import {
  AuditLog,
  AuditLogSchema,
  StoreSetting,
  StoreSettingSchema,
} from './schemas/operations.schema';
import { Order, OrderSchema } from './schemas/order.schema';
import {
  PaymentAttempt,
  PaymentAttemptSchema,
  Refund,
  RefundSchema,
} from './schemas/payment.schema';
import { ReturnRequest, ReturnRequestSchema } from './schemas/return-request.schema';
import { ReturnEvidence, ReturnEvidenceSchema } from './schemas/return-evidence.schema';
import {
  ProductReview,
  ProductReviewSchema,
  ProductReviewSummary,
  ProductReviewSummarySchema,
} from './schemas/product-review.schema';
import {
  StockAlert,
  StockAlertSchema,
  WishlistItem,
  WishlistItemSchema,
} from './schemas/wishlist.schema';

export const coreModelDefinitions = [
  { name: WebsiteEvent.name, schema: WebsiteEventSchema },
  { name: InstagramReel.name, schema: InstagramReelSchema },
  { name: RepairBillingSettings.name, schema: RepairBillingSettingsSchema },
  { name: RepairInvoice.name, schema: RepairInvoiceSchema },
  { name: RepairMoneyEntry.name, schema: RepairMoneyEntrySchema },
  { name: RepairWarranty.name, schema: RepairWarrantySchema },
  { name: RepairBillingOperation.name, schema: RepairBillingOperationSchema },
  { name: RepairBillingSequence.name, schema: RepairBillingSequenceSchema },

  { name: SparePartProfile.name, schema: SparePartProfileSchema },
  { name: RepairSupplier.name, schema: RepairSupplierSchema },
  { name: RepairStockLot.name, schema: RepairStockLotSchema },
  { name: RepairPurchase.name, schema: RepairPurchaseSchema },
  { name: RepairGoodsReceipt.name, schema: RepairGoodsReceiptSchema },
  { name: RepairPartUsage.name, schema: RepairPartUsageSchema },
  { name: RepairStockOperation.name, schema: RepairStockOperationSchema },

  { name: RepairJob.name, schema: RepairJobSchema },
  { name: RepairJobPhoto.name, schema: RepairJobPhotoSchema },
  { name: DeviceBrand.name, schema: DeviceBrandSchema },
  { name: DeviceModel.name, schema: DeviceModelSchema },
  { name: RepairService.name, schema: RepairServiceSchema },
  { name: RepairServiceOption.name, schema: RepairServiceOptionSchema },
  { name: RepairBooking.name, schema: RepairBookingSchema },
  { name: AdminUser.name, schema: AdminUserSchema },
  { name: AdminSession.name, schema: AdminSessionSchema },
  { name: Customer.name, schema: CustomerSchema },
  { name: CustomerActionToken.name, schema: CustomerActionTokenSchema },
  { name: CustomerMobileChallenge.name, schema: CustomerMobileChallengeSchema },
  { name: CustomerSession.name, schema: CustomerSessionSchema },
  { name: Cart.name, schema: CartSchema },
  { name: Coupon.name, schema: CouponSchema },
  { name: CouponRedemption.name, schema: CouponRedemptionSchema },
  { name: Category.name, schema: CategorySchema },
  { name: Product.name, schema: ProductSchema },
  { name: MediaAsset.name, schema: MediaAssetSchema },
  { name: InventoryLevel.name, schema: InventoryLevelSchema },
  { name: InventoryReservation.name, schema: InventoryReservationSchema },
  { name: InventoryMovement.name, schema: InventoryMovementSchema },
  { name: Order.name, schema: OrderSchema },
  { name: PaymentAttempt.name, schema: PaymentAttemptSchema },
  { name: Refund.name, schema: RefundSchema },
  { name: ReturnRequest.name, schema: ReturnRequestSchema },
  { name: ReturnEvidence.name, schema: ReturnEvidenceSchema },
  { name: ProductReview.name, schema: ProductReviewSchema },
  { name: ProductReviewSummary.name, schema: ProductReviewSummarySchema },
  { name: WishlistItem.name, schema: WishlistItemSchema },
  { name: StockAlert.name, schema: StockAlertSchema },
  { name: WebhookEvent.name, schema: WebhookEventSchema },
  { name: OutboxEvent.name, schema: OutboxEventSchema },
  { name: Notification.name, schema: NotificationSchema },
  { name: StoreSetting.name, schema: StoreSettingSchema },
  { name: AuditLog.name, schema: AuditLogSchema },
];

@Module({
  imports: [MongooseModule.forFeature(coreModelDefinitions)],
  exports: [MongooseModule],
})
export class CorePersistenceModule {}
