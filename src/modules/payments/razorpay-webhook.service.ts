import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { MongoServerError } from 'mongodb';
import { createHash } from 'node:crypto';
import { Model } from 'mongoose';

import { WebhookEvent, WebhookEventDocument } from '../../database/schemas/integration.schema';
import { PaymentProvider, WebhookStatus } from '../../domain/enums';
import {
  RAZORPAY_EVENT_ID_PATTERN,
  RAZORPAY_GATEWAY,
  RAZORPAY_PROVIDER_ORDER_PATTERN,
  RAZORPAY_PROVIDER_PAYMENT_PATTERN,
  RAZORPAY_PROVIDER_REFUND_PATTERN,
  RAZORPAY_SIGNATURE_PATTERN,
} from './payment.constants';
import { PaymentService } from './payment.service';
import { RefundService } from './refund.service';
import type {
  RazorpayGateway,
  RazorpayProviderPayment,
  RazorpayProviderRefund,
} from './razorpay.types';

const PAYMENT_EVENTS = new Set([
  'payment.authorized',
  'payment.captured',
  'payment.failed',
  'order.paid',
]);
const REFUND_EVENTS = new Set(['refund.created', 'refund.processed', 'refund.failed']);
const SUPPORTED_EVENTS = new Set([...PAYMENT_EVENTS, ...REFUND_EVENTS]);

@Injectable()
export class RazorpayWebhookService {
  constructor(
    @InjectModel(WebhookEvent.name) private readonly events: Model<WebhookEvent>,
    @Inject(RAZORPAY_GATEWAY) private readonly gateway: RazorpayGateway,
    private readonly payments: PaymentService,
    private readonly refunds: RefundService,
  ) {}

  async handle(
    rawBody: Buffer | undefined,
    signature: string | undefined,
    eventId: string | undefined,
  ): Promise<void> {
    if (!rawBody?.length) {
      throw new InternalServerErrorException({
        code: 'WEBHOOK_RAW_BODY_UNAVAILABLE',
        message: 'Webhook raw body is unavailable',
      });
    }
    if (!signature || !RAZORPAY_SIGNATURE_PATTERN.test(signature)) {
      throw this.invalidSignature();
    }
    if (!eventId || !RAZORPAY_EVENT_ID_PATTERN.test(eventId)) {
      throw new BadRequestException({
        code: 'WEBHOOK_EVENT_ID_INVALID',
        message: 'Razorpay webhook event ID is missing or invalid',
      });
    }
    if (!this.gateway.verifyWebhookSignature(rawBody, signature)) throw this.invalidSignature();

    const payload = this.parsePayload(rawBody);
    const eventType = this.requiredString(payload.event, 'event');
    if (eventType.length > 160) {
      throw new BadRequestException({
        code: 'WEBHOOK_EVENT_INVALID',
        message: 'Razorpay webhook event is invalid',
      });
    }
    const payloadHash = createHash('sha256').update(rawBody).digest('hex');
    const event = await this.receiveEvent(eventId, eventType, payloadHash, payload);
    if ([WebhookStatus.Processed, WebhookStatus.Ignored].includes(event.status)) return;

    try {
      await this.events.updateOne(
        { _id: event._id },
        {
          $set: { status: WebhookStatus.Processing },
          $inc: { processingAttempts: 1, version: 1 },
          $unset: { lastError: 1 },
        },
      );
      if (!SUPPORTED_EVENTS.has(eventType)) {
        await this.finishEvent(event._id, WebhookStatus.Ignored);
        return;
      }
      if (REFUND_EVENTS.has(eventType)) {
        const refund = this.extractRefund(payload);
        this.assertRefundEventState(eventType, refund);
        const internalRefund = await this.refunds.resolveRefund(refund);
        if (!internalRefund) {
          await this.finishEvent(event._id, WebhookStatus.Ignored);
          return;
        }
        await this.refunds.applyProviderRefund(refund, { source: 'WEBHOOK' });
      } else {
        const payment = this.extractPayment(payload);
        this.assertPaymentEventState(eventType, payment);
        const attempt = await this.payments.resolveAttempt(payment.orderId);
        if (!attempt) {
          await this.finishEvent(event._id, WebhookStatus.Ignored);
          return;
        }
        await this.payments.applyProviderPayment(payment, { source: 'WEBHOOK' });
      }
      await this.finishEvent(event._id, WebhookStatus.Processed);
    } catch (error: unknown) {
      await this.events.updateOne(
        { _id: event._id },
        {
          $set: {
            status: WebhookStatus.Failed,
            lastError: this.errorMessage(error),
          },
          $inc: { version: 1 },
        },
      );
      throw error;
    }
  }

