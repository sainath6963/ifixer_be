import type { FinancialStatus, PaymentProvider, RefundStatus } from '../../domain/enums';

export interface RefundView {
  id: string;
  refundNumber: string;
  orderId: string;
  paymentAttemptId: string;
  provider: PaymentProvider;
  amountInPaise: number;
  currency: 'INR';
  status: RefundStatus;
  providerRefundId?: string;
  acquirerReference?: string;
  reason: string;
  requestedBy: string;
  processedAt?: Date;
  failureCode?: string;
  failureDescription?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface RefundRequestInput {
  expectedOrderVersion: number;
  amountInPaise: number;
  reason: string;
}

export interface RefundRequestResult {
  refund: RefundView;
  financialStatus: FinancialStatus;
  refundedInPaise: number;
  refundPendingInPaise: number;
}

export interface RefundReconciliationResult {
  checked: number;
  succeeded: number;
  failed: number;
}
