import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { MongoServerError } from 'mongodb';
import { createHash, randomBytes } from 'node:crypto';
import { ClientSession, Connection, Model, Types } from 'mongoose';

import { OutboxEvent } from '../../database/schemas/integration.schema';
import { Order, OrderDocument } from '../../database/schemas/order.schema';
import {
  PaymentAttempt,
  PaymentAttemptDocument,
  Refund,
  RefundDocument,
} from '../../database/schemas/payment.schema';
import {
  AuditActorType,
  FinancialStatus,
  OutboxStatus,
  PaymentAttemptStatus,
  PaymentProvider,
  RefundStatus,
} from '../../domain/enums';
import { AuthAuditService } from '../admin-auth/auth-audit.service';
import type { AuthenticatedAdmin, AuthRequestContext } from '../admin-auth/auth.types';
import {
  PAYMENT_RECONCILIATION_BATCH_SIZE,
  PAYMENT_RECONCILIATION_MIN_AGE_MS,
  RAZORPAY_GATEWAY,
  RAZORPAY_REFUND_IDEMPOTENCY_PATTERN,
} from './payment.constants';
import type {
  RefundReconciliationResult,
  RefundRequestInput,
  RefundRequestResult,
  RefundView,
} from './refund.types';
import type { RazorpayGateway, RazorpayProviderRefund } from './razorpay.types';
import { RazorpayGatewayError } from './razorpay.types';

interface ApplyRefundOptions {
  actorId?: string;
  context?: AuthRequestContext;
  source: 'ADMIN' | 'WEBHOOK' | 'RECONCILIATION';
}

interface RefundApplyResult {
  refund: RefundDocument;
  order: OrderDocument;
  attempt: PaymentAttemptDocument;
}

