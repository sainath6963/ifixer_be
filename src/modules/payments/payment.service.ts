import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { MongoServerError } from 'mongodb';
import { createHash } from 'node:crypto';
import { ClientSession, Connection, Model, Types } from 'mongoose';

import {
  InventoryLevel,
  InventoryMovement,
  InventoryReservation,
  InventoryReservationDocument,
} from '../../database/schemas/inventory.schema';
import { OutboxEvent } from '../../database/schemas/integration.schema';
import { Order, OrderDocument } from '../../database/schemas/order.schema';
import { PaymentAttempt, PaymentAttemptDocument } from '../../database/schemas/payment.schema';
import {
  AuditActorType,
  FinancialStatus,
  FulfillmentStatus,
  InventoryMovementType,
  InventoryReservationStatus,
  OrderLifecycleStatus,
  OutboxStatus,
  PaymentAttemptStatus,
  PaymentProvider,
} from '../../domain/enums';
import type { AuthRequestContext } from '../admin-auth/auth.types';
import { CheckoutService } from '../checkout/checkout.service';
import { CustomerAuditService } from '../customer/customer-audit.service';
import type { AuthenticatedCustomer } from '../customer/customer.types';
import { PromotionService } from '../promotions/promotion.service';
import type { VerifyRazorpayPaymentDto } from './dto/payment.dto';
import {
  PAYMENT_RECONCILIATION_BATCH_SIZE,
  PAYMENT_RECONCILIATION_MIN_AGE_MS,
  RAZORPAY_GATEWAY,
} from './payment.constants';
import type {
  PaymentAttemptView,
  PaymentVerificationResult,
  RazorpayCheckoutView,
} from './payment.types';
import type {
  RazorpayGateway,
  RazorpayProviderOrder,
  RazorpayProviderPayment,
} from './razorpay.types';
import { RazorpayGatewayError } from './razorpay.types';

interface ApplyPaymentOptions {
  signatureVerified?: boolean;
  actorId?: string;
  context?: AuthRequestContext;
  source: 'BROWSER' | 'WEBHOOK' | 'RECONCILIATION';
}

interface PaymentApplyResult {
  attempt: PaymentAttemptDocument;
  order: OrderDocument;
}

export interface PaymentReconciliationResult {
  checked: number;
  captured: number;
  failed: number;
}

