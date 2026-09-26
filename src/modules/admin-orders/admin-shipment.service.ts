import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ClientSession, Connection, Model, Types } from 'mongoose';

import { OutboxEvent } from '../../database/schemas/integration.schema';
import { Order, OrderDocument, ShippingDetails } from '../../database/schemas/order.schema';
import { PaymentAttempt } from '../../database/schemas/payment.schema';
import {
  AuditActorType,
  FinancialStatus,
  FulfillmentStatus,
  OrderLifecycleStatus,
  OutboxStatus,
  PaymentAttemptStatus,
  ShipmentStatus,
  ShippingProvider,
} from '../../domain/enums';
import { AuthAuditService } from '../admin-auth/auth-audit.service';
import type { AuthenticatedAdmin, AuthRequestContext } from '../admin-auth/auth.types';
import type { CreateShipmentDto, UpdateShipmentStatusDto } from './dto/admin-shipment.dto';

const SHIPMENT_TRANSITIONS: Record<ShipmentStatus, ShipmentStatus[]> = {
  [ShipmentStatus.ReadyToShip]: [ShipmentStatus.InTransit],
  [ShipmentStatus.InTransit]: [
    ShipmentStatus.OutForDelivery,
    ShipmentStatus.DeliveryException,
    ShipmentStatus.Delivered,
  ],
  [ShipmentStatus.OutForDelivery]: [ShipmentStatus.DeliveryException, ShipmentStatus.Delivered],
  [ShipmentStatus.DeliveryException]: [
    ShipmentStatus.InTransit,
    ShipmentStatus.OutForDelivery,
    ShipmentStatus.Delivered,
  ],
  [ShipmentStatus.Delivered]: [],
};

