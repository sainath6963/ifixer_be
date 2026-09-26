export enum AccountStatus {
  Active = 'ACTIVE',
  Disabled = 'DISABLED',
}

export enum CustomerActionPurpose {
  EmailVerification = 'EMAIL_VERIFICATION',
  EmailChange = 'EMAIL_CHANGE',
  PasswordReset = 'PASSWORD_RESET',
}

export enum AdminRole {
  Reception = 'RECEPTION',
  Technician = 'TECHNICIAN',
  Owner = 'OWNER',
  Staff = 'STAFF',
}

export enum ProductStatus {
  Draft = 'DRAFT',
  Active = 'ACTIVE',
  Archived = 'ARCHIVED',
}

export enum MediaStatus {
  Pending = 'PENDING',
  Ready = 'READY',
  Deleted = 'DELETED',
}

export enum StorageProvider {
  Local = 'LOCAL',
}

export enum InventoryReservationStatus {
  Active = 'ACTIVE',
  Committed = 'COMMITTED',
  Released = 'RELEASED',
  Expired = 'EXPIRED',
}

export enum InventoryMovementType {
  Repair = 'REPAIR',
  Restock = 'RESTOCK',
  Reserve = 'RESERVE',
  Release = 'RELEASE',
  Sale = 'SALE',
  Adjustment = 'ADJUSTMENT',
  Return = 'RETURN',
}

export enum CartStatus {
  Active = 'ACTIVE',
  Converted = 'CONVERTED',
  Abandoned = 'ABANDONED',
}

export enum CouponStatus {
  Draft = 'DRAFT',
  Active = 'ACTIVE',
  Paused = 'PAUSED',
  Archived = 'ARCHIVED',
}

export enum CouponDiscountType {
  Percentage = 'PERCENTAGE',
  FixedAmount = 'FIXED_AMOUNT',
}

export enum CouponRedemptionStatus {
  Reserved = 'RESERVED',
  Redeemed = 'REDEEMED',
  Released = 'RELEASED',
}

export enum ProductReviewStatus {
  Pending = 'PENDING',
  Published = 'PUBLISHED',
  Rejected = 'REJECTED',
  Withdrawn = 'WITHDRAWN',
}

export enum StockAlertStatus {
  Active = 'ACTIVE',
  Notified = 'NOTIFIED',
  Cancelled = 'CANCELLED',
}

export enum OrderLifecycleStatus {
  PendingPayment = 'PENDING_PAYMENT',
  Confirmed = 'CONFIRMED',
  Cancelled = 'CANCELLED',
  Expired = 'EXPIRED',
  Completed = 'COMPLETED',
}

export enum FinancialStatus {
  Unpaid = 'UNPAID',
  Pending = 'PENDING',
  Paid = 'PAID',
  PartiallyRefunded = 'PARTIALLY_REFUNDED',
  Refunded = 'REFUNDED',
  Failed = 'FAILED',
}

export enum FulfillmentStatus {
  Unfulfilled = 'UNFULFILLED',
  Processing = 'PROCESSING',
  Shipped = 'SHIPPED',
  Delivered = 'DELIVERED',
  Cancelled = 'CANCELLED',
  Returned = 'RETURNED',
}

export enum ShippingProvider {
  Manual = 'MANUAL',
}

export enum ShipmentStatus {
  ReadyToShip = 'READY_TO_SHIP',
  InTransit = 'IN_TRANSIT',
  OutForDelivery = 'OUT_FOR_DELIVERY',
  DeliveryException = 'DELIVERY_EXCEPTION',
  Delivered = 'DELIVERED',
}

export enum PaymentProvider {
  Razorpay = 'RAZORPAY',
}

export enum PaymentAttemptStatus {
  Creating = 'CREATING',
  Created = 'CREATED',
  Authorized = 'AUTHORIZED',
  Captured = 'CAPTURED',
  Failed = 'FAILED',
  Cancelled = 'CANCELLED',
}

export enum RefundStatus {
  Pending = 'PENDING',
  Processing = 'PROCESSING',
  Succeeded = 'SUCCEEDED',
  Failed = 'FAILED',
}

export enum ReturnRequestType {
  Return = 'RETURN',
  Exchange = 'EXCHANGE',
}

export enum ReturnRequestStatus {
  Requested = 'REQUESTED',
  Approved = 'APPROVED',
  Rejected = 'REJECTED',
  Cancelled = 'CANCELLED',
  Received = 'RECEIVED',
  Completed = 'COMPLETED',
  Expired = 'EXPIRED',
}

export enum ExchangeReservationStatus {
  Active = 'ACTIVE',
  Committed = 'COMMITTED',
  Expired = 'EXPIRED',
}

export enum ReturnReason {
  SizeIssue = 'SIZE_ISSUE',
  Damaged = 'DAMAGED',
  WrongItem = 'WRONG_ITEM',
  QualityIssue = 'QUALITY_ISSUE',
  ChangedMind = 'CHANGED_MIND',
  Other = 'OTHER',
}

export enum ReturnResolutionType {
  Refund = 'REFUND',
  Exchange = 'EXCHANGE',
}

export enum ReturnEvidenceStatus {
  Pending = 'PENDING',
  Ready = 'READY',
  Deleted = 'DELETED',
}

export enum WebhookStatus {
  Received = 'RECEIVED',
  Processing = 'PROCESSING',
  Processed = 'PROCESSED',
  Failed = 'FAILED',
  Ignored = 'IGNORED',
}

export enum OutboxStatus {
  Pending = 'PENDING',
  Processing = 'PROCESSING',
  Published = 'PUBLISHED',
  Failed = 'FAILED',
  Dead = 'DEAD',
}

export enum NotificationChannel {
  Email = 'EMAIL',
  Sms = 'SMS',
  WhatsApp = 'WHATSAPP',
}

export enum NotificationStatus {
  Pending = 'PENDING',
  Processing = 'PROCESSING',
  Sent = 'SENT',
  Failed = 'FAILED',
  Dead = 'DEAD',
}

export enum AuditActorType {
  Admin = 'ADMIN',
  Customer = 'CUSTOMER',
  System = 'SYSTEM',
}
