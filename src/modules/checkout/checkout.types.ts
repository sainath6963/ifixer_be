import type {
  CouponDiscountType,
  FinancialStatus,
  FulfillmentStatus,
  OrderLifecycleStatus,
  ShipmentStatus,
  ShippingProvider,
} from '../../domain/enums';
import type { CartView } from '../customer/cart.types';

export interface ShippingAddressView {
  fullName: string;
  phone: string;
  line1: string;
  line2?: string;
  city: string;
  state: string;
  postalCode: string;
  countryCode: 'IN';
}

export interface CheckoutPreview {
  cart: CartView;
  shippingAddress: ShippingAddressView;
  totals: {
    subtotalInPaise: number;
    itemDiscountInPaise: number;
    couponDiscountInPaise: number;
    shippingInPaise: number;
    taxInPaise: number;
    grandTotalInPaise: number;
    currency: 'INR';
  };
  coupon?: CouponView;
  reservationMinutes: number;
  readyToCreateOrder: boolean;
}

export interface CouponView {
  code: string;
  name: string;
  discountType: CouponDiscountType;
  configuredValue: number;
  discountInPaise: number;
  endsAt: Date;
}

export interface CustomerOrderItemView {
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
}

export interface CustomerOrderView {
  id: string;
  orderNumber: string;
  customer: { name?: string; email?: string; mobile?: string };
  shippingAddress: ShippingAddressView;
  items: CustomerOrderItemView[];
  totals: {
    subtotalInPaise: number;
    itemDiscountInPaise: number;
    couponDiscountInPaise: number;
    shippingInPaise: number;
    taxInPaise: number;
    grandTotalInPaise: number;
  };
  coupon?: Omit<CouponView, 'endsAt'>;
  currency: 'INR';
  lifecycleStatus: OrderLifecycleStatus;
  financialStatus: FinancialStatus;
  fulfillmentStatus: FulfillmentStatus;
  shipping?: {
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
      occurredAt: Date;
    }>;
    lastEventAt: Date;
    shippedAt?: Date;
    deliveredAt?: Date;
  };
  paymentExpiresAt: Date;
  paymentReady: boolean;
  statusHistory: Array<{
    dimension: string;
    from?: string;
    to: string;
    reason?: string;
    occurredAt: Date;
  }>;
  createdAt: Date;
  updatedAt: Date;
}

export interface CustomerOrderPage {
  items: CustomerOrderView[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}
