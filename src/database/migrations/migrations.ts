import { instagramReelsMigration } from './027-instagram-reels';
import { repairBillingMigration } from './026-repair-billing';
import { repairInventoryMigration } from './025-repair-inventory';
import { repairJobsMigration } from './024-repair-jobs';
import { createCoreCollectionsMigration } from './001-create-core-collections';
import { applyCriticalValidatorsMigration } from './002-apply-critical-validators';
import { adminAuthConstraintsMigration } from './003-admin-auth-constraints';
import { catalogMediaConstraintsMigration } from './004-catalog-media-constraints';
import { storefrontCatalogIndexesMigration } from './005-storefront-catalog-indexes';
import { customerAuthCartConstraintsMigration } from './006-customer-auth-cart-constraints';
import { checkoutOrderReservationConstraintsMigration } from './007-checkout-order-reservation-constraints';
import { razorpayPaymentConstraintsMigration } from './008-razorpay-payment-constraints';
import { adminOrderRefundOperationsMigration } from './009-admin-order-refund-operations';
import { reliableNotificationOutboxMigration } from './010-reliable-notification-outbox';
import { customerSavedAddressesMigration } from './011-customer-saved-addresses';
import { customerAccountRecoveryMigration } from './012-customer-account-recovery';
import { returnExchangeRequestsMigration } from './013-return-exchange-requests';
import { returnEvidenceNotificationsMigration } from './014-return-evidence-notifications';
import { exchangeStockReservationsMigration } from './015-exchange-stock-reservations';
import { couponPromotionsMigration } from './016-coupon-promotions';
import { verifiedProductReviewsMigration } from './017-verified-product-reviews';
import { wishlistStockAlertsMigration } from './018-wishlist-stock-alerts';
import { customerProfileManagementMigration } from './019-customer-profile-management';
import { adminBusinessAnalyticsMigration } from './020-admin-business-analytics';
import { shipmentTrackingMigration } from './021-shipment-tracking';
import { mobileCommunicationChannelsMigration } from './022-mobile-communication-channels';
import type { DatabaseMigration } from './migration';
import { repairCatalogBookingsMigration } from './023-repair-catalog-bookings';

export const databaseMigrations: DatabaseMigration[] = [
  createCoreCollectionsMigration,
  applyCriticalValidatorsMigration,
  adminAuthConstraintsMigration,
  catalogMediaConstraintsMigration,
  storefrontCatalogIndexesMigration,
  customerAuthCartConstraintsMigration,
  checkoutOrderReservationConstraintsMigration,
  razorpayPaymentConstraintsMigration,
  adminOrderRefundOperationsMigration,
  reliableNotificationOutboxMigration,
  customerSavedAddressesMigration,
  customerAccountRecoveryMigration,
  returnExchangeRequestsMigration,
  returnEvidenceNotificationsMigration,
  exchangeStockReservationsMigration,
  couponPromotionsMigration,
  verifiedProductReviewsMigration,
  wishlistStockAlertsMigration,
  customerProfileManagementMigration,
  adminBusinessAnalyticsMigration,
  shipmentTrackingMigration,
  mobileCommunicationChannelsMigration,
  repairCatalogBookingsMigration,
  repairJobsMigration,
  repairInventoryMigration,
  repairBillingMigration,
  instagramReelsMigration,
];
