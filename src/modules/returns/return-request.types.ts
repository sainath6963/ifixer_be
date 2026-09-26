import type {
  ExchangeReservationStatus,
  ReturnReason,
  ReturnRequestStatus,
  ReturnRequestType,
  ReturnResolutionType,
} from '../../domain/enums';

export interface ReturnExchangeOptionView {
  variantId: string;
  sku: string;
  title: string;
  attributes: Array<{ name: string; value: string }>;
  currentlyAvailable: boolean;
}

export interface ReturnEligibilityItemView {
  productId: string;
  variantId: string;
  productName: string;
  sku: string;
  variantTitle: string;
  orderedQuantity: number;
  allocatedQuantity: number;
  availableQuantity: number;
  exchangeOptions: ReturnExchangeOptionView[];
}

export interface ReturnRequestView {
  id: string;
  returnNumber: string;
  orderNumber: string;
  type: ReturnRequestType;
  status: ReturnRequestStatus;
  items: Array<{
    productId: string;
    variantId: string;
    productName: string;
    sku: string;
    variantTitle: string;
    quantity: number;
    reason: ReturnReason;
    reasonDetail?: string;
    requestedExchangeVariant?: ReturnExchangeOptionView;
    estimatedValueInPaise: number;
    restockedQuantity: number;
  }>;
  estimatedTotalInPaise: number;
  customerNote?: string;
  customerMessage?: string;
  requestedAt: Date;
  decidedAt?: Date;
  receivedAt?: Date;
  completedAt?: Date;
  cancelledAt?: Date;
  exchangeReservation?: {
    status: ExchangeReservationStatus;
    expiresAt?: Date;
    finalizedAt?: Date;
  };
  resolution?: {
    type: ReturnResolutionType;
    refundId?: string;
    courierName?: string;
    trackingNumber?: string;
    trackingUrl?: string;
  };
  statusHistory: Array<{
    status: ReturnRequestStatus;
    message?: string;
    occurredAt: Date;
  }>;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface AdminReturnRequestView extends ReturnRequestView {
  customerId: string;
  internalNote?: string;
  lastAdminId?: string;
  statusHistory: Array<{
    status: ReturnRequestStatus;
    actorType: string;
    actorId?: string;
    message?: string;
    occurredAt: Date;
  }>;
}

export interface CustomerReturnsView {
  eligibility: {
    eligible: boolean;
    reason?: string;
    deliveredAt?: Date;
    deadline?: Date;
    windowDays: number;
    items: ReturnEligibilityItemView[];
  };
  requests: ReturnRequestView[];
}

export interface AdminReturnRequestPage {
  items: AdminReturnRequestView[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}
