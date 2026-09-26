import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';

import {
  RAZORPAY_PROVIDER_ORDER_PATTERN,
  RAZORPAY_PROVIDER_PAYMENT_PATTERN,
  RAZORPAY_PROVIDER_REFUND_PATTERN,
  RAZORPAY_SIGNATURE_PATTERN,
} from './payment.constants';
import {
  CreateRazorpayRefundInput,
  CreateRazorpayOrderInput,
  RazorpayGateway,
  RazorpayGatewayError,
  RazorpayOrderStatus,
  RazorpayPaymentStatus,
  RazorpayProviderOrder,
  RazorpayProviderPayment,
  RazorpayProviderRefund,
  RazorpayRefundStatus,
} from './razorpay.types';

interface RazorpayApiErrorBody {
  error?: { code?: unknown; description?: unknown };
}

@Injectable()
export class RazorpayGatewayService implements RazorpayGateway {
  readonly keyId: string;
  readonly checkoutName: string;
  private readonly keySecret: string;
  private readonly webhookSecret: string;
  private readonly timeoutMs: number;
  private readonly apiBaseUrl = 'https://api.razorpay.com/v1';

  constructor(config: ConfigService) {
    this.keyId = config.getOrThrow<string>('RAZORPAY_KEY_ID');
    this.keySecret = config.getOrThrow<string>('RAZORPAY_KEY_SECRET');
    this.webhookSecret = config.getOrThrow<string>('RAZORPAY_WEBHOOK_SECRET');
    this.checkoutName = config.getOrThrow<string>('RAZORPAY_CHECKOUT_NAME');
    this.timeoutMs = config.getOrThrow<number>('RAZORPAY_API_TIMEOUT_MS');
  }

  async createOrder(input: CreateRazorpayOrderInput): Promise<RazorpayProviderOrder> {
    const payload = await this.request('/orders', {
      method: 'POST',
      body: JSON.stringify({
        amount: input.amountInPaise,
        currency: input.currency,
        receipt: input.receipt,
        partial_payment: false,
        notes: {
          internal_order_id: input.internalOrderId,
          order_number: input.orderNumber,
        },
      }),
    });
    return this.parseOrder(payload);
  }

  async findOrderByReceipt(receipt: string): Promise<RazorpayProviderOrder | undefined> {
    const payload = this.asRecord(
      await this.request(`/orders?receipt=${encodeURIComponent(receipt)}&count=100`, {
        method: 'GET',
      }),
      'orders response',
    );
    const items = payload.items;
    if (!Array.isArray(items)) throw this.invalidResponse('Orders response did not contain items');
    const matches = items
      .map((item) => this.parseOrder(item))
      .filter((order) => order.receipt === receipt);
    if (matches.length > 1) {
      throw this.invalidResponse('Multiple Razorpay orders used the same receipt');
    }
    return matches[0];
  }

  async fetchOrder(providerOrderId: string): Promise<RazorpayProviderOrder> {
    return this.parseOrder(
      await this.request(`/orders/${encodeURIComponent(providerOrderId)}`, { method: 'GET' }),
    );
  }

  async fetchPayment(providerPaymentId: string): Promise<RazorpayProviderPayment> {
    return this.parsePayment(
      await this.request(`/payments/${encodeURIComponent(providerPaymentId)}`, { method: 'GET' }),
    );
  }

  async fetchPaymentsForOrder(providerOrderId: string): Promise<RazorpayProviderPayment[]> {
    const payload = this.asRecord(
      await this.request(`/orders/${encodeURIComponent(providerOrderId)}/payments`, {
        method: 'GET',
      }),
      'order payments response',
    );
    if (!Array.isArray(payload.items)) {
      throw this.invalidResponse('Order payments response did not contain items');
    }
    return payload.items.map((item) => this.parsePayment(item));
  }

  async createRefund(input: CreateRazorpayRefundInput): Promise<RazorpayProviderRefund> {
    return this.parseRefund(
      await this.request(`/payments/${encodeURIComponent(input.providerPaymentId)}/refund`, {
        method: 'POST',
        headers: { 'X-Refund-Idempotency': input.idempotencyKey },
        body: JSON.stringify({
          amount: input.amountInPaise,
          speed: 'normal',
          receipt: input.receipt,
          notes: {
            internal_order_id: input.internalOrderId,
            order_number: input.orderNumber,
            refund_number: input.refundNumber,
            reason: input.reason,
          },
        }),
      }),
    );
  }

