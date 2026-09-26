import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ClientSession, Connection, Model, Types } from 'mongoose';

import { InventoryLevel, InventoryMovement } from '../../database/schemas/inventory.schema';
import { OutboxEvent } from '../../database/schemas/integration.schema';
import { Order, OrderDocument } from '../../database/schemas/order.schema';
import { PaymentAttempt, Refund, RefundDocument } from '../../database/schemas/payment.schema';
import { ReturnRequest } from '../../database/schemas/return-request.schema';
import {
  AuditActorType,
  FinancialStatus,
  FulfillmentStatus,
  InventoryMovementType,
  OrderLifecycleStatus,
  OutboxStatus,
  RefundStatus,
  ReturnRequestStatus,
  ShipmentStatus,
  ShippingProvider,
} from '../../domain/enums';
import { AuthAuditService } from '../admin-auth/auth-audit.service';
import type { AuthenticatedAdmin, AuthRequestContext } from '../admin-auth/auth.types';
import type {
  AdminOrderListQueryDto,
  UpdateAdminNoteDto,
  UpdateFulfillmentDto,
} from './dto/admin-order.dto';
import type {
  AdminOrderDetailView,
  AdminOrderListItemView,
  AdminOrderPage,
  AdminRefundView,
  OrderOperationsSummary,
} from './admin-order.types';

const FULFILLMENT_TRANSITIONS: Record<FulfillmentStatus, FulfillmentStatus[]> = {
  [FulfillmentStatus.Unfulfilled]: [FulfillmentStatus.Processing, FulfillmentStatus.Cancelled],
  [FulfillmentStatus.Processing]: [FulfillmentStatus.Shipped, FulfillmentStatus.Cancelled],
  [FulfillmentStatus.Shipped]: [FulfillmentStatus.Delivered],
  [FulfillmentStatus.Delivered]: [FulfillmentStatus.Returned],
  [FulfillmentStatus.Cancelled]: [],
  [FulfillmentStatus.Returned]: [],
};