@Injectable()
export class AdminShipmentService {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(Order.name) private readonly orders: Model<Order>,
    @InjectModel(PaymentAttempt.name) private readonly attempts: Model<PaymentAttempt>,
    @InjectModel(OutboxEvent.name) private readonly outbox: Model<OutboxEvent>,
    private readonly audit: AuthAuditService,
  ) {}

  async create(
    orderNumber: string,
    input: CreateShipmentDto,
    admin: AuthenticatedAdmin,
    context: AuthRequestContext,
  ): Promise<void> {
    await this.connection.transaction(async (session): Promise<void> => {
      const order = await this.orders.findOne({ orderNumber }).session(session).exec();
      if (!order) throw this.notFound();
      this.assertVersion(order, input.expectedVersion);
      if (order.shipping) {
        throw new ConflictException({
          code: 'SHIPMENT_ALREADY_EXISTS',
          message: 'This order already has a shipment',
        });
      }
      if (order.fulfillmentStatus !== FulfillmentStatus.Processing) {
        throw new ConflictException({
          code: 'ORDER_NOT_READY_FOR_SHIPMENT',
          message: 'Move the paid order to processing before creating its shipment',
        });
      }
      await this.assertPaymentAllowsShipment(order, session);

      const now = new Date();
      const estimatedDeliveryAt = input.estimatedDeliveryAt
        ? new Date(input.estimatedDeliveryAt)
        : undefined;
      if (estimatedDeliveryAt && estimatedDeliveryAt.getTime() <= now.getTime()) {
        throw new BadRequestException({
          code: 'SHIPMENT_ESTIMATE_INVALID',
          message: 'Estimated delivery must be in the future',
        });
      }
      const courierName = input.courierName.trim();
      const trackingNumber = input.trackingNumber.trim().toUpperCase();
      const duplicate = await this.orders
        .exists({
          _id: { $ne: order._id },
          'shipping.courierName': courierName,
          'shipping.trackingNumber': trackingNumber,
        })
        .session(session);
      if (duplicate) {
        throw new ConflictException({
          code: 'SHIPMENT_TRACKING_ALREADY_EXISTS',
          message: 'This courier tracking number is already assigned to another order',
        });
      }

      order.shipping = {
        provider: ShippingProvider.Manual,
        status: ShipmentStatus.ReadyToShip,
        courierName,
        trackingNumber,
        trackingUrl: input.trackingUrl?.trim(),
        serviceLevel: input.serviceLevel?.trim(),
        estimatedDeliveryAt,
        trackingEvents: [
          {
            status: ShipmentStatus.ReadyToShip,
            message: 'Shipment booked and ready for courier handover',
            actorType: AuditActorType.Admin,
            actorId: new Types.ObjectId(admin.id),
            occurredAt: now,
          },
        ],
        lastEventAt: now,
      };
      order.statusHistory.push({
        dimension: 'SHIPMENT',
        to: ShipmentStatus.ReadyToShip,
        reason: 'Shipment created',
        actorType: AuditActorType.Admin,
        actorId: new Types.ObjectId(admin.id),
        occurredAt: now,
      });
      await order.save({ session });
      await this.audit.record(
        {
          action: 'ORDER_SHIPMENT_CREATED',
          resourceType: 'ORDER',
          resourceId: order.id,
          actorId: admin.id,
          context,
          metadata: {
            orderNumber: order.orderNumber,
            provider: ShippingProvider.Manual,
            courierName,
            trackingNumber,
          },
        },
        session,
      );
      await this.outbox.create(
        [
          {
            eventId: `order-shipment:${order.id}:created`,
            aggregateType: 'ORDER',
            aggregateId: order._id,
            eventType: 'ORDER_SHIPMENT_CREATED',
            payload: this.eventPayload(order),
            status: OutboxStatus.Pending,
            availableAt: now,
          },
        ],
        { session },
      );
    }, this.transactionOptions());
  }

  async updateStatus(
    orderNumber: string,
    input: UpdateShipmentStatusDto,
    admin: AuthenticatedAdmin,
    context: AuthRequestContext,
  ): Promise<void> {
    await this.connection.transaction(async (session): Promise<void> => {
      const order = await this.orders.findOne({ orderNumber }).session(session).exec();
      if (!order) throw this.notFound();
      this.assertVersion(order, input.expectedVersion);
      const shipping = order.shipping;
      if (!shipping) {
        throw new ConflictException({
          code: 'SHIPMENT_NOT_CREATED',
          message: 'Create a shipment before recording tracking events',
        });
      }
      if (!SHIPMENT_TRANSITIONS[shipping.status].includes(input.status)) {
        throw new ConflictException({
          code: 'SHIPMENT_TRANSITION_INVALID',
          message: `Shipment cannot move from ${shipping.status} to ${input.status}`,
        });
      }
      if (shipping.trackingEvents.length >= 100) {
        throw new ConflictException({
          code: 'SHIPMENT_EVENT_LIMIT_REACHED',
          message: 'Shipment tracking history reached its safety limit',
        });
      }
      if (input.status !== ShipmentStatus.DeliveryException) {
        await this.assertPaymentAllowsShipment(order, session);
      }

      const now = new Date();
      const occurredAt = input.occurredAt ? new Date(input.occurredAt) : now;
      if (occurredAt.getTime() > now.getTime() + 5 * 60_000) {
        throw new BadRequestException({
          code: 'SHIPMENT_EVENT_TIME_INVALID',
          message: 'Shipment event time cannot be more than five minutes in the future',
        });
      }
      if (occurredAt.getTime() <= shipping.lastEventAt.getTime()) {
        throw new ConflictException({
          code: 'SHIPMENT_EVENT_OUT_OF_ORDER',
          message: 'Shipment events must be newer than the latest recorded event',
        });
      }

      const previousShipment = shipping.status;
      const previousFulfillment = order.fulfillmentStatus;
      const previousLifecycle = order.lifecycleStatus;
      this.synchronizeOrderState(order, input.status, occurredAt);
      shipping.status = input.status;
      shipping.lastEventAt = occurredAt;
      shipping.trackingEvents.push({
        status: input.status,
        message: input.message.trim(),
        location: input.location?.trim(),
        actorType: AuditActorType.Admin,
        actorId: new Types.ObjectId(admin.id),
        occurredAt,
      });
      order.statusHistory.push({
        dimension: 'SHIPMENT',
        from: previousShipment,
        to: input.status,
        reason: input.message.trim(),
        actorType: AuditActorType.Admin,
        actorId: new Types.ObjectId(admin.id),
        occurredAt,
      });
      if (previousFulfillment !== order.fulfillmentStatus) {
        order.statusHistory.push({
          dimension: 'FULFILLMENT',
          from: previousFulfillment,
          to: order.fulfillmentStatus,
          reason: input.message.trim(),
          actorType: AuditActorType.Admin,
          actorId: new Types.ObjectId(admin.id),
          occurredAt,
        });
      }
      if (previousLifecycle !== order.lifecycleStatus) {
        order.statusHistory.push({
          dimension: 'LIFECYCLE',
          from: previousLifecycle,
          to: order.lifecycleStatus,
          reason: 'Shipment delivered',
          actorType: AuditActorType.Admin,
          actorId: new Types.ObjectId(admin.id),
          occurredAt,
        });
      }
      await order.save({ session });

      const eventType = this.outboxEventType(input.status);
      await this.audit.record(
        {
          action: `ORDER_SHIPMENT_${input.status}`,
          resourceType: 'ORDER',
          resourceId: order.id,
          actorId: admin.id,
          context,
          metadata: {
            orderNumber: order.orderNumber,
            from: previousShipment,
            to: input.status,
            trackingNumber: shipping.trackingNumber,
          },
        },
        session,
      );
      await this.outbox.create(
        [
          {
            eventId: `order-shipment:${order.id}:${input.expectedVersion}:${input.status}`,
            aggregateType: 'ORDER',
            aggregateId: order._id,
            eventType,
            payload: this.eventPayload(order),
            status: OutboxStatus.Pending,
            availableAt: now,
          },
        ],
        { session },
      );
    }, this.transactionOptions());
  }

  private synchronizeOrderState(
    order: OrderDocument,
    status: ShipmentStatus,
    occurredAt: Date,
  ): void {
    if (status === ShipmentStatus.InTransit) {
      if (
        ![FulfillmentStatus.Processing, FulfillmentStatus.Shipped].includes(order.fulfillmentStatus)
      ) {
        throw this.orderStateConflict();
      }
      order.fulfillmentStatus = FulfillmentStatus.Shipped;
      if (order.shipping) order.shipping.shippedAt ??= occurredAt;
      return;
    }
    if (
      [
        ShipmentStatus.OutForDelivery,
        ShipmentStatus.DeliveryException,
        ShipmentStatus.Delivered,
      ].includes(status) &&
      order.fulfillmentStatus !== FulfillmentStatus.Shipped
    ) {
      throw this.orderStateConflict();
    }
    if (status === ShipmentStatus.Delivered && order.shipping) {
      order.fulfillmentStatus = FulfillmentStatus.Delivered;
      order.lifecycleStatus = OrderLifecycleStatus.Completed;
      order.shipping.deliveredAt = occurredAt;
    }
  }

  private async assertPaymentAllowsShipment(
    order: OrderDocument,
    session: ClientSession,
  ): Promise<void> {
    if (
      ![FinancialStatus.Paid, FinancialStatus.PartiallyRefunded].includes(order.financialStatus)
    ) {
      throw new ConflictException({
        code: 'ORDER_NOT_PAID_FOR_SHIPMENT',
        message: 'Only a paid order can move through shipment tracking',
      });
    }
    const payment = await this.attempts.findOne({ orderId: order._id }).session(session).exec();
    if (!payment || payment.status !== PaymentAttemptStatus.Captured) {
      throw new ConflictException({
        code: 'ORDER_CAPTURED_PAYMENT_REQUIRED',
        message: 'Shipment tracking requires a captured provider payment',
      });
    }
    if ((payment.refundPendingInPaise ?? 0) > 0) {
      throw new ConflictException({
        code: 'ORDER_REFUND_PENDING',
        message: 'Shipment cannot advance while a refund is pending',
      });
    }
  }

  private eventPayload(order: OrderDocument): Record<string, unknown> {
    const shipping = order.shipping as ShippingDetails;
    return {
      orderId: order.id,
      orderNumber: order.orderNumber,
      fulfillmentStatus: order.fulfillmentStatus,
      lifecycleStatus: order.lifecycleStatus,
      shipmentStatus: shipping.status,
      provider: shipping.provider,
      courierName: shipping.courierName,
      trackingNumber: shipping.trackingNumber,
      trackingUrl: shipping.trackingUrl,
      estimatedDeliveryAt: shipping.estimatedDeliveryAt,
      lastEventAt: shipping.lastEventAt,
    };
  }

  private outboxEventType(status: ShipmentStatus): string {
    if (status === ShipmentStatus.InTransit) return 'ORDER_FULFILLMENT_SHIPPED';
    if (status === ShipmentStatus.Delivered) return 'ORDER_FULFILLMENT_DELIVERED';
    return `ORDER_SHIPMENT_${status}`;
  }

  private assertVersion(order: OrderDocument, expectedVersion: number): void {
    if ((order.get('version') as number) !== expectedVersion) {
      throw new ConflictException({
        code: 'ORDER_VERSION_CONFLICT',
        message: 'Order changed since it was loaded; reload and retry',
      });
    }
  }

  private orderStateConflict(): ConflictException {
    return new ConflictException({
      code: 'SHIPMENT_ORDER_STATE_CONFLICT',
      message: 'Order fulfillment state is inconsistent with this shipment transition',
    });
  }

  private notFound(): NotFoundException {
    return new NotFoundException({ code: 'ORDER_NOT_FOUND', message: 'Order was not found' });
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
}
