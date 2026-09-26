import type {
  CouponDiscountType,
  FinancialStatus,
  FulfillmentStatus,
  OrderLifecycleStatus,
  PaymentAttemptStatus,
  PaymentProvider,
  RefundStatus,
  ShipmentStatus,
  ShippingProvider,
} from '../../domain/enums';

export interface AdminShippingView {
  provider: ShippingProvider;
  status: ShipmentStatus;
  courierName: string;
  trackingNumber: string;
  trackingUrl?: string;
  serviceLevel?: string;
  estimatedDeliveryAt?: Date;
  trackingEvents: Array<{
    status: ShipmentStatus;
    message: string;
    location?: string;
    actorType: string;
    occurredAt: Date;
  }>;
  lastEventAt: Date;
  shippedAt?: Date;
  deliveredAt?: Date;
}

export interface AdminOrderListItemView {
  id: string;
  orderNumber: string;
  customer: { name?: string; email?: string; mobile?: string };
  grandTotalInPaise: number;
  currency: 'INR';
  lifecycleStatus: OrderLifecycleStatus;
  financialStatus: FinancialStatus;
  fulfillmentStatus: FulfillmentStatus;
  shipping?: AdminShippingView;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface AdminPaymentView {
  id: string;
  provider: PaymentProvider;
  status: PaymentAttemptStatus;
  amountInPaise: number;
  currency: 'INR';
  providerOrderId?: string;
  providerPaymentId?: string;
  signatureVerified: boolean;
  refundedInPaise: number;
  refundPendingInPaise: number;
  capturedAt?: Date;
  failureCode?: string;
  failureDescription?: string;
}

export interface AdminRefundView {
  id: string;
  refundNumber: string;
  provider: PaymentProvider;
  status: RefundStatus;
  amountInPaise: number;
  currency: 'INR';
  providerRefundId?: string;
  acquirerReference?: string;
  reason: string;
  requestedBy: string;
  failureCode?: string;
  failureDescription?: string;
  processedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface AdminOrderDetailView extends AdminOrderListItemView {
  shippingAddress: {
    fullName: string;
    phone: string;
    line1: string;
    line2?: string;
    city: string;
    state: string;
    postalCode: string;
    countryCode: string;
  };
  items: Array<{
    productId: string;
    variantId: string;
    productName: string;
    productSlug: string;
    sku: string;
    variantTitle: string;
    attributes: Array<{ name: string; value: string }>;
    unitPriceInPaise: number;
    discountInPaise: number;
    taxInPaise: number;
    quantity: number;
    lineTotalInPaise: number;
  }>;
  totals: {
    subtotalInPaise: number;
    itemDiscountInPaise: number;
    couponDiscountInPaise: number;
    shippingInPaise: number;
    taxInPaise: number;
    grandTotalInPaise: number;
  };
  coupon?: {
    code: string;
    name: string;
    discountType: CouponDiscountType;
    configuredValue: number;
    discountInPaise: number;
  };
  statusHistory: Array<{
    dimension: string;
    from?: string;
    to: string;
    reason?: string;
    actorType: string;
    actorId?: string;
    occurredAt: Date;
  }>;
  adminNote?: string;
  payment?: AdminPaymentView;
  refunds: AdminRefundView[];
}

export interface AdminOrderPage {
  items: AdminOrderListItemView[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface OrderOperationsSummary {
  generatedAt: Date;
  orders: {
    pendingPayment: number;
    paidUnfulfilled: number;
    processing: number;
    shipped: number;
    delivered: number;
  };
  refunds: { pending: number; failed: number };
  alerts: { lateCapturedNeedsRefund: number; deliveryExceptions: number };
}
