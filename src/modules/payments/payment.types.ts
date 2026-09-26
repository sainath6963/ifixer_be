import type { PaymentAttemptStatus } from '../../domain/enums';
import type { CustomerOrderView } from '../checkout/checkout.types';

export interface RazorpayCheckoutView {
  paymentAttemptId: string;
  provider: 'RAZORPAY';
  keyId: string;
  providerOrderId: string;
  amountInPaise: number;
  currency: 'INR';
  checkoutName: string;
  description: string;
  prefill: {
    name?: string;
    email?: string;
    contact?: string;
  };
  expiresAt: Date;
}

export interface PaymentAttemptView {
  id: string;
  provider: 'RAZORPAY';
  amountInPaise: number;
  currency: 'INR';
  status: PaymentAttemptStatus;
  providerOrderId?: string;
  providerPaymentId?: string;
  signatureVerified: boolean;
  failureCode?: string;
  failureDescription?: string;
  updatedAt: Date;
}

export interface PaymentVerificationResult {
  payment: PaymentAttemptView;
  order: CustomerOrderView;
}