  private async receiveEvent(
    eventId: string,
    eventType: string,
    payloadHash: string,
    payload: Record<string, unknown>,
  ): Promise<WebhookEventDocument> {
    const existing = await this.events
      .findOne({ provider: PaymentProvider.Razorpay, eventId })
      .exec();
    if (existing) return this.assertSamePayload(existing, payloadHash);
    try {
      return await this.events.create({
        provider: PaymentProvider.Razorpay,
        eventId,
        eventType,
        payloadHashSha256: payloadHash,
        payload,
        status: WebhookStatus.Received,
        processingAttempts: 0,
        receivedAt: new Date(),
      });
    } catch (error: unknown) {
      if (!(error instanceof MongoServerError) || error.code !== 11000) throw error;
      const duplicate = await this.events
        .findOne({ provider: PaymentProvider.Razorpay, eventId })
        .orFail();
      return this.assertSamePayload(duplicate, payloadHash);
    }
  }

  private assertSamePayload(
    event: WebhookEventDocument,
    payloadHash: string,
  ): WebhookEventDocument {
    if (event.payloadHashSha256 !== payloadHash) {
      throw new ConflictException({
        code: 'WEBHOOK_EVENT_REPLAY_MISMATCH',
        message: 'Webhook event ID was reused with a different payload',
      });
    }
    return event;
  }

  private async finishEvent(
    eventId: WebhookEventDocument['_id'],
    status: WebhookStatus,
  ): Promise<void> {
    await this.events.updateOne(
      { _id: eventId },
      {
        $set: { status, processedAt: new Date() },
        $unset: { lastError: 1 },
        $inc: { version: 1 },
      },
    );
  }

  private parsePayload(rawBody: Buffer): Record<string, unknown> {
    try {
      const parsed = JSON.parse(rawBody.toString('utf8')) as unknown;
      return this.record(parsed, 'payload');
    } catch (error: unknown) {
      if (error instanceof BadRequestException) throw error;
      throw new BadRequestException({
        code: 'WEBHOOK_PAYLOAD_INVALID',
        message: 'Razorpay webhook payload is invalid JSON',
      });
    }
  }

  private extractPayment(payload: Record<string, unknown>): RazorpayProviderPayment {
    const payloadNode = this.record(payload.payload, 'payload.payload');
    const paymentNode = this.record(payloadNode.payment, 'payload.payment');
    const entity = this.record(paymentNode.entity, 'payload.payment.entity');
    const id = this.requiredString(entity.id, 'payment.id');
    const orderId = this.requiredString(entity.order_id, 'payment.order_id');
    const currency = this.requiredString(entity.currency, 'payment.currency');
    const status = this.requiredString(entity.status, 'payment.status');
    const amount = this.requiredInteger(entity.amount, 'payment.amount');
    const createdAt = this.requiredInteger(entity.created_at, 'payment.created_at');
    if (
      !RAZORPAY_PROVIDER_PAYMENT_PATTERN.test(id) ||
      !RAZORPAY_PROVIDER_ORDER_PATTERN.test(orderId) ||
      currency !== 'INR' ||
      !['created', 'authorized', 'captured', 'refunded', 'failed'].includes(status)
    ) {
      throw this.invalidPayload('Razorpay payment entity failed validation');
    }
    return {
      id,
      orderId,
      amountInPaise: amount,
      currency,
      status: status as RazorpayProviderPayment['status'],
      captured: entity.captured === true,
      errorCode:
        typeof entity.error_code === 'string' ? entity.error_code.slice(0, 120) : undefined,
      errorDescription:
        typeof entity.error_description === 'string'
          ? entity.error_description.slice(0, 1000)
          : undefined,
      createdAt: new Date(createdAt * 1000),
    };
  }