@Injectable()
export class RefundService {
  private readonly logger = new Logger(RefundService.name);

  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(Order.name) private readonly orders: Model<Order>,
    @InjectModel(PaymentAttempt.name) private readonly attempts: Model<PaymentAttempt>,
    @InjectModel(Refund.name) private readonly refunds: Model<Refund>,
    @InjectModel(OutboxEvent.name) private readonly outbox: Model<OutboxEvent>,
    @Inject(RAZORPAY_GATEWAY) private readonly gateway: RazorpayGateway,
    private readonly audit: AuthAuditService,
  ) {}

  async request(
    orderNumber: string,
    input: RefundRequestInput,
    idempotencyKeyInput: string | undefined,
    admin: AuthenticatedAdmin,
    context: AuthRequestContext,
  ): Promise<RefundRequestResult> {
    const idempotencyKey = this.validateIdempotencyKey(idempotencyKeyInput);
    const reason = input.reason.trim();
    const requestHash = this.requestHash(orderNumber, input.amountInPaise, reason);
    const order = await this.orders.findOne({ orderNumber }).exec();
    if (!order) throw this.orderNotFound();

    const existing = await this.refunds.findOne({ idempotencyKey }).exec();
    if (existing) {
      this.assertIdempotentRefund(existing, order.id, requestHash);
      const applied = await this.ensureProviderRefund(existing, order, {
        actorId: admin.id,
        context,
        source: 'ADMIN',
      });
      return this.toRequestResult(applied);
    }

    const refundNumber = this.refundNumber();
    let refund: RefundDocument;
    try {
      refund = await this.connection.transaction(async (session): Promise<RefundDocument> => {
        const liveOrder = await this.orders.findById(order._id).session(session).exec();
        if (!liveOrder) throw this.orderNotFound();
        this.assertOrderVersion(liveOrder, input.expectedOrderVersion);

        const duplicate = await this.refunds.findOne({ idempotencyKey }).session(session).exec();
        if (duplicate) {
          this.assertIdempotentRefund(duplicate, liveOrder.id, requestHash);
          return duplicate;
        }

        const attempt = await this.attempts
          .findOne({
            orderId: liveOrder._id,
            provider: PaymentProvider.Razorpay,
            status: PaymentAttemptStatus.Captured,
          })
          .session(session)
          .exec();
        if (!attempt?.providerPaymentId) throw this.paymentNotRefundable();
        this.assertRefundableOrder(liveOrder);

        const refunded = attempt.refundedInPaise ?? 0;
        const pending = attempt.refundPendingInPaise ?? 0;
        if (input.amountInPaise > attempt.amountInPaise - refunded - pending) {
          throw new ConflictException({
            code: 'REFUND_AMOUNT_EXCEEDS_AVAILABLE',
            message: 'Refund amount exceeds the remaining captured amount',
          });
        }
        attempt.refundedInPaise = refunded;
        attempt.refundPendingInPaise = pending + input.amountInPaise;
        await attempt.save({ session });

        const [created] = await this.refunds.create(
          [
            {
              refundNumber,
              orderId: liveOrder._id,
              paymentAttemptId: attempt._id,
              idempotencyKey,
              idempotencyRequestHash: requestHash,
              provider: PaymentProvider.Razorpay,
              providerReceipt: refundNumber,
              providerPaymentId: attempt.providerPaymentId,
              amountInPaise: input.amountInPaise,
              currency: liveOrder.currency,
              status: RefundStatus.Pending,
              reason,
              requestedBy: new Types.ObjectId(admin.id),
            },
          ],
          { session },
        );
        await this.audit.record(
          {
            action: 'ORDER_REFUND_REQUESTED',
            resourceType: 'REFUND',
            resourceId: created.id,
            actorId: admin.id,
            context,
            metadata: {
              orderNumber: liveOrder.orderNumber,
              refundNumber,
              amountInPaise: input.amountInPaise,
            },
          },
          session,
        );
        await this.outbox.create(
          [
            {
              eventId: `refund-requested:${created.id}`,
              aggregateType: 'REFUND',
              aggregateId: created._id,
              eventType: 'ORDER_REFUND_REQUESTED',
              payload: {
                refundId: created.id,
                refundNumber,
                orderId: liveOrder.id,
                orderNumber: liveOrder.orderNumber,
                amountInPaise: input.amountInPaise,
                currency: liveOrder.currency,
              },
              status: OutboxStatus.Pending,
              availableAt: new Date(),
            },
          ],
          { session },
        );
        return created;
      }, this.transactionOptions());
    } catch (error: unknown) {
      if (!(error instanceof MongoServerError) || error.code !== 11000) throw error;
      const duplicate = await this.refunds.findOne({ idempotencyKey }).exec();
      if (!duplicate) throw error;
      this.assertIdempotentRefund(duplicate, order.id, requestHash);
      refund = duplicate;
    }

    const applied = await this.ensureProviderRefund(refund, order, {
      actorId: admin.id,
      context,
      source: 'ADMIN',
    });
    return this.toRequestResult(applied);
  }

  async resolveRefund(providerRefund: RazorpayProviderRefund): Promise<RefundDocument | undefined> {
    const existing = await this.refunds.findOne({ providerRefundId: providerRefund.id }).exec();
    if (existing) return existing;
    if (!providerRefund.receipt) return undefined;
    const refund = await this.refunds.findOne({ providerReceipt: providerRefund.receipt }).exec();
    if (!refund) return undefined;
    this.assertProviderRefund(refund, providerRefund);
    const attached = await this.refunds
      .findOneAndUpdate(
        { _id: refund._id, providerRefundId: { $exists: false } },
        { $set: { providerRefundId: providerRefund.id } },
        { returnDocument: 'after' },
      )
      .exec();
    return attached ?? this.refunds.findById(refund._id).orFail();
  }

  async applyProviderRefund(
    providerRefund: RazorpayProviderRefund,
    options: ApplyRefundOptions,
  ): Promise<RefundApplyResult> {
    return this.connection.transaction(async (session): Promise<RefundApplyResult> => {
      const refund = await this.refunds
        .findOne({
          $or: [
            { providerRefundId: providerRefund.id },
            ...(providerRefund.receipt ? [{ providerReceipt: providerRefund.receipt }] : []),
          ],
        })
        .session(session)
        .exec();
      if (!refund) throw this.refundNotFound();
      const attempt = await this.attempts.findById(refund.paymentAttemptId).session(session).exec();
      const order = await this.orders.findById(refund.orderId).session(session).exec();
      if (!attempt?.providerPaymentId || !order) throw this.refundInvariantFailed();
      this.assertProviderRefund(refund, providerRefund);

      refund.providerRefundId ??= providerRefund.id;
      refund.acquirerReference = providerRefund.acquirerReference ?? refund.acquirerReference;
      refund.lastReconciledAt = new Date();

      if (providerRefund.status === 'processed') {
        await this.succeed(refund, attempt, order, providerRefund, options, session);
      } else if (providerRefund.status === 'failed') {
        await this.fail(refund, attempt, order, providerRefund, options, session);
      } else {
        await this.markProcessing(refund, attempt, providerRefund, options, session);
      }
      return { refund, order, attempt };
    }, this.transactionOptions());
  }

  async reconcilePending(
    limit = PAYMENT_RECONCILIATION_BATCH_SIZE,
  ): Promise<RefundReconciliationResult> {
    const threshold = new Date(Date.now() - PAYMENT_RECONCILIATION_MIN_AGE_MS);
    const candidates = await this.refunds
      .find({
        status: { $in: [RefundStatus.Pending, RefundStatus.Processing] },
        updatedAt: { $lte: threshold },
      })
      .sort({ lastReconciledAt: 1, updatedAt: 1, _id: 1 })
      .limit(limit)
      .exec();
    const result: RefundReconciliationResult = { checked: 0, succeeded: 0, failed: 0 };
    for (const candidate of candidates) {
      result.checked += 1;
      try {
        const order = await this.orders.findById(candidate.orderId).exec();
        if (!order) throw this.refundInvariantFailed();
        const applied = await this.ensureProviderRefund(candidate, order, {
          source: 'RECONCILIATION',
        });
        if (applied.refund.status === RefundStatus.Succeeded) result.succeeded += 1;
        if (applied.refund.status === RefundStatus.Failed) result.failed += 1;
      } catch (error: unknown) {
        result.failed += 1;
        this.logger.error(
          `Refund reconciliation failed for ${candidate.id}`,
          error instanceof Error ? error.stack : undefined,
        );
      } finally {
        await this.refunds.updateOne(
          { _id: candidate._id },
          { $set: { lastReconciledAt: new Date() } },
        );
      }
    }
    return result;
  }

  toView(refund: RefundDocument): RefundView {
    return {
      id: refund.id,
      refundNumber: refund.refundNumber,
      orderId: refund.orderId.toHexString(),
      paymentAttemptId: refund.paymentAttemptId.toHexString(),
      provider: refund.provider,
      amountInPaise: refund.amountInPaise,
      currency: refund.currency,
      status: refund.status,
      providerRefundId: refund.providerRefundId,
      acquirerReference: refund.acquirerReference,
      reason: refund.reason,
      requestedBy: refund.requestedBy.toHexString(),
      processedAt: refund.processedAt,
      failureCode: refund.failureCode,
      failureDescription: refund.failureDescription,
      createdAt: refund.get('createdAt') as Date,
      updatedAt: refund.get('updatedAt') as Date,
    };
  }

  private async ensureProviderRefund(
    refund: RefundDocument,
    order: OrderDocument,
    options: ApplyRefundOptions,
  ): Promise<RefundApplyResult> {
    if (refund.status === RefundStatus.Succeeded || refund.status === RefundStatus.Failed) {
      const attempt = await this.attempts.findById(refund.paymentAttemptId).orFail();
      return { refund, order, attempt };
    }

    let providerRefund: RazorpayProviderRefund | undefined;
    try {
      if (refund.providerRefundId) {
        providerRefund = await this.gateway.fetchRefund(
          refund.providerPaymentId,
          refund.providerRefundId,
        );
      } else {
        try {
          providerRefund = await this.gateway.createRefund({
            providerPaymentId: refund.providerPaymentId,
            amountInPaise: refund.amountInPaise,
            receipt: refund.providerReceipt,
            idempotencyKey: refund.providerReceipt,
            internalOrderId: order.id,
            orderNumber: order.orderNumber,
            refundNumber: refund.refundNumber,
            reason: refund.reason,
          });
        } catch (createError: unknown) {
          providerRefund = await this.recoverProviderRefund(refund, createError);
        }
      }
      this.assertProviderRefund(refund, providerRefund);
      return this.applyProviderRefund(providerRefund, options);
    } catch (error: unknown) {
      if (error instanceof RazorpayGatewayError && !error.retryable) {
        await this.failProviderRequest(refund, error, options);
        throw new BadGatewayException({
          code: 'REFUND_PROVIDER_REJECTED',
          message: 'Razorpay rejected the refund request',
        });
      }
      if (error instanceof BadGatewayException || error instanceof ConflictException) throw error;
      throw new ServiceUnavailableException({
        code: 'REFUND_PROVIDER_UNAVAILABLE',
        message: 'Refund provider is temporarily unavailable; retry with the same idempotency key',
      });
    }
  }

  private async recoverProviderRefund(
    refund: RefundDocument,
    createError: unknown,
  ): Promise<RazorpayProviderRefund> {
    try {
      const recovered = await this.gateway.findRefundByReceipt(
        refund.providerPaymentId,
        refund.providerReceipt,
      );
      if (recovered) return recovered;
    } catch (recoveryError: unknown) {
      if (!(createError instanceof RazorpayGatewayError) || !createError.retryable) {
        throw createError;
      }
      throw recoveryError;
    }
    throw createError;
  }

  private async markProcessing(
    refund: RefundDocument,
    attempt: PaymentAttemptDocument,
    providerRefund: RazorpayProviderRefund,
    options: ApplyRefundOptions,
    session: ClientSession,
  ): Promise<void> {
    if (refund.status === RefundStatus.Succeeded) return;
    if (refund.status === RefundStatus.Failed) {
      this.reserveRefundAmount(attempt, refund.amountInPaise);
      await attempt.save({ session });
    }
    const firstAcceptance = refund.status !== RefundStatus.Processing;
    refund.status = RefundStatus.Processing;
    refund.failureCode = undefined;
    refund.failureDescription = undefined;
    await refund.save({ session });
    if (firstAcceptance) {
      await this.recordTransition(
        'ORDER_REFUND_ACCEPTED',
        refund,
        providerRefund,
        options,
        session,
      );
    }
  }

  private async succeed(
    refund: RefundDocument,
    attempt: PaymentAttemptDocument,
    order: OrderDocument,
    providerRefund: RazorpayProviderRefund,
    options: ApplyRefundOptions,
    session: ClientSession,
  ): Promise<void> {
    if (refund.status === RefundStatus.Succeeded) {
      if (refund.isModified()) await refund.save({ session });
      return;
    }
    if ([RefundStatus.Pending, RefundStatus.Processing].includes(refund.status)) {
      this.releasePendingRefund(attempt, refund.amountInPaise);
    } else {
      this.assertRefundCapacity(attempt, refund.amountInPaise);
    }
    attempt.refundedInPaise = (attempt.refundedInPaise ?? 0) + refund.amountInPaise;
    await attempt.save({ session });

    refund.status = RefundStatus.Succeeded;
    refund.processedAt = new Date();
    refund.failureCode = undefined;
    refund.failureDescription = undefined;
    await refund.save({ session });

    const previousFinancialStatus = order.financialStatus;
    order.financialStatus =
      attempt.refundedInPaise === attempt.amountInPaise
        ? FinancialStatus.Refunded
        : FinancialStatus.PartiallyRefunded;
    if (previousFinancialStatus !== order.financialStatus) {
      order.statusHistory.push({
        dimension: 'FINANCIAL',
        from: previousFinancialStatus,
        to: order.financialStatus,
        reason: `Razorpay refund ${refund.refundNumber} processed`,
        actorType: options.actorId ? AuditActorType.Admin : AuditActorType.System,
        actorId: options.actorId ? new Types.ObjectId(options.actorId) : undefined,
        occurredAt: new Date(),
      });
      await order.save({ session });
    }
    await this.outbox.create(
      [
        {
          eventId: `refund-succeeded:${refund.id}`,
          aggregateType: 'REFUND',
          aggregateId: refund._id,
          eventType: 'ORDER_REFUND_SUCCEEDED',
          payload: {
            refundId: refund.id,
            refundNumber: refund.refundNumber,
            orderId: order.id,
            orderNumber: order.orderNumber,
            providerRefundId: providerRefund.id,
            amountInPaise: refund.amountInPaise,
            currency: refund.currency,
            financialStatus: order.financialStatus,
          },
          status: OutboxStatus.Pending,
          availableAt: new Date(),
        },
      ],
      { session },
    );
    await this.recordTransition('ORDER_REFUND_SUCCEEDED', refund, providerRefund, options, session);
  }

  private async fail(
    refund: RefundDocument,
    attempt: PaymentAttemptDocument,
    order: OrderDocument,
    providerRefund: RazorpayProviderRefund,
    options: ApplyRefundOptions,
    session: ClientSession,
  ): Promise<void> {
    if (refund.status === RefundStatus.Succeeded || refund.status === RefundStatus.Failed) return;
    this.releasePendingRefund(attempt, refund.amountInPaise);
    await attempt.save({ session });
    refund.status = RefundStatus.Failed;
    refund.failureCode = 'RAZORPAY_REFUND_FAILED';
    refund.failureDescription = 'Razorpay could not process the refund';
    refund.processedAt = new Date();
    await refund.save({ session });
    await this.outbox.create(
      [
        {
          eventId: `refund-failed:${refund.id}`,
          aggregateType: 'REFUND',
          aggregateId: refund._id,
          eventType: 'ORDER_REFUND_FAILED',
          payload: {
            refundId: refund.id,
            refundNumber: refund.refundNumber,
            orderId: order.id,
            orderNumber: order.orderNumber,
            providerRefundId: providerRefund.id,
            amountInPaise: refund.amountInPaise,
          },
          status: OutboxStatus.Pending,
          availableAt: new Date(),
        },
      ],
      { session },
    );
    await this.recordTransition('ORDER_REFUND_FAILED', refund, providerRefund, options, session);
  }

  private async failProviderRequest(
    refund: RefundDocument,
    error: RazorpayGatewayError,
    options: ApplyRefundOptions,
  ): Promise<void> {
    await this.connection.transaction(async (session): Promise<void> => {
      const liveRefund = await this.refunds.findById(refund._id).session(session).exec();
      if (!liveRefund || liveRefund.status === RefundStatus.Succeeded) return;
      const attempt = await this.attempts
        .findById(liveRefund.paymentAttemptId)
        .session(session)
        .exec();
      if (!attempt) throw this.refundInvariantFailed();
      if ([RefundStatus.Pending, RefundStatus.Processing].includes(liveRefund.status)) {
        this.releasePendingRefund(attempt, liveRefund.amountInPaise);
        await attempt.save({ session });
      }
      liveRefund.status = RefundStatus.Failed;
      liveRefund.failureCode = error.code.slice(0, 120);
      liveRefund.failureDescription = 'Razorpay rejected the refund request';
      liveRefund.processedAt = new Date();
      await liveRefund.save({ session });
      await this.audit.record(
        {
          action: 'ORDER_REFUND_REJECTED',
          resourceType: 'REFUND',
          resourceId: liveRefund.id,
          actorId: options.actorId,
          context: options.context,
          metadata: {
            refundNumber: liveRefund.refundNumber,
            providerCode: liveRefund.failureCode,
            source: options.source,
          },
        },
        session,
      );
    }, this.transactionOptions());
  }

  private async recordTransition(
    action: string,
    refund: RefundDocument,
    providerRefund: RazorpayProviderRefund,
    options: ApplyRefundOptions,
    session: ClientSession,
  ): Promise<void> {
    await this.audit.record(
      {
        action,
        resourceType: 'REFUND',
        resourceId: refund.id,
        actorId: options.actorId,
        context: options.context,
        metadata: {
          refundNumber: refund.refundNumber,
          providerRefundId: providerRefund.id,
          amountInPaise: refund.amountInPaise,
          source: options.source,
        },
      },
      session,
    );
  }

  private assertProviderRefund(
    refund: RefundDocument,
    providerRefund: RazorpayProviderRefund,
  ): void {
    if (
      providerRefund.paymentId !== refund.providerPaymentId ||
      providerRefund.amountInPaise !== refund.amountInPaise ||
      providerRefund.currency !== refund.currency ||
      (providerRefund.receipt !== undefined && providerRefund.receipt !== refund.providerReceipt)
    ) {
      throw new BadGatewayException({
        code: 'REFUND_PROVIDER_DATA_MISMATCH',
        message: 'Razorpay refund did not match the internal refund request',
      });
    }
  }

  private assertRefundableOrder(order: OrderDocument): void {
    if (
      ![FinancialStatus.Paid, FinancialStatus.PartiallyRefunded].includes(order.financialStatus)
    ) {
      throw this.paymentNotRefundable();
    }
  }

  private assertRefundCapacity(attempt: PaymentAttemptDocument, amountInPaise: number): void {
    if (
      (attempt.refundedInPaise ?? 0) + (attempt.refundPendingInPaise ?? 0) + amountInPaise >
      attempt.amountInPaise
    ) {
      throw this.refundInvariantFailed();
    }
  }

  private reserveRefundAmount(attempt: PaymentAttemptDocument, amountInPaise: number): void {
    this.assertRefundCapacity(attempt, amountInPaise);
    attempt.refundPendingInPaise = (attempt.refundPendingInPaise ?? 0) + amountInPaise;
  }

  private releasePendingRefund(attempt: PaymentAttemptDocument, amountInPaise: number): void {
    const pending = attempt.refundPendingInPaise ?? 0;
    if (pending < amountInPaise) throw this.refundInvariantFailed();
    attempt.refundPendingInPaise = pending - amountInPaise;
  }

  private assertIdempotentRefund(
    refund: RefundDocument,
    orderId: string,
    requestHash: string,
  ): void {
    if (refund.orderId.toHexString() !== orderId || refund.idempotencyRequestHash !== requestHash) {
      throw new ConflictException({
        code: 'IDEMPOTENCY_KEY_REUSED',
        message: 'Idempotency key was already used for a different refund request',
      });
    }
  }

  private assertOrderVersion(order: OrderDocument, expectedVersion: number): void {
    if ((order.get('version') as number) !== expectedVersion) {
      throw new ConflictException({
        code: 'ORDER_VERSION_CONFLICT',
        message: 'Order changed since it was loaded; reload and retry',
      });
    }
  }

  private toRequestResult(result: RefundApplyResult): RefundRequestResult {
    return {
      refund: this.toView(result.refund),
      financialStatus: result.order.financialStatus,
      refundedInPaise: result.attempt.refundedInPaise ?? 0,
      refundPendingInPaise: result.attempt.refundPendingInPaise ?? 0,
    };
  }

  private requestHash(orderNumber: string, amountInPaise: number, reason: string): string {
    return createHash('sha256')
      .update(JSON.stringify({ orderNumber, amountInPaise, reason }))
      .digest('hex');
  }

  private validateIdempotencyKey(value: string | undefined): string {
    const key = value?.trim();
    if (!key || !/^[A-Za-z0-9][A-Za-z0-9._:-]{15,159}$/.test(key)) {
      throw new BadRequestException({
        code: 'IDEMPOTENCY_KEY_INVALID',
        message: 'Idempotency-Key must be 16-160 safe ASCII characters',
      });
    }
    return key;
  }

  private refundNumber(): string {
    const date = new Date().toISOString().slice(0, 10).replaceAll('-', '');
    const value = `RF-${date}-${randomBytes(6).toString('hex').toUpperCase()}`;
    if (!RAZORPAY_REFUND_IDEMPOTENCY_PATTERN.test(value)) {
      throw new Error('Generated refund number is not provider-safe');
    }
    return value;
  }

  private transactionOptions(): {
    readPreference: 'primary';
    readConcern: { level: 'snapshot' };
    writeConcern: { w: 'majority' };
  } {
    return {
      readPreference: 'primary',
      readConcern: { level: 'snapshot' },
      writeConcern: { w: 'majority' },
    };
  }

  private orderNotFound(): NotFoundException {
    return new NotFoundException({ code: 'ORDER_NOT_FOUND', message: 'Order was not found' });
  }

  private refundNotFound(): NotFoundException {
    return new NotFoundException({ code: 'REFUND_NOT_FOUND', message: 'Refund was not found' });
  }

  private paymentNotRefundable(): ConflictException {
    return new ConflictException({
      code: 'PAYMENT_NOT_REFUNDABLE',
      message: 'Order does not have a captured refundable Razorpay payment',
    });
  }

  private refundInvariantFailed(): ConflictException {
    return new ConflictException({
      code: 'REFUND_LEDGER_CONFLICT',
      message: 'Refund ledger changed; reload the order and retry',
    });
  }
}
