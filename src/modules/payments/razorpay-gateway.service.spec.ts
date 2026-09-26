import { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';

import { RazorpayGatewayService } from './razorpay-gateway.service';

describe('RazorpayGatewayService signature verification', () => {
  const keySecret = 'unit-razorpay-api-secret-32-characters';
  const webhookSecret = 'unit-razorpay-webhook-secret-32-characters';
  const gateway = new RazorpayGatewayService(
    new ConfigService({
      RAZORPAY_KEY_ID: 'rzp_test_phase8unit',
      RAZORPAY_KEY_SECRET: keySecret,
      RAZORPAY_WEBHOOK_SECRET: webhookSecret,
      RAZORPAY_CHECKOUT_NAME: 'Rich Culture Test',
      RAZORPAY_API_TIMEOUT_MS: 5000,
    }),
  );

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('uses the server-owned provider order ID when verifying a Checkout signature', () => {
    const orderId = 'order_PHASE8UNIT0001';
    const paymentId = 'pay_PHASE8UNIT000001';
    const signature = createHmac('sha256', keySecret)
      .update(`${orderId}|${paymentId}`)
      .digest('hex');

    expect(gateway.verifyPaymentSignature(orderId, paymentId, signature)).toBe(true);
    expect(gateway.verifyPaymentSignature('order_PHASE8UNIT0002', paymentId, signature)).toBe(
      false,
    );
    expect(gateway.verifyPaymentSignature(orderId, paymentId, 'invalid')).toBe(false);
  });

  it('verifies the exact raw webhook bytes and rejects a reserialized body', () => {
    const rawBody = Buffer.from('{"event":"payment.captured","value":1}');
    const signature = createHmac('sha256', webhookSecret).update(rawBody).digest('hex');

    expect(gateway.verifyWebhookSignature(rawBody, signature)).toBe(true);
    expect(
      gateway.verifyWebhookSignature(
        Buffer.from('{"value":1,"event":"payment.captured"}'),
        signature,
      ),
    ).toBe(false);
  });

  it('creates an idempotent normal refund and validates the provider response', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'rfnd_PHASE9UNIT0001',
          payment_id: 'pay_PHASE9UNIT000001',
          amount: 50_000,
          currency: 'INR',
          receipt: 'RF-20260808-ABCDEF123456',
          status: 'pending',
          acquirer_data: { arn: null },
          created_at: 1_786_182_400,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    await expect(
      gateway.createRefund({
        providerPaymentId: 'pay_PHASE9UNIT000001',
        amountInPaise: 50_000,
        receipt: 'RF-20260808-ABCDEF123456',
        idempotencyKey: 'RF-20260808-ABCDEF123456',
        internalOrderId: '66b5e4e6d81dd7fdde34a111',
        orderNumber: 'RC-20260808-ABCDEF1234',
        refundNumber: 'RF-20260808-ABCDEF123456',
        reason: 'Customer requested a partial refund',
      }),
    ).resolves.toMatchObject({
      id: 'rfnd_PHASE9UNIT0001',
      paymentId: 'pay_PHASE9UNIT000001',
      amountInPaise: 50_000,
      currency: 'INR',
      status: 'pending',
    });
    const [, init] = fetchMock.mock.calls[0];
    expect(new Headers(init?.headers).get('x-refund-idempotency')).toBe('RF-20260808-ABCDEF123456');
    if (typeof init?.body !== 'string') throw new Error('Expected a JSON refund request body');
    const requestBody = JSON.parse(init.body) as unknown;
    expect(requestBody).toMatchObject({
      amount: 50_000,
      speed: 'normal',
      receipt: 'RF-20260808-ABCDEF123456',
    });
  });
});