  private extractRefund(payload: Record<string, unknown>): RazorpayProviderRefund {
    const payloadNode = this.record(payload.payload, 'payload.payload');
    const refundNode = this.record(payloadNode.refund, 'payload.refund');
    const entity = this.record(refundNode.entity, 'payload.refund.entity');
    const id = this.requiredString(entity.id, 'refund.id');
    const paymentId = this.requiredString(entity.payment_id, 'refund.payment_id');
    const amount = this.requiredInteger(entity.amount, 'refund.amount');
    const currency = this.requiredString(entity.currency, 'refund.currency');
    const status = this.requiredString(entity.status, 'refund.status');
    const createdAt = this.requiredInteger(entity.created_at, 'refund.created_at');
    const receipt =
      entity.receipt === null || entity.receipt === undefined
        ? undefined
        : this.requiredString(entity.receipt, 'refund.receipt');
    if (
      !RAZORPAY_PROVIDER_REFUND_PATTERN.test(id) ||
      !RAZORPAY_PROVIDER_PAYMENT_PATTERN.test(paymentId) ||
      amount < 1 ||
      currency !== 'INR' ||
      !['pending', 'processed', 'failed'].includes(status)
    ) {
      throw this.invalidPayload('Razorpay refund entity failed validation');
    }
    const acquirerData =
      typeof entity.acquirer_data === 'object' &&
      entity.acquirer_data !== null &&
      !Array.isArray(entity.acquirer_data)
        ? (entity.acquirer_data as Record<string, unknown>)
        : {};
    const acquirerReference = ['arn', 'rrn', 'utr']
      .map((key) => acquirerData[key])
      .find((entry): entry is string => typeof entry === 'string' && entry.length > 0);
    return {
      id,
      paymentId,
      amountInPaise: amount,
      currency,
      receipt,
      status: status as RazorpayProviderRefund['status'],
      acquirerReference: acquirerReference?.slice(0, 160),
      createdAt: new Date(createdAt * 1000),
    };
  }

  private assertPaymentEventState(eventType: string, payment: RazorpayProviderPayment): void {
    const valid =
      (eventType === 'payment.authorized' && payment.status === 'authorized') ||
      ((eventType === 'payment.captured' || eventType === 'order.paid') &&
        payment.status === 'captured' &&
        payment.captured) ||
      (eventType === 'payment.failed' && payment.status === 'failed');
    if (!valid) {
      throw this.invalidPayload('Razorpay event type and payment state do not match');
    }
  }

  private assertRefundEventState(eventType: string, refund: RazorpayProviderRefund): void {
    const valid =
      (eventType === 'refund.created' && ['pending', 'processed'].includes(refund.status)) ||
      (eventType === 'refund.processed' && refund.status === 'processed') ||
      (eventType === 'refund.failed' && refund.status === 'failed');
    if (!valid) {
      throw this.invalidPayload('Razorpay event type and refund state do not match');
    }
  }

  private record(value: unknown, label: string): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw this.invalidPayload(`Razorpay ${label} is invalid`);
    }
    return value as Record<string, unknown>;
  }

  private requiredString(value: unknown, label: string): string {
    if (typeof value !== 'string' || !value) {
      throw this.invalidPayload(`Razorpay ${label} is invalid`);
    }
    return value;
  }

  private requiredInteger(value: unknown, label: string): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      throw this.invalidPayload(`Razorpay ${label} is invalid`);
    }
    return value;
  }

  private invalidPayload(message: string): BadRequestException {
    return new BadRequestException({ code: 'WEBHOOK_PAYLOAD_INVALID', message });
  }

  private invalidSignature(): UnauthorizedException {
    return new UnauthorizedException({
      code: 'WEBHOOK_SIGNATURE_INVALID',
      message: 'Razorpay webhook signature verification failed',
    });
  }

  private errorMessage(error: unknown): string {
    return (error instanceof Error ? error.message : 'Webhook processing failed').slice(0, 2000);
  }
}
