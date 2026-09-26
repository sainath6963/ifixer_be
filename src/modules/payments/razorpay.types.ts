export type RazorpayOrderStatus = 'created' | 'attempted' | 'paid';
export type RazorpayPaymentStatus = 'created' | 'authorized' | 'captured' | 'refunded' | 'failed';
export type RazorpayRefundStatus = 'pending' | 'processed' | 'failed';

export interface RazorpayProviderOrder {
  id: string;
  amountInPaise: number;
  currency: 'INR';
  receipt: string;
  status: RazorpayOrderStatus;
  createdAt: Date;
}

export interface RazorpayProviderPayment {
  id: string;
  orderId: string;
  amountInPaise: number;
  currency: 'INR';
  status: RazorpayPaymentStatus;
  captured: boolean;
  errorCode?: string;
  errorDescription?: string;
  createdAt: Date;
}

export interface RazorpayProviderRefund {
  id: string;
  paymentId: string;
  amountInPaise: number;
  currency: 'INR';
  receipt?: string;
  status: RazorpayRefundStatus;
  acquirerReference?: string;
  createdAt: Date;
}

export interface CreateRazorpayOrderInput {
  amountInPaise: number;
  currency: 'INR';
  receipt: string;
  internalOrderId: string;
  orderNumber: string;
}

export interface CreateRazorpayRefundInput {
  providerPaymentId: string;
  amountInPaise: number;
  receipt: string;
  idempotencyKey: string;
  internalOrderId: string;
  orderNumber: string;
  refundNumber: string;
  reason: string;
}

export interface RazorpayGateway {
  readonly keyId: string;
  readonly checkoutName: string;
  createOrder(input: CreateRazorpayOrderInput): Promise<RazorpayProviderOrder>;
  findOrderByReceipt(receipt: string): Promise<RazorpayProviderOrder | undefined>;
  fetchOrder(providerOrderId: string): Promise<RazorpayProviderOrder>;
  fetchPayment(providerPaymentId: string): Promise<RazorpayProviderPayment>;
  fetchPaymentsForOrder(providerOrderId: string): Promise<RazorpayProviderPayment[]>;
  createRefund(input: CreateRazorpayRefundInput): Promise<RazorpayProviderRefund>;
  findRefundByReceipt(
    providerPaymentId: string,
    receipt: string,
  ): Promise<RazorpayProviderRefund | undefined>;
  fetchRefund(providerPaymentId: string, providerRefundId: string): Promise<RazorpayProviderRefund>;
  verifyPaymentSignature(
    providerOrderId: string,
    providerPaymentId: string,
    signature: string,
  ): boolean;
  verifyWebhookSignature(rawBody: Buffer, signature: string): boolean;
}

export class RazorpayGatewayError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly statusCode?: number,
    readonly retryable: boolean = false,
  ) {
    super(message);
    this.name = RazorpayGatewayError.name;
  }
}