@Injectable()
export class AdminOrderService {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(Order.name) private readonly orders: Model<Order>,
    @InjectModel(PaymentAttempt.name) private readonly attempts: Model<PaymentAttempt>,
    @InjectModel(Refund.name) private readonly refunds: Model<Refund>,
    @InjectModel(ReturnRequest.name) private readonly returnRequests: Model<ReturnRequest>,
    @InjectModel(InventoryLevel.name) private readonly inventory: Model<InventoryLevel>,
    @InjectModel(InventoryMovement.name) private readonly movements: Model<InventoryMovement>,
    @InjectModel(OutboxEvent.name) private readonly outbox: Model<OutboxEvent>,
    private readonly audit: AuthAuditService,
  ) {}

  async list(query: AdminOrderListQueryDto): Promise<AdminOrderPage> {
    const filter = this.listFilter(query);
    const skip = (query.page - 1) * query.limit;
    const [documents, total] = await Promise.all([
      this.orders
        .find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip(skip)
        .limit(query.limit)
        .exec(),
      this.orders.countDocuments(filter),
    ]);
    return {
      items: documents.map((order) => this.toListItem(order)),
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.ceil(total / query.limit),
    };
  }

  async get(orderNumber: string): Promise<AdminOrderDetailView> {
    const order = await this.orders.findOne({ orderNumber }).exec();
    if (!order) throw this.notFound();
    const [payment, refunds] = await Promise.all([
      this.attempts.findOne({ orderId: order._id }).exec(),
      this.refunds.find({ orderId: order._id }).sort({ createdAt: -1, _id: -1 }).exec(),
    ]);
    return {
      ...this.toListItem(order),
      shippingAddress: {
        fullName: order.shippingAddress.fullName,
        phone: order.shippingAddress.phone,
        line1: order.shippingAddress.line1,
        line2: order.shippingAddress.line2,
        city: order.shippingAddress.city,
        state: order.shippingAddress.state,
        postalCode: order.shippingAddress.postalCode,
        countryCode: order.shippingAddress.countryCode,
      },
      items: order.items.map((item) => ({
        productId: item.productId.toHexString(),
        variantId: item.variantId.toHexString(),
        productName: item.productName,
        productSlug: item.productSlug,
        sku: item.sku,
        variantTitle: item.variantTitle,
        attributes: item.attributes.map((attribute) => ({
          name: attribute.name,
          value: attribute.value,
        })),
        unitPriceInPaise: item.unitPriceInPaise,
        discountInPaise: item.discountInPaise,
        taxInPaise: item.taxInPaise,
        quantity: item.quantity,
        lineTotalInPaise: item.lineTotalInPaise,
      })),
      totals: {
        subtotalInPaise: order.totals.subtotalInPaise,
        itemDiscountInPaise: order.totals.itemDiscountInPaise,
        couponDiscountInPaise: order.totals.couponDiscountInPaise,
        shippingInPaise: order.totals.shippingInPaise,
        taxInPaise: order.totals.taxInPaise,
        grandTotalInPaise: order.totals.grandTotalInPaise,
      },
      coupon: order.coupon
        ? {
            code: order.coupon.code,
            name: order.coupon.name,
            discountType: order.coupon.discountType,
            configuredValue: order.coupon.configuredValue,
            discountInPaise: order.coupon.discountInPaise,
          }
        : undefined,
      statusHistory: order.statusHistory.map((entry) => ({
        dimension: entry.dimension,
        from: entry.from,
        to: entry.to,
        reason: entry.reason,
        actorType: entry.actorType,
        actorId: entry.actorId?.toHexString(),
        occurredAt: entry.occurredAt,
      })),
      adminNote: order.adminNote,
      payment: payment
        ? {
            id: payment.id,
            provider: payment.provider,
            status: payment.status,
            amountInPaise: payment.amountInPaise,
            currency: payment.currency,
            providerOrderId: payment.providerOrderId,
            providerPaymentId: payment.providerPaymentId,
            signatureVerified: Boolean(payment.signatureVerifiedAt),
            refundedInPaise: payment.refundedInPaise ?? 0,
            refundPendingInPaise: payment.refundPendingInPaise ?? 0,
            capturedAt: payment.capturedAt,
            failureCode: payment.failureCode,
            failureDescription: payment.failureDescription,
          }
        : undefined,
      refunds: refunds.map((refund) => this.toRefundView(refund)),
    };
  }

  async updateFulfillment(
    orderNumber: string,
    input: UpdateFulfillmentDto,
    admin: AuthenticatedAdmin,
    context: AuthRequestContext,
  ): Promise<AdminOrderDetailView> {
    await this.connection.transaction(async (session): Promise<void> => {
      const order = await this.orders.findOne({ orderNumber }).session(session).exec();
      if (!order) throw this.notFound();
      this.assertVersion(order, input.expectedVersion);
      this.assertFulfillmentTransition(order, input);
      if (input.status === FulfillmentStatus.Returned) {
        const itemLevelRequestExists = await this.returnRequests
          .exists({
            orderId: order._id,
            status: {
              $nin: [
                ReturnRequestStatus.Rejected,
                ReturnRequestStatus.Cancelled,
                ReturnRequestStatus.Expired,
              ],
            },
          })
          .session(session);
        if (itemLevelRequestExists) {
          throw new ConflictException({
            code: 'ORDER_HAS_ITEM_RETURN_REQUESTS',
            message: 'Use the item return workflow; whole-order restock is no longer safe',
          });
        }
      }
      if (
        [
          FulfillmentStatus.Processing,
          FulfillmentStatus.Shipped,
          FulfillmentStatus.Delivered,
        ].includes(input.status)
      ) {
        const payment = await this.attempts.findOne({ orderId: order._id }).session(session).exec();
        if ((payment?.refundPendingInPaise ?? 0) > 0) {
          throw new ConflictException({
            code: 'ORDER_REFUND_PENDING',
            message: 'Fulfillment cannot advance while a refund is pending',
          });
        }
      }

      const previousFulfillment = order.fulfillmentStatus;
      const previousLifecycle = order.lifecycleStatus;
      const now = new Date();
      if (input.status === FulfillmentStatus.Shipped) {
        const existing = order.shipping;
        order.shipping = {
          provider: existing?.provider ?? ShippingProvider.Manual,
          status: ShipmentStatus.InTransit,
          courierName: input.courierName?.trim() || existing?.courierName || '',
          trackingNumber:
            input.trackingNumber?.trim().toUpperCase() || existing?.trackingNumber || '',
          trackingUrl: input.trackingUrl?.trim() || existing?.trackingUrl,
          serviceLevel: existing?.serviceLevel,
          estimatedDeliveryAt: existing?.estimatedDeliveryAt,
          trackingEvents: [
            ...(existing?.trackingEvents ?? []),
            {
              status: ShipmentStatus.InTransit,
              message: input.reason?.trim() || 'Shipment handed to courier',
              actorType: AuditActorType.Admin,
              actorId: new Types.ObjectId(admin.id),
              occurredAt: now,
            },
          ],
          lastEventAt: now,
          shippedAt: existing?.shippedAt ?? now,
        };
      } else if (input.status === FulfillmentStatus.Delivered) {
        if (!order.shipping) throw this.invalidTransition();
        order.shipping.status = ShipmentStatus.Delivered;
        order.shipping.lastEventAt = now;
        order.shipping.deliveredAt = now;
        order.shipping.trackingEvents.push({
          status: ShipmentStatus.Delivered,
          message: input.reason?.trim() || 'Shipment delivered',
          actorType: AuditActorType.Admin,
          actorId: new Types.ObjectId(admin.id),
          occurredAt: now,
        });
        order.lifecycleStatus = OrderLifecycleStatus.Completed;
      } else if (input.status === FulfillmentStatus.Returned) {
        await this.restockSoldItems(order, 'RETURNED', admin.id, session);
      } else if (input.status === FulfillmentStatus.Cancelled) {
        await this.restockSoldItems(order, 'CANCELLED', admin.id, session);
        order.lifecycleStatus = OrderLifecycleStatus.Cancelled;
      }
      order.fulfillmentStatus = input.status;
      order.statusHistory.push({
        dimension: 'FULFILLMENT',
        from: previousFulfillment,
        to: input.status,
        reason: input.reason?.trim() || `Admin changed fulfillment to ${input.status}`,
        actorType: AuditActorType.Admin,
        actorId: new Types.ObjectId(admin.id),
        occurredAt: now,
      });
      if (previousLifecycle !== order.lifecycleStatus) {
        order.statusHistory.push({
          dimension: 'LIFECYCLE',
          from: previousLifecycle,
          to: order.lifecycleStatus,
          reason:
            input.status === FulfillmentStatus.Delivered
              ? 'Order delivered'
              : 'Fully refunded order cancelled before shipment',
          actorType: AuditActorType.Admin,
          actorId: new Types.ObjectId(admin.id),
          occurredAt: now,
        });
      }
      await order.save({ session });
      await this.audit.record(
        {
          action: `ORDER_FULFILLMENT_${input.status}`,
          resourceType: 'ORDER',
          resourceId: order.id,
          actorId: admin.id,
          context,
          metadata: {
            orderNumber: order.orderNumber,
            from: previousFulfillment,
            to: input.status,
            trackingNumber: order.shipping?.trackingNumber,
          },
        },
        session,
      );
      await this.outbox.create(
        [
          {
            eventId: `order-fulfillment:${order.id}:${input.status}`,
            aggregateType: 'ORDER',
            aggregateId: order._id,
            eventType: `ORDER_FULFILLMENT_${input.status}`,
            payload: {
              orderId: order.id,
              orderNumber: order.orderNumber,
              fulfillmentStatus: input.status,
              lifecycleStatus: order.lifecycleStatus,
              shipping: order.shipping,
            },
            status: OutboxStatus.Pending,
            availableAt: now,
          },
        ],
        { session },
      );
    }, this.transactionOptions());
    return this.get(orderNumber);
  }

  async updateAdminNote(
    orderNumber: string,
    input: UpdateAdminNoteDto,
    admin: AuthenticatedAdmin,
    context: AuthRequestContext,
  ): Promise<AdminOrderDetailView> {
    await this.connection.transaction(async (session): Promise<void> => {
      const order = await this.orders.findOne({ orderNumber }).session(session).exec();
      if (!order) throw this.notFound();
      this.assertVersion(order, input.expectedVersion);
      order.adminNote = input.adminNote.trim() || undefined;
      await order.save({ session });
      await this.audit.record(
        {
          action: 'ORDER_ADMIN_NOTE_UPDATED',
          resourceType: 'ORDER',
          resourceId: order.id,
          actorId: admin.id,
          context,
          metadata: { orderNumber: order.orderNumber, hasNote: Boolean(order.adminNote) },
        },
        session,
      );
    }, this.transactionOptions());
    return this.get(orderNumber);
  }

  async summary(): Promise<OrderOperationsSummary> {
    const paid = [FinancialStatus.Paid, FinancialStatus.PartiallyRefunded];
    const [
      pendingPayment,
      paidUnfulfilled,
      processing,
      shipped,
      delivered,
      pendingRefunds,
      failedRefunds,
      lateCapturedNeedsRefund,
      deliveryExceptions,
    ] = await Promise.all([
      this.orders.countDocuments({ lifecycleStatus: OrderLifecycleStatus.PendingPayment }),
      this.orders.countDocuments({
        financialStatus: { $in: paid },
        fulfillmentStatus: FulfillmentStatus.Unfulfilled,
      }),
      this.orders.countDocuments({ fulfillmentStatus: FulfillmentStatus.Processing }),
      this.orders.countDocuments({ fulfillmentStatus: FulfillmentStatus.Shipped }),
      this.orders.countDocuments({ fulfillmentStatus: FulfillmentStatus.Delivered }),
      this.refunds.countDocuments({
        status: { $in: [RefundStatus.Pending, RefundStatus.Processing] },
      }),
      this.refunds.countDocuments({ status: RefundStatus.Failed }),
      this.orders.countDocuments({
        lifecycleStatus: { $in: [OrderLifecycleStatus.Cancelled, OrderLifecycleStatus.Expired] },
        financialStatus: { $in: paid },
      }),
      this.orders.countDocuments({ 'shipping.status': ShipmentStatus.DeliveryException }),
    ]);
    return {
      generatedAt: new Date(),
      orders: { pendingPayment, paidUnfulfilled, processing, shipped, delivered },
      refunds: { pending: pendingRefunds, failed: failedRefunds },
      alerts: { lateCapturedNeedsRefund, deliveryExceptions },
    };
  }

  private listFilter(query: AdminOrderListQueryDto): Record<string, unknown> {
    const filter: Record<string, unknown> = {};
    if (query.lifecycleStatus) filter.lifecycleStatus = query.lifecycleStatus;
    if (query.financialStatus) filter.financialStatus = query.financialStatus;
    if (query.fulfillmentStatus) filter.fulfillmentStatus = query.fulfillmentStatus;
    if (query.createdFrom || query.createdTo) {
      const createdAt: Record<string, Date> = {};
      if (query.createdFrom) createdAt.$gte = new Date(query.createdFrom);
      if (query.createdTo) createdAt.$lte = new Date(query.createdTo);
      filter.createdAt = createdAt;
    }
    const search = query.search?.trim();
    if (search) {
      const pattern = new RegExp(this.escapeRegex(search), 'i');
      filter.$or = [
        { orderNumber: pattern },
        { 'customer.name': pattern },
        { 'customer.email': pattern },
        { 'customer.mobile': pattern },
        { 'shippingAddress.phone': pattern },
      ];
    }
    return filter;
  }

  private assertFulfillmentTransition(order: OrderDocument, input: UpdateFulfillmentDto): void {
    if (!FULFILLMENT_TRANSITIONS[order.fulfillmentStatus].includes(input.status)) {
      throw this.invalidTransition();
    }
    if (
      [
        FulfillmentStatus.Processing,
        FulfillmentStatus.Shipped,
        FulfillmentStatus.Delivered,
      ].includes(input.status) &&
      ![FinancialStatus.Paid, FinancialStatus.PartiallyRefunded].includes(order.financialStatus)
    ) {
      throw new ConflictException({
        code: 'ORDER_NOT_PAID_FOR_FULFILLMENT',
        message: 'Only a paid order can move through fulfillment',
      });
    }
    if (
      input.status === FulfillmentStatus.Shipped &&
      (!(input.courierName?.trim() || order.shipping?.courierName) ||
        !(input.trackingNumber?.trim() || order.shipping?.trackingNumber))
    ) {
      throw new ConflictException({
        code: 'SHIPPING_DETAILS_REQUIRED',
        message: 'Courier name and tracking number are required before shipping',
      });
    }
    if (
      input.status === FulfillmentStatus.Cancelled &&
      order.financialStatus !== FinancialStatus.Refunded
    ) {
      throw new ConflictException({
        code: 'ORDER_REFUND_REQUIRED_BEFORE_CANCELLATION',
        message: 'A paid order must be fully refunded before cancellation',
      });
    }
  }

  private async restockSoldItems(
    order: OrderDocument,
    reason: 'RETURNED' | 'CANCELLED',
    adminId: string,
    session: ClientSession,
  ): Promise<void> {
    for (const item of order.items) {
      const result = await this.inventory.updateOne(
        { productId: item.productId, variantId: item.variantId, sold: { $gte: item.quantity } },
        { $inc: { onHand: item.quantity, sold: -item.quantity, version: 1 } },
        { session },
      );
      if (result.modifiedCount !== 1) {
        throw new ConflictException({
          code: 'ORDER_RESTOCK_INVARIANT_FAILED',
          message: 'Sold inventory could not be restored safely',
        });
      }
    }
    await this.movements.create(
      order.items.map((item) => ({
        productId: item.productId,
        variantId: item.variantId,
        type: InventoryMovementType.Return,
        deltaOnHand: item.quantity,
        deltaReserved: 0,
        deltaSold: -item.quantity,
        referenceType: 'ORDER_FULFILLMENT_RESTOCK',
        referenceId: order.id,
        actorId: new Types.ObjectId(adminId),
        note: reason === 'RETURNED' ? 'Delivered order returned' : 'Refunded order cancelled',
      })),
      { session },
    );
  }

  private toListItem(order: OrderDocument): AdminOrderListItemView {
    return {
      id: order.id,
      orderNumber: order.orderNumber,
      customer: {
        name: order.customer.name,
        email: order.customer.email,
        mobile: order.customer.mobile,
      },
      grandTotalInPaise: order.totals.grandTotalInPaise,
      currency: order.currency,
      lifecycleStatus: order.lifecycleStatus,
      financialStatus: order.financialStatus,
      fulfillmentStatus: order.fulfillmentStatus,
      shipping: order.shipping
        ? {
            courierName: order.shipping.courierName,
            trackingNumber: order.shipping.trackingNumber,
            trackingUrl: order.shipping.trackingUrl,
            provider: order.shipping.provider,
            status: order.shipping.status,
            serviceLevel: order.shipping.serviceLevel,
            estimatedDeliveryAt: order.shipping.estimatedDeliveryAt,
            trackingEvents: order.shipping.trackingEvents.map((event) => ({
              status: event.status,
              message: event.message,
              location: event.location,
              actorType: event.actorType,
              occurredAt: event.occurredAt,
            })),
            lastEventAt: order.shipping.lastEventAt,
            shippedAt: order.shipping.shippedAt,
            deliveredAt: order.shipping.deliveredAt,
          }
        : undefined,
      version: order.get('version') as number,
      createdAt: order.get('createdAt') as Date,
      updatedAt: order.get('updatedAt') as Date,
    };
  }

  private toRefundView(refund: RefundDocument): AdminRefundView {
    return {
      id: refund.id,
      refundNumber: refund.refundNumber,
      provider: refund.provider,
      status: refund.status,
      amountInPaise: refund.amountInPaise,
      currency: refund.currency,
      providerRefundId: refund.providerRefundId,
      acquirerReference: refund.acquirerReference,
      reason: refund.reason,
      requestedBy: refund.requestedBy.toHexString(),
      failureCode: refund.failureCode,
      failureDescription: refund.failureDescription,
      processedAt: refund.processedAt,
      createdAt: refund.get('createdAt') as Date,
      updatedAt: refund.get('updatedAt') as Date,
    };
  }

  private assertVersion(order: OrderDocument, expectedVersion: number): void {
    if ((order.get('version') as number) !== expectedVersion) {
      throw new ConflictException({
        code: 'ORDER_VERSION_CONFLICT',
        message: 'Order changed since it was loaded; reload and retry',
      });
    }
  }

  private escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

  private invalidTransition(): ConflictException {
    return new ConflictException({
      code: 'FULFILLMENT_TRANSITION_INVALID',
      message: 'Requested fulfillment transition is not allowed',
    });
  }

  private notFound(): NotFoundException {
    return new NotFoundException({ code: 'ORDER_NOT_FOUND', message: 'Order was not found' });
  }
}