  async findRefundByReceipt(
    providerPaymentId: string,
    receipt: string,
  ): Promise<RazorpayProviderRefund | undefined> {
    const payload = this.asRecord(
      await this.request(`/payments/${encodeURIComponent(providerPaymentId)}/refunds?count=100`, {
        method: 'GET',
      }),
      'payment refunds response',
    );
    if (!Array.isArray(payload.items)) {
      throw this.invalidResponse('Payment refunds response did not contain items');
    }
    const matches = payload.items
      .map((item) => this.parseRefund(item))
      .filter((refund) => refund.receipt === receipt);
    if (matches.length > 1) {
      throw this.invalidResponse('Multiple Razorpay refunds used the same receipt');
    }
    return matches[0];
  }

  async fetchRefund(
    providerPaymentId: string,
    providerRefundId: string,
  ): Promise<RazorpayProviderRefund> {
    return this.parseRefund(
      await this.request(
        `/payments/${encodeURIComponent(providerPaymentId)}/refunds/${encodeURIComponent(providerRefundId)}`,
        { method: 'GET' },
      ),
    );
  }

  verifyPaymentSignature(
    providerOrderId: string,
    providerPaymentId: string,
    signature: string,
  ): boolean {
    if (!RAZORPAY_SIGNATURE_PATTERN.test(signature)) return false;
    return this.signaturesMatch(
      createHmac('sha256', this.keySecret)
        .update(`${providerOrderId}|${providerPaymentId}`)
        .digest('hex'),
      signature.toLowerCase(),
    );
  }

  verifyWebhookSignature(rawBody: Buffer, signature: string): boolean {
    if (!RAZORPAY_SIGNATURE_PATTERN.test(signature)) return false;
    return this.signaturesMatch(
      createHmac('sha256', this.webhookSecret).update(rawBody).digest('hex'),
      signature.toLowerCase(),
    );
  }