@Injectable()
export class PaymentService {
  private readonly logger = new Logger(PaymentService.name);

  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(Order.name) private readonly orders: Model<Order>,
    @InjectModel(PaymentAttempt.name) private readonly attempts: Model<PaymentAttempt>,
    @InjectModel(InventoryReservation.name)
    private readonly reservations: Model<InventoryReservation>,
    @InjectModel(InventoryLevel.name) private readonly inventory: Model<InventoryLevel>,
    @InjectModel(InventoryMovement.name)
    private readonly movements: Model<InventoryMovement>,
    @InjectModel(OutboxEvent.name) private readonly outbox: Model<OutboxEvent>,
    @Inject(RAZORPAY_GATEWAY) private readonly gateway: RazorpayGateway,
    private readonly checkout: CheckoutService,
    private readonly audit: CustomerAuditService,
    private readonly promotions: PromotionService,
  ) {}

  async initiate(
    customer: AuthenticatedCustomer,
    orderNumber: string,
    idempotencyKeyInput: string | undefined,
    context: AuthRequestContext,
  ): Promise<RazorpayCheckoutView> {
    const idempotencyKey = this.validateIdempotencyKey(idempotencyKeyInput);
    const order = await this.ownedOrder(customer.id, orderNumber);
    this.assertPaymentCanStart(order);
    const requestHash = this.requestHash(customer.id, order.id);

    const keyAttempt = await this.attempts.findOne({ idempotencyKey }).exec();
    if (keyAttempt) {
      this.assertIdempotentAttempt(keyAttempt, order.id, requestHash);
      const readyAttempt = await this.ensureProviderOrder(keyAttempt, order);
      return this.toCheckoutView(readyAttempt, order);
    }

    let attempt: PaymentAttemptDocument;
    try {
      attempt = await this.connection.transaction(
        async (session): Promise<PaymentAttemptDocument> => {
          const liveOrder = await this.orders
            .findOne({ _id: order._id, customerId: new Types.ObjectId(customer.id) })
            .session(session)
            .exec();
          if (!liveOrder) throw this.orderNotFound();
          this.assertPaymentCanStart(liveOrder);

          const duplicateKey = await this.attempts
            .findOne({ idempotencyKey })
            .session(session)
            .exec();
          if (duplicateKey) {
            this.assertIdempotentAttempt(duplicateKey, liveOrder.id, requestHash);
            return duplicateKey;
          }
          const existing = await this.attempts
            .findOne({ orderId: liveOrder._id, provider: PaymentProvider.Razorpay })
            .session(session)
            .exec();
          if (existing) return existing;

          const [created] = await this.attempts.create(
            [
              {
                orderId: liveOrder._id,
                orderNumber: liveOrder.orderNumber,
                attemptNumber: 1,
                idempotencyKey,
                idempotencyRequestHash: requestHash,
                provider: PaymentProvider.Razorpay,
                providerReceipt: liveOrder.orderNumber,
                amountInPaise: liveOrder.totals.grandTotalInPaise,
                currency: liveOrder.currency,
                status: PaymentAttemptStatus.Creating,
              },
            ],
            { session },
          );
          await this.audit.record(
            {
              action: 'CUSTOMER_PAYMENT_INITIATED',
              resourceType: 'PAYMENT',
              resourceId: created.id,
              actorId: customer.id,
              context,
              metadata: { orderNumber: liveOrder.orderNumber, provider: PaymentProvider.Razorpay },
            },
            session,
          );
          return created;
        },
        this.transactionOptions(),
      );
    } catch (error: unknown) {
      if (!(error instanceof MongoServerError) || error.code !== 11000) throw error;
      const duplicate = await this.attempts
        .findOne({
          $or: [{ idempotencyKey }, { orderId: order._id, provider: PaymentProvider.Razorpay }],
        })
        .exec();
      if (!duplicate) throw error;
      if (duplicate.idempotencyKey === idempotencyKey) {
        this.assertIdempotentAttempt(duplicate, order.id, requestHash);
      }
      attempt = duplicate;
    }

    const readyAttempt = await this.ensureProviderOrder(attempt, order);
    return this.toCheckoutView(readyAttempt, order);
  }

  async verifyBrowserPayment(
    customer: AuthenticatedCustomer,
    orderNumber: string,
    input: VerifyRazorpayPaymentDto,
    context: AuthRequestContext,
  ): Promise<PaymentVerificationResult> {
    const order = await this.ownedOrder(customer.id, orderNumber);
    const attempt = await this.attempts
      .findOne({ orderId: order._id, provider: PaymentProvider.Razorpay })
      .exec();
    if (!attempt?.providerOrderId) throw this.paymentAttemptNotFound();
    if (attempt.providerOrderId !== input.razorpayOrderId) {
      throw new ConflictException({
        code: 'PAYMENT_ORDER_MISMATCH',
        message: 'Payment does not belong to this order',
      });
    }
    if (
      !this.gateway.verifyPaymentSignature(
        attempt.providerOrderId,
        input.razorpayPaymentId,
        input.razorpaySignature,
      )
    ) {
      throw new UnauthorizedException({
        code: 'PAYMENT_SIGNATURE_INVALID',
        message: 'Payment signature verification failed',
      });
    }

    let providerPayment: RazorpayProviderPayment;
    try {
      providerPayment = await this.gateway.fetchPayment(input.razorpayPaymentId);
    } catch (error: unknown) {
      throw this.providerUnavailable(error);
    }
    const result = await this.applyProviderPayment(providerPayment, {
      signatureVerified: true,
      actorId: customer.id,
      context,
      source: 'BROWSER',
    });
    return {
      payment: this.toAttemptView(result.attempt),
      order: await this.checkout.get(customer, result.order.orderNumber),
    };
  }

  async applyProviderPayment(
    providerPayment: RazorpayProviderPayment,
    options: ApplyPaymentOptions,
  ): Promise<PaymentApplyResult> {
    return this.connection.transaction(async (session): Promise<PaymentApplyResult> => {
      const attempt = await this.attempts
        .findOne({ providerOrderId: providerPayment.orderId })
        .session(session)
        .exec();
      if (!attempt) throw this.paymentAttemptNotFound();
      const order = await this.orders.findById(attempt.orderId).session(session).exec();
      if (!order) throw this.orderNotFound();
      this.assertProviderPayment(attempt, providerPayment);
      if (options.signatureVerified && !attempt.signatureVerifiedAt) {
        attempt.signatureVerifiedAt = new Date();
      }

      if (providerPayment.status === 'captured' && providerPayment.captured) {
        await this.capture(attempt, order, providerPayment, options, session);
      } else if (providerPayment.status === 'authorized') {
        await this.authorize(attempt, order, providerPayment, options, session);
      } else if (providerPayment.status === 'failed') {
        await this.fail(attempt, order, providerPayment, options, session);
      } else if (attempt.isModified()) {
        await attempt.save({ session });
      }
      return { attempt, order };
    }, this.transactionOptions());
  }

  async resolveAttempt(providerOrderId: string): Promise<PaymentAttemptDocument | undefined> {
    const existing = await this.attempts.findOne({ providerOrderId }).exec();
    if (existing) return existing;

    let providerOrder: RazorpayProviderOrder;
    try {
      providerOrder = await this.gateway.fetchOrder(providerOrderId);
    } catch (error: unknown) {
      if (error instanceof RazorpayGatewayError && error.statusCode === 404) return undefined;
      throw this.providerUnavailable(error);
    }
    const attempt = await this.attempts.findOne({ providerReceipt: providerOrder.receipt }).exec();
    if (!attempt) return undefined;
    this.assertProviderOrder(attempt, providerOrder);
    return this.attachProviderOrder(attempt, providerOrder);
  }

  async reconcilePending(
    limit = PAYMENT_RECONCILIATION_BATCH_SIZE,
  ): Promise<PaymentReconciliationResult> {
    const threshold = new Date(Date.now() - PAYMENT_RECONCILIATION_MIN_AGE_MS);
    const candidates = await this.attempts
      .find({
        status: {
          $in: [
            PaymentAttemptStatus.Creating,
            PaymentAttemptStatus.Created,
            PaymentAttemptStatus.Authorized,
            PaymentAttemptStatus.Failed,
          ],
        },
        updatedAt: { $lte: threshold },
      })
      .sort({ lastReconciledAt: 1, updatedAt: 1, _id: 1 })
      .limit(limit)
      .exec();
    const result: PaymentReconciliationResult = { checked: 0, captured: 0, failed: 0 };
    for (const candidate of candidates) {
      result.checked += 1;
      try {
        const outcome = await this.reconcileAttempt(candidate);
        if (outcome === PaymentAttemptStatus.Captured) result.captured += 1;
        if (outcome === PaymentAttemptStatus.Failed) result.failed += 1;
      } catch (error: unknown) {
        result.failed += 1;
        this.logger.error(
          `Payment reconciliation failed for ${candidate.id}`,
          error instanceof Error ? error.stack : undefined,
        );
      } finally {
        await this.attempts.updateOne(
          { _id: candidate._id },
          { $set: { lastReconciledAt: new Date() } },
        );
      }
    }
    return result;
  }

  toAttemptView(attempt: PaymentAttemptDocument): PaymentAttemptView {
    return {
      id: attempt.id,
      provider: attempt.provider,
      amountInPaise: attempt.amountInPaise,
      currency: attempt.currency,
      status: attempt.status,
      providerOrderId: attempt.providerOrderId,
      providerPaymentId: attempt.providerPaymentId,
      signatureVerified: Boolean(attempt.signatureVerifiedAt),
      failureCode: attempt.failureCode,
      failureDescription: attempt.failureDescription,
      updatedAt: attempt.get('updatedAt') as Date,
    };
  }

  private async reconcileAttempt(candidate: PaymentAttemptDocument): Promise<PaymentAttemptStatus> {
    const order = await this.orders.findById(candidate.orderId).exec();
    if (!order) return PaymentAttemptStatus.Cancelled;
    let attempt = candidate;
    if (!attempt.providerOrderId) {
      if (
        order.lifecycleStatus !== OrderLifecycleStatus.PendingPayment ||
        ![FinancialStatus.Unpaid, FinancialStatus.Pending].includes(order.financialStatus)
      ) {
        attempt.status = PaymentAttemptStatus.Cancelled;
        await attempt.save();
        return attempt.status;
      }
      attempt = await this.ensureProviderOrder(attempt, order);
    }
    if (!attempt.providerOrderId) return attempt.status;

    const providerOrder = await this.gateway.fetchOrder(attempt.providerOrderId);
    this.assertProviderOrder(attempt, providerOrder);
    if (providerOrder.status === 'created') return attempt.status;
    const payments = await this.gateway.fetchPaymentsForOrder(attempt.providerOrderId);
    const selected = this.selectMostImportantPayment(payments);
    if (!selected) return attempt.status;
    return (
      await this.applyProviderPayment(selected, {
        source: 'RECONCILIATION',
      })
    ).attempt.status;
  }

  private async ensureProviderOrder(
    attempt: PaymentAttemptDocument,
    order: OrderDocument,
  ): Promise<PaymentAttemptDocument> {
    if (attempt.providerOrderId) return attempt;
    let providerOrder: RazorpayProviderOrder | undefined;
    try {
      providerOrder = await this.gateway.findOrderByReceipt(attempt.providerReceipt);
      if (!providerOrder) {
        try {
          providerOrder = await this.gateway.createOrder({
            amountInPaise: attempt.amountInPaise,
            currency: attempt.currency,
            receipt: attempt.providerReceipt,
            internalOrderId: order.id,
            orderNumber: order.orderNumber,
          });
        } catch (createError: unknown) {
          providerOrder = await this.gateway.findOrderByReceipt(attempt.providerReceipt);
          if (!providerOrder) throw createError;
        }
      }
      this.assertProviderOrder(attempt, providerOrder);
      return await this.attachProviderOrder(attempt, providerOrder);
    } catch (error: unknown) {
      await this.attempts.updateOne(
        { _id: attempt._id, providerOrderId: { $exists: false } },
        {
          $set: {
            status: PaymentAttemptStatus.Failed,
            failureCode:
              error instanceof RazorpayGatewayError ? error.code : 'PAYMENT_PROVIDER_UNAVAILABLE',
            failureDescription: 'Unable to create the payment order',
            lastFailureAt: new Date(),
          },
        },
      );
      if (error instanceof BadGatewayException) throw error;
      throw this.providerUnavailable(error);
    }
  }

  private async attachProviderOrder(
    attempt: PaymentAttemptDocument,
    providerOrder: RazorpayProviderOrder,
  ): Promise<PaymentAttemptDocument> {
    const updated = await this.attempts
      .findOneAndUpdate(
        { _id: attempt._id, providerOrderId: { $exists: false } },
        {
          $set: {
            providerOrderId: providerOrder.id,
            status: PaymentAttemptStatus.Created,
            lastReconciledAt: new Date(),
          },
          $unset: { failureCode: 1, failureDescription: 1, lastFailureAt: 1 },
        },
        { returnDocument: 'after' },
      )
      .exec();
    if (updated) return updated;
    return this.attempts.findById(attempt._id).orFail();
  }

  private async authorize(
    attempt: PaymentAttemptDocument,
    order: OrderDocument,
    payment: RazorpayProviderPayment,
    options: ApplyPaymentOptions,
    session: ClientSession,
  ): Promise<void> {
    if (attempt.status === PaymentAttemptStatus.Captured) {
      if (attempt.isModified()) await attempt.save({ session });
      return;
    }
    const firstAuthorization = attempt.status !== PaymentAttemptStatus.Authorized;
    attempt.status = PaymentAttemptStatus.Authorized;
    attempt.providerPaymentId = payment.id;
    attempt.authorizedAt ??= new Date();
    attempt.failureCode = undefined;
    attempt.failureDescription = undefined;
    if (
      order.lifecycleStatus === OrderLifecycleStatus.PendingPayment &&
      order.financialStatus === FinancialStatus.Unpaid
    ) {
      order.financialStatus = FinancialStatus.Pending;
      order.statusHistory.push({
        dimension: 'FINANCIAL',
        from: FinancialStatus.Unpaid,
        to: FinancialStatus.Pending,
        reason: 'Razorpay payment authorized; capture pending',
        actorType: options.actorId ? AuditActorType.Customer : AuditActorType.System,
        actorId: options.actorId ? new Types.ObjectId(options.actorId) : undefined,
        occurredAt: new Date(),
      });
      await order.save({ session });
    }
    await attempt.save({ session });
    if (firstAuthorization) {
      await this.outbox.create(
        [
          {
            eventId: `order-payment-authorized:${order.id}`,
            aggregateType: 'ORDER',
            aggregateId: order._id,
            eventType: 'ORDER_PAYMENT_AUTHORIZED',
            payload: {
              orderId: order.id,
              orderNumber: order.orderNumber,
              providerPaymentId: payment.id,
            },
            status: OutboxStatus.Pending,
            availableAt: new Date(),
          },
        ],
        { session },
      );
      await this.recordPaymentAudit(
        'ORDER_PAYMENT_AUTHORIZED',
        attempt,
        order,
        payment,
        options,
        session,
      );
    }
  }

  private async fail(
    attempt: PaymentAttemptDocument,
    order: OrderDocument,
    payment: RazorpayProviderPayment,
    options: ApplyPaymentOptions,
    session: ClientSession,
  ): Promise<void> {
    if (attempt.status === PaymentAttemptStatus.Captured) {
      if (attempt.isModified()) await attempt.save({ session });
      return;
    }
    const firstFailure =
      attempt.status !== PaymentAttemptStatus.Failed || attempt.providerPaymentId !== payment.id;
    attempt.status = PaymentAttemptStatus.Failed;
    attempt.providerPaymentId = payment.id;
    attempt.failureCode = payment.errorCode ?? 'PAYMENT_FAILED';
    attempt.failureDescription = payment.errorDescription ?? 'Payment was not completed';
    attempt.lastFailureAt = new Date();
    if (
      order.lifecycleStatus === OrderLifecycleStatus.PendingPayment &&
      order.financialStatus === FinancialStatus.Pending
    ) {
      order.financialStatus = FinancialStatus.Unpaid;
      order.statusHistory.push({
        dimension: 'FINANCIAL',
        from: FinancialStatus.Pending,
        to: FinancialStatus.Unpaid,
        reason: 'Razorpay payment failed',
        actorType: AuditActorType.System,
        occurredAt: new Date(),
      });
      await order.save({ session });
    }
    await attempt.save({ session });
    if (!firstFailure) return;
    await this.outbox.create(
      [
        {
          eventId: `payment-failed:${payment.id}`,
          aggregateType: 'ORDER',
          aggregateId: order._id,
          eventType: 'ORDER_PAYMENT_FAILED',
          payload: {
            orderId: order.id,
            orderNumber: order.orderNumber,
            providerPaymentId: payment.id,
            failureCode: attempt.failureCode,
          },
          status: OutboxStatus.Pending,
          availableAt: new Date(),
        },
      ],
      { session },
    );
    await this.recordPaymentAudit(
      'ORDER_PAYMENT_FAILED',
      attempt,
      order,
      payment,
      options,
      session,
    );
  }

  private async capture(
    attempt: PaymentAttemptDocument,
    order: OrderDocument,
    payment: RazorpayProviderPayment,
    options: ApplyPaymentOptions,
    session: ClientSession,
  ): Promise<void> {
    if (
      attempt.status === PaymentAttemptStatus.Captured &&
      order.financialStatus === FinancialStatus.Paid
    ) {
      if (attempt.providerPaymentId !== payment.id) {
        throw new ConflictException({
          code: 'ORDER_ALREADY_PAID_BY_ANOTHER_PAYMENT',
          message: 'Order is already paid by another provider payment',
        });
      }
      if (attempt.isModified()) await attempt.save({ session });
      return;
    }
    if (
      order.financialStatus === FinancialStatus.Paid &&
      attempt.providerPaymentId &&
      attempt.providerPaymentId !== payment.id
    ) {
      throw new ConflictException({
        code: 'ORDER_ALREADY_PAID_BY_ANOTHER_PAYMENT',
        message: 'Order is already paid by another provider payment',
      });
    }

    attempt.status = PaymentAttemptStatus.Captured;
    attempt.providerPaymentId = payment.id;
    attempt.authorizedAt ??= payment.createdAt;
    attempt.capturedAt ??= new Date();
    attempt.failureCode = undefined;
    attempt.failureDescription = undefined;
    await attempt.save({ session });

    const canFulfil = order.lifecycleStatus === OrderLifecycleStatus.PendingPayment;
    if (canFulfil) {
      await this.commitReservedInventory(order, payment, session);
      await this.promotions.redeemOrder(order._id, session);
      const previousFinancialStatus = order.financialStatus;
      order.financialStatus = FinancialStatus.Paid;
      order.lifecycleStatus = OrderLifecycleStatus.Confirmed;
      order.fulfillmentStatus = FulfillmentStatus.Unfulfilled;
      const now = new Date();
      order.statusHistory.push(
        {
          dimension: 'FINANCIAL',
          from: previousFinancialStatus,
          to: FinancialStatus.Paid,
          reason: 'Razorpay payment captured',
          actorType: options.actorId ? AuditActorType.Customer : AuditActorType.System,
          actorId: options.actorId ? new Types.ObjectId(options.actorId) : undefined,
          occurredAt: now,
        },
        {
          dimension: 'LIFECYCLE',
          from: OrderLifecycleStatus.PendingPayment,
          to: OrderLifecycleStatus.Confirmed,
          reason: 'Payment captured and inventory committed',
          actorType: AuditActorType.System,
          occurredAt: now,
        },
      );
      await order.save({ session });
      await this.outbox.create(
        [
          {
            eventId: `order-paid:${order.id}`,
            aggregateType: 'ORDER',
            aggregateId: order._id,
            eventType: 'ORDER_PAYMENT_CAPTURED',
            payload: {
              orderId: order.id,
              orderNumber: order.orderNumber,
              paymentAttemptId: attempt.id,
              providerPaymentId: payment.id,
              amountInPaise: payment.amountInPaise,
              currency: payment.currency,
            },
            status: OutboxStatus.Pending,
            availableAt: now,
          },
        ],
        { session },
      );
      await this.recordPaymentAudit(
        'ORDER_PAYMENT_CAPTURED',
        attempt,
        order,
        payment,
        options,
        session,
      );
      return;
    }

    const previousFinancialStatus = order.financialStatus;
    order.financialStatus = FinancialStatus.Paid;
    order.statusHistory.push({
      dimension: 'FINANCIAL',
      from: previousFinancialStatus,
      to: FinancialStatus.Paid,
      reason: 'Late Razorpay capture requires refund review',
      actorType: AuditActorType.System,
      occurredAt: new Date(),
    });
    await order.save({ session });
    await this.outbox.create(
      [
        {
          eventId: `order-late-payment:${order.id}`,
          aggregateType: 'ORDER',
          aggregateId: order._id,
          eventType: 'ORDER_LATE_PAYMENT_CAPTURED',
          payload: {
            orderId: order.id,
            orderNumber: order.orderNumber,
            paymentAttemptId: attempt.id,
            providerPaymentId: payment.id,
            amountInPaise: payment.amountInPaise,
            currency: payment.currency,
            refundRequired: true,
          },
          status: OutboxStatus.Pending,
          availableAt: new Date(),
        },
      ],
      { session },
    );
    await this.recordPaymentAudit(
      'ORDER_LATE_PAYMENT_CAPTURED',
      attempt,
      order,
      payment,
      options,
      session,
    );
  }

  private async commitReservedInventory(
    order: OrderDocument,
    payment: RazorpayProviderPayment,
    session: ClientSession,
  ): Promise<void> {
    const activeReservations = await this.reservations
      .find({ orderId: order._id, status: InventoryReservationStatus.Active })
      .sort({ variantId: 1 })
      .session(session)
      .exec();
    this.assertReservationSnapshot(order, activeReservations);
    for (const reservation of activeReservations) {
      const updated = await this.inventory.updateOne(
        {
          productId: reservation.productId,
          variantId: reservation.variantId,
          onHand: { $gte: reservation.quantity },
          reserved: { $gte: reservation.quantity },
        },
        {
          $inc: {
            onHand: -reservation.quantity,
            reserved: -reservation.quantity,
            sold: reservation.quantity,
            version: 1,
          },
        },
        { session },
      );
      if (updated.modifiedCount !== 1) {
        throw new Error(
          `Inventory capture invariant failed for ${reservation.variantId.toHexString()}`,
        );
      }
    }
    const finalizedAt = new Date();
    const reservationsResult = await this.reservations.updateMany(
      { orderId: order._id, status: InventoryReservationStatus.Active },
      { $set: { status: InventoryReservationStatus.Committed, finalizedAt } },
      { session },
    );
    if (reservationsResult.modifiedCount !== activeReservations.length) {
      throw new Error(`Reservation capture invariant failed for order ${order.id}`);
    }
    await this.movements.create(
      activeReservations.map((reservation) => ({
        productId: reservation.productId,
        variantId: reservation.variantId,
        type: InventoryMovementType.Sale,
        deltaOnHand: -reservation.quantity,
        deltaReserved: -reservation.quantity,
        deltaSold: reservation.quantity,
        referenceType: 'PAYMENT_CAPTURE_COMMIT',
        referenceId: order.id,
        note: `Committed after Razorpay payment ${payment.id}`,
      })),
      { session },
    );
  }

  private assertReservationSnapshot(
    order: OrderDocument,
    reservations: InventoryReservationDocument[],
  ): void {
    if (reservations.length !== order.items.length) {
      throw new Error(`Reservation snapshot incomplete for order ${order.id}`);
    }
    const quantities = new Map(
      order.items.map((item) => [item.variantId.toHexString(), item.quantity]),
    );
    for (const reservation of reservations) {
      if (quantities.get(reservation.variantId.toHexString()) !== reservation.quantity) {
        throw new Error(`Reservation quantity mismatch for order ${order.id}`);
      }
    }
  }

  private assertProviderOrder(
    attempt: PaymentAttemptDocument,
    providerOrder: RazorpayProviderOrder,
  ): void {
    if (
      providerOrder.receipt !== attempt.providerReceipt ||
      providerOrder.amountInPaise !== attempt.amountInPaise ||
      providerOrder.currency !== attempt.currency
    ) {
      throw new BadGatewayException({
        code: 'PAYMENT_PROVIDER_ORDER_MISMATCH',
        message: 'Razorpay order did not match the internal order',
      });
    }
  }

  private assertProviderPayment(
    attempt: PaymentAttemptDocument,
    payment: RazorpayProviderPayment,
  ): void {
    if (
      attempt.providerOrderId !== payment.orderId ||
      attempt.amountInPaise !== payment.amountInPaise ||
      attempt.currency !== payment.currency
    ) {
      throw new ConflictException({
        code: 'PAYMENT_PROVIDER_DATA_MISMATCH',
        message: 'Provider payment does not match the internal payment attempt',
      });
    }
  }

  private assertPaymentCanStart(order: OrderDocument): void {
    if (
      order.lifecycleStatus !== OrderLifecycleStatus.PendingPayment ||
      ![FinancialStatus.Unpaid, FinancialStatus.Pending].includes(order.financialStatus) ||
      order.paymentExpiresAt.getTime() <= Date.now()
    ) {
      throw new ConflictException({
        code: 'ORDER_NOT_PAYABLE',
        message: 'Order is no longer available for payment',
      });
    }
    if (order.totals.grandTotalInPaise < 1) {
      throw new ConflictException({
        code: 'ORDER_TOTAL_NOT_PAYABLE',
        message: 'Order total is not payable through Razorpay',
      });
    }
  }

  private assertIdempotentAttempt(
    attempt: PaymentAttemptDocument,
    orderId: string,
    requestHash: string,
  ): void {
    if (
      attempt.orderId.toHexString() !== orderId ||
      attempt.idempotencyRequestHash !== requestHash
    ) {
      throw new ConflictException({
        code: 'IDEMPOTENCY_KEY_REUSED',
        message: 'Idempotency key was already used for a different payment request',
      });
    }
  }

  private toCheckoutView(
    attempt: PaymentAttemptDocument,
    order: OrderDocument,
  ): RazorpayCheckoutView {
    if (!attempt.providerOrderId) throw this.providerUnavailable();
    return {
      paymentAttemptId: attempt.id,
      provider: PaymentProvider.Razorpay,
      keyId: this.gateway.keyId,
      providerOrderId: attempt.providerOrderId,
      amountInPaise: attempt.amountInPaise,
      currency: attempt.currency,
      checkoutName: this.gateway.checkoutName,
      description: `Order ${order.orderNumber}`,
      prefill: {
        name: order.customer.name,
        email: order.customer.email,
        contact: order.customer.mobile ?? order.shippingAddress.phone,
      },
      expiresAt: order.paymentExpiresAt,
    };
  }

  private selectMostImportantPayment(
    payments: RazorpayProviderPayment[],
  ): RazorpayProviderPayment | undefined {
    const priority: Record<RazorpayProviderPayment['status'], number> = {
      captured: 5,
      authorized: 4,
      refunded: 3,
      failed: 2,
      created: 1,
    };
    return payments
      .slice()
      .sort(
        (left, right) =>
          priority[right.status] - priority[left.status] ||
          right.createdAt.getTime() - left.createdAt.getTime(),
      )[0];
  }

  private async recordPaymentAudit(
    action: string,
    attempt: PaymentAttemptDocument,
    order: OrderDocument,
    payment: RazorpayProviderPayment,
    options: ApplyPaymentOptions,
    session: ClientSession,
  ): Promise<void> {
    await this.audit.record(
      {
        action,
        resourceType: 'PAYMENT',
        resourceId: attempt.id,
        actorId: options.actorId,
        context: options.context,
        metadata: {
          orderNumber: order.orderNumber,
          provider: PaymentProvider.Razorpay,
          providerPaymentId: payment.id,
          source: options.source,
        },
      },
      session,
    );
  }

  private async ownedOrder(customerId: string, orderNumber: string): Promise<OrderDocument> {
    const order = await this.orders
      .findOne({ customerId: new Types.ObjectId(customerId), orderNumber })
      .exec();
    if (!order) throw this.orderNotFound();
    return order;
  }

  private requestHash(customerId: string, orderId: string): string {
    return createHash('sha256').update(JSON.stringify({ customerId, orderId })).digest('hex');
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

  private providerUnavailable(error?: unknown): ServiceUnavailableException {
    const retryable = error instanceof RazorpayGatewayError ? error.retryable : true;
    return new ServiceUnavailableException({
      code: 'PAYMENT_PROVIDER_UNAVAILABLE',
      message: retryable
        ? 'Payment provider is temporarily unavailable; retry with the same idempotency key'
        : 'Payment provider rejected the request',
    });
  }

  private orderNotFound(): NotFoundException {
    return new NotFoundException({ code: 'ORDER_NOT_FOUND', message: 'Order was not found' });
  }

  private paymentAttemptNotFound(): NotFoundException {
    return new NotFoundException({
      code: 'PAYMENT_ATTEMPT_NOT_FOUND',
      message: 'Payment attempt was not found',
    });
  }
}