  private async request(path: string, init: RequestInit): Promise<unknown> {
    try {
      const headers = new Headers(init.headers);
      headers.set('Accept', 'application/json');
      headers.set(
        'Authorization',
        `Basic ${Buffer.from(`${this.keyId}:${this.keySecret}`).toString('base64')}`,
      );
      headers.set('Content-Type', 'application/json');
      const response = await fetch(`${this.apiBaseUrl}${path}`, {
        ...init,
        headers,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const responseText = await response.text();
      let payload: unknown;
      try {
        payload = responseText ? (JSON.parse(responseText) as unknown) : {};
      } catch {
        throw this.invalidResponse('Razorpay returned invalid JSON');
      }
      if (!response.ok) {
        const errorBody = this.isRecord(payload) ? (payload as RazorpayApiErrorBody) : {};
        const code =
          typeof errorBody.error?.code === 'string'
            ? errorBody.error.code.slice(0, 120)
            : 'RAZORPAY_API_ERROR';
        const description =
          typeof errorBody.error?.description === 'string'
            ? errorBody.error.description.slice(0, 500)
            : 'Razorpay rejected the request';
        throw new RazorpayGatewayError(
          description,
          code,
          response.status,
          response.status === 429 || response.status >= 500,
        );
      }
      return payload;
    } catch (error: unknown) {
      if (error instanceof RazorpayGatewayError) throw error;
      const timeout = error instanceof Error && error.name === 'TimeoutError';
      throw new RazorpayGatewayError(
        timeout ? 'Razorpay request timed out' : 'Razorpay request failed',
        timeout ? 'RAZORPAY_TIMEOUT' : 'RAZORPAY_NETWORK_ERROR',
        undefined,
        true,
      );
    }
  }

  private parseOrder(value: unknown): RazorpayProviderOrder {
    const record = this.asRecord(value, 'order');
    const id = this.string(record.id, 'order.id');
    const amount = this.integer(record.amount, 'order.amount');
    const currency = this.string(record.currency, 'order.currency');
    const receipt = this.string(record.receipt, 'order.receipt');
    const status = this.string(record.status, 'order.status');
    const createdAt = this.integer(record.created_at, 'order.created_at');
    if (
      !RAZORPAY_PROVIDER_ORDER_PATTERN.test(id) ||
      currency !== 'INR' ||
      !['created', 'attempted', 'paid'].includes(status)
    ) {
      throw this.invalidResponse('Razorpay order response failed validation');
    }
    return {
      id,
      amountInPaise: amount,
      currency,
      receipt,
      status: status as RazorpayOrderStatus,
      createdAt: new Date(createdAt * 1000),
    };
  }

  private parsePayment(value: unknown): RazorpayProviderPayment {
    const record = this.asRecord(value, 'payment');
    const id = this.string(record.id, 'payment.id');
    const orderId = this.string(record.order_id, 'payment.order_id');
    const amount = this.integer(record.amount, 'payment.amount');
    const currency = this.string(record.currency, 'payment.currency');
    const status = this.string(record.status, 'payment.status');
    const createdAt = this.integer(record.created_at, 'payment.created_at');
    if (
      !RAZORPAY_PROVIDER_PAYMENT_PATTERN.test(id) ||
      !RAZORPAY_PROVIDER_ORDER_PATTERN.test(orderId) ||
      currency !== 'INR' ||
      !['created', 'authorized', 'captured', 'refunded', 'failed'].includes(status)
    ) {
      throw this.invalidResponse('Razorpay payment response failed validation');
    }
    return {
      id,
      orderId,
      amountInPaise: amount,
      currency,
      status: status as RazorpayPaymentStatus,
      captured: record.captured === true,
      errorCode:
        typeof record.error_code === 'string' ? record.error_code.slice(0, 120) : undefined,
      errorDescription:
        typeof record.error_description === 'string'
          ? record.error_description.slice(0, 1000)
          : undefined,
      createdAt: new Date(createdAt * 1000),
    };
  }

  private parseRefund(value: unknown): RazorpayProviderRefund {
    const record = this.asRecord(value, 'refund');
    const id = this.string(record.id, 'refund.id');
    const paymentId = this.string(record.payment_id, 'refund.payment_id');
    const amount = this.integer(record.amount, 'refund.amount');
    const currency = this.string(record.currency, 'refund.currency');
    const status = this.string(record.status, 'refund.status');
    const createdAt = this.integer(record.created_at, 'refund.created_at');
    const receipt =
      record.receipt === null || record.receipt === undefined
        ? undefined
        : this.string(record.receipt, 'refund.receipt');
    if (
      !RAZORPAY_PROVIDER_REFUND_PATTERN.test(id) ||
      !RAZORPAY_PROVIDER_PAYMENT_PATTERN.test(paymentId) ||
      amount < 1 ||
      currency !== 'INR' ||
      !['pending', 'processed', 'failed'].includes(status)
    ) {
      throw this.invalidResponse('Razorpay refund response failed validation');
    }
    const acquirerData = this.isRecord(record.acquirer_data) ? record.acquirer_data : {};
    const acquirerReference = ['arn', 'rrn', 'utr']
      .map((key) => acquirerData[key])
      .find((entry): entry is string => typeof entry === 'string' && entry.length > 0);
    return {
      id,
      paymentId,
      amountInPaise: amount,
      currency,
      receipt,
      status: status as RazorpayRefundStatus,
      acquirerReference: acquirerReference?.slice(0, 160),
      createdAt: new Date(createdAt * 1000),
    };
  }

  private asRecord(value: unknown, label: string): Record<string, unknown> {
    if (!this.isRecord(value)) throw this.invalidResponse(`Razorpay ${label} was invalid`);
    return value;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  private string(value: unknown, label: string): string {
    if (typeof value !== 'string' || !value) {
      throw this.invalidResponse(`Razorpay ${label} was invalid`);
    }
    return value;
  }

  private integer(value: unknown, label: string): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      throw this.invalidResponse(`Razorpay ${label} was invalid`);
    }
    return value;
  }

  private invalidResponse(message: string): RazorpayGatewayError {
    return new RazorpayGatewayError(message, 'RAZORPAY_INVALID_RESPONSE', undefined, true);
  }

  private signaturesMatch(expected: string, received: string): boolean {
    if (expected.length !== received.length) return false;
    return timingSafeEqual(Buffer.from(expected), Buffer.from(received));
  }
}
