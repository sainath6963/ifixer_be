import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { MongoServerError } from 'mongodb';
import { createHash, randomBytes } from 'node:crypto';
import { ClientSession, Connection, Model, Types } from 'mongoose';

import { Cart, CartDocument } from '../../database/schemas/cart.schema';
import { Product } from '../../database/schemas/catalog.schema';
import { Customer } from '../../database/schemas/identity.schema';
import { OutboxEvent } from '../../database/schemas/integration.schema';
import {
  InventoryLevel,
  InventoryMovement,
  InventoryReservation,
  InventoryReservationDocument,
} from '../../database/schemas/inventory.schema';
import { Order, OrderDocument } from '../../database/schemas/order.schema';
import { StoreSetting } from '../../database/schemas/operations.schema';
import {
  AccountStatus,
  AuditActorType,
  CartStatus,
  FinancialStatus,
  FulfillmentStatus,
  InventoryMovementType,
  InventoryReservationStatus,
  OrderLifecycleStatus,
  OutboxStatus,
  ProductStatus,
} from '../../domain/enums';
import type { AuthRequestContext } from '../admin-auth/auth.types';
import { CartService } from '../customer/cart.service';
import { CustomerAuditService } from '../customer/customer-audit.service';
import type { AuthenticatedCustomer } from '../customer/customer.types';
import { PromotionService } from '../promotions/promotion.service';
import { CHECKOUT_EXPIRY_BATCH_SIZE, DEFAULT_RESERVATION_MINUTES } from './checkout.constants';
import type {
  CheckoutPreview,
  CustomerOrderPage,
  CustomerOrderView,
  ShippingAddressView,
} from './checkout.types';
import type {
  CheckoutRequestDto,
  CustomerOrderListQueryDto,
  ShippingAddressDto,
} from './dto/checkout.dto';

type ReleaseTarget = 'CANCELLED' | 'EXPIRED';

interface PreparedOrderItem {
  productId: Types.ObjectId;
  variantId: Types.ObjectId;
  productName: string;
  productSlug: string;
  sku: string;
  variantTitle: string;
  attributes: Array<{ name: string; value: string }>;
  unitPriceInPaise: number;
  discountInPaise: number;
  taxInPaise: number;
  quantity: number;
  lineTotalInPaise: number;
}

@Injectable()
export class CheckoutService {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(Cart.name) private readonly carts: Model<Cart>,
    @InjectModel(Customer.name) private readonly customers: Model<Customer>,
    @InjectModel(Product.name) private readonly products: Model<Product>,
    @InjectModel(InventoryLevel.name) private readonly inventory: Model<InventoryLevel>,
    @InjectModel(InventoryReservation.name)
    private readonly reservations: Model<InventoryReservation>,
    @InjectModel(InventoryMovement.name)
    private readonly movements: Model<InventoryMovement>,
    @InjectModel(Order.name) private readonly orders: Model<Order>,
    @InjectModel(OutboxEvent.name) private readonly outbox: Model<OutboxEvent>,
    @InjectModel(StoreSetting.name) private readonly settings: Model<StoreSetting>,
    private readonly cartService: CartService,
    private readonly audit: CustomerAuditService,
    private readonly promotions: PromotionService,
  ) {}

  async preview(
    customer: AuthenticatedCustomer,
    input: CheckoutRequestDto,
  ): Promise<CheckoutPreview> {
    const cart = (await this.cartService.get({ customerId: customer.id })).cart;
    this.assertCartVersion(cart.version, input.expectedCartVersion);
    if (!cart.items.length) throw this.cartEmpty();
    const reservationMinutes = await this.reservationMinutes();
    const coupon = await this.promotions.evaluate(
      customer.id,
      input.couponCode,
      cart.subtotalInPaise,
    );
    const couponDiscountInPaise = coupon?.discountInPaise ?? 0;
    return {
      cart,
      shippingAddress: this.normalizeAddress(input.shippingAddress),
      totals: {
        subtotalInPaise: cart.subtotalInPaise,
        itemDiscountInPaise: 0,
        couponDiscountInPaise,
        shippingInPaise: 0,
        taxInPaise: 0,
        grandTotalInPaise: cart.subtotalInPaise - couponDiscountInPaise,
        currency: 'INR',
      },
      coupon: coupon
        ? {
            code: coupon.code,
            name: coupon.name,
            discountType: coupon.discountType,
            configuredValue: coupon.configuredValue,
            discountInPaise: coupon.discountInPaise,
            endsAt: coupon.endsAt,
          }
        : undefined,
      reservationMinutes,
      readyToCreateOrder: cart.readyForCheckout,
    };
  }

  async createOrder(
    customer: AuthenticatedCustomer,
    input: CheckoutRequestDto,
    idempotencyKeyInput: string | undefined,
    context: AuthRequestContext,
  ): Promise<CustomerOrderView> {
    const idempotencyKey = this.validateIdempotencyKey(idempotencyKeyInput);
    const shippingAddress = this.normalizeAddress(input.shippingAddress);
    const couponCode = input.couponCode?.trim().toUpperCase();
    const requestHash = this.requestHash(
      customer.id,
      input.expectedCartVersion,
      shippingAddress,
      couponCode,
    );
    const existing = await this.orders.findOne({ idempotencyKey }).exec();
    if (existing) return this.idempotentOrder(existing, customer.id, requestHash);

    const orderId = new Types.ObjectId();
    const orderNumber = this.orderNumber();
    const reservationMinutes = await this.reservationMinutes();
    const now = new Date();
    const paymentExpiresAt = new Date(now.getTime() + reservationMinutes * 60_000);

    try {
      const order = await this.connection.transaction(
        async (session): Promise<OrderDocument> => {
          const duplicate = await this.orders.findOne({ idempotencyKey }).session(session).exec();
          if (duplicate) return this.idempotentDocument(duplicate, customer.id, requestHash);

          const [customerDocument, cart] = await Promise.all([
            this.customers
              .findOne({ _id: customer.id, status: AccountStatus.Active })
              .session(session)
              .exec(),
            this.carts
              .findOne({
                customerId: new Types.ObjectId(customer.id),
                status: CartStatus.Active,
                expiresAt: { $gt: now },
              })
              .session(session)
              .exec(),
          ]);
          if (!customerDocument) {
            throw new ConflictException({
              code: 'CUSTOMER_UNAVAILABLE',
              message: 'Customer account is unavailable',
            });
          }
          if (!cart?.items.length) throw this.cartEmpty();
          this.assertCartVersion(cart.get('version') as number, input.expectedCartVersion);

          const preparedItems = await this.prepareAndReserveItems(cart, session, now);
          const subtotalInPaise = preparedItems.reduce(
            (total, item) => this.safeAdd(total, item.lineTotalInPaise),
            0,
          );
          const coupon = await this.promotions.reserve(
            orderId,
            customerDocument._id,
            couponCode,
            subtotalInPaise,
            paymentExpiresAt,
            session,
          );
          const couponDiscountInPaise = coupon?.discountInPaise ?? 0;
          const grandTotalInPaise = subtotalInPaise - couponDiscountInPaise;
          const [created] = await this.orders.create(
            [
              {
                _id: orderId,
                orderNumber,
                idempotencyKey,
                idempotencyRequestHash: requestHash,
                sourceCartId: cart._id,
                customerId: customerDocument._id,
                customer: {
                  name: customerDocument.name,
                  email: customerDocument.email,
                  mobile: customerDocument.mobile ?? shippingAddress.phone,
                },
                shippingAddress,
                items: preparedItems,
                totals: {
                  subtotalInPaise,
                  itemDiscountInPaise: 0,
                  couponDiscountInPaise,
                  shippingInPaise: 0,
                  taxInPaise: 0,
                  grandTotalInPaise,
                },
                coupon: coupon
                  ? {
                      couponId: new Types.ObjectId(coupon.couponId),
                      code: coupon.code,
                      name: coupon.name,
                      discountType: coupon.discountType,
                      configuredValue: coupon.configuredValue,
                      discountInPaise: coupon.discountInPaise,
                    }
                  : undefined,
                currency: 'INR',
                lifecycleStatus: OrderLifecycleStatus.PendingPayment,
                financialStatus: FinancialStatus.Unpaid,
                fulfillmentStatus: FulfillmentStatus.Unfulfilled,
                paymentExpiresAt,
                statusHistory: [
                  {
                    dimension: 'LIFECYCLE',
                    to: OrderLifecycleStatus.PendingPayment,
                    reason: 'Checkout inventory reserved',
                    actorType: AuditActorType.Customer,
                    actorId: customerDocument._id,
                    occurredAt: now,
                  },
                ],
              },
            ],
            { session },
          );

          await this.createReservationsAndMovements(
            preparedItems,
            created,
            paymentExpiresAt,
            customerDocument._id,
            session,
          );
          customerDocument.lastOrderAt = now;
          await customerDocument.save({ session });
          cart.status = CartStatus.Converted;
          cart.expiresAt = paymentExpiresAt;
          await cart.save({ session });
          await this.outbox.create(
            [
              {
                eventId: `order-created:${orderId.toHexString()}`,
                aggregateType: 'ORDER',
                aggregateId: orderId,
                eventType: 'ORDER_PENDING_PAYMENT_CREATED',
                payload: {
                  orderId: orderId.toHexString(),
                  orderNumber,
                  grandTotalInPaise,
                  currency: 'INR',
                  paymentExpiresAt: paymentExpiresAt.toISOString(),
                },
                status: OutboxStatus.Pending,
                availableAt: now,
              },
            ],
            { session },
          );
          await this.audit.record(
            {
              action: 'CUSTOMER_ORDER_CREATED',
              resourceType: 'ORDER',
              resourceId: orderId.toHexString(),
              actorId: customer.id,
              context,
              metadata: {
                orderNumber,
                itemCount: preparedItems.length,
                couponCode: coupon?.code,
                couponDiscountInPaise,
              },
            },
            session,
          );
          return created;
        },
        {
          readPreference: 'primary',
          readConcern: { level: 'snapshot' },
          writeConcern: { w: 'majority' },
        },
      );
      return this.toView(order);
    } catch (error: unknown) {
      if (error instanceof MongoServerError && error.code === 11000) {
        const duplicate = await this.orders.findOne({ idempotencyKey }).exec();
        if (duplicate) return this.idempotentOrder(duplicate, customer.id, requestHash);
      }
      throw error;
    }
  }

  async list(
    customer: AuthenticatedCustomer,
    query: CustomerOrderListQueryDto,
  ): Promise<CustomerOrderPage> {
    const filter = { customerId: new Types.ObjectId(customer.id) };
    const [documents, total] = await Promise.all([
      this.orders
        .find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip((query.page - 1) * query.limit)
        .limit(query.limit)
        .exec(),
      this.orders.countDocuments(filter),
    ]);
    return {
      items: documents.map((order) => this.toView(order)),
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.ceil(total / query.limit),
    };
  }

  async get(customer: AuthenticatedCustomer, orderNumber: string): Promise<CustomerOrderView> {
    const order = await this.orders
      .findOne({ customerId: new Types.ObjectId(customer.id), orderNumber })
      .exec();
    if (!order) throw this.orderNotFound();
    return this.toView(order);
  }

  async cancel(
    customer: AuthenticatedCustomer,
    orderNumber: string,
    context: AuthRequestContext,
  ): Promise<CustomerOrderView> {
    const order = await this.orders
      .findOne({ customerId: new Types.ObjectId(customer.id), orderNumber })
      .exec();
    if (!order) throw this.orderNotFound();
    return this.toView(await this.releaseOrder(order._id, 'CANCELLED', customer, context));
  }

  async expirePendingOrders(limit = CHECKOUT_EXPIRY_BATCH_SIZE): Promise<number> {
    const candidates = await this.orders
      .find({
        lifecycleStatus: OrderLifecycleStatus.PendingPayment,
        financialStatus: FinancialStatus.Unpaid,
        paymentExpiresAt: { $lte: new Date() },
      })
      .sort({ paymentExpiresAt: 1, _id: 1 })
      .limit(limit)
      .select('_id')
      .exec();
    let expired = 0;
    for (const candidate of candidates) {
      const result = await this.releaseOrder(candidate._id, 'EXPIRED');
      if (result.lifecycleStatus === OrderLifecycleStatus.Expired) expired += 1;
    }
    return expired;
  }

  private async prepareAndReserveItems(
    cart: CartDocument,
    session: ClientSession,
    now: Date,
  ): Promise<PreparedOrderItem[]> {
    const sortedItems = cart.items
      .slice()
      .sort((left, right) =>
        left.variantId.toHexString().localeCompare(right.variantId.toHexString()),
      );
    const productIds = sortedItems.map((item) => item.productId);
    const productDocuments = await this.products
      .find({
        _id: { $in: productIds },
        status: ProductStatus.Active,
        visibility: { $ne: 'REPAIR_INTERNAL' },
        publishedAt: { $lte: now },
      })
      .session(session)
      .exec();
    const productMap = new Map(productDocuments.map((product) => [product.id, product]));
    const preparedItems: PreparedOrderItem[] = [];
    for (const cartItem of sortedItems) {
      const product = productMap.get(cartItem.productId.toHexString());
      const variant = product?.variants.find(
        (candidate) => candidate.variantId.equals(cartItem.variantId) && candidate.isActive,
      );
      if (!product || !variant) throw this.checkoutUnavailable();
      const reserved = await this.inventory
        .findOneAndUpdate(
          {
            productId: product._id,
            variantId: variant.variantId,
            $expr: {
              $gte: [{ $subtract: ['$onHand', '$reserved'] }, cartItem.quantity],
            },
          },
          { $inc: { reserved: cartItem.quantity, version: 1 } },
          { session, returnDocument: 'after' },
        )
        .exec();
      if (!reserved) throw this.checkoutUnavailable();
      const lineTotalInPaise = this.safeMultiply(variant.priceInPaise, cartItem.quantity);
      preparedItems.push({
        productId: product._id,
        variantId: variant.variantId,
        productName: product.name,
        productSlug: product.slug,
        sku: variant.sku,
        variantTitle: variant.title,
        attributes: variant.attributes.map((attribute) => ({
          name: attribute.name,
          value: attribute.value,
        })),
        unitPriceInPaise: variant.priceInPaise,
        discountInPaise: 0,
        taxInPaise: 0,
        quantity: cartItem.quantity,
        lineTotalInPaise,
      });
    }
    return preparedItems;
  }

  private async createReservationsAndMovements(
    items: PreparedOrderItem[],
    order: OrderDocument,
    expiresAt: Date,
    customerId: Types.ObjectId,
    session: ClientSession,
  ): Promise<void> {
    const reservationGroupId = order._id.toHexString();
    await this.reservations.create(
      items.map((item) => ({
        reservationGroupId,
        orderId: order._id,
        productId: item.productId,
        variantId: item.variantId,
        quantity: item.quantity,
        status: InventoryReservationStatus.Active,
        expiresAt,
      })),
      { session },
    );
    await this.movements.create(
      items.map((item) => ({
        productId: item.productId,
        variantId: item.variantId,
        type: InventoryMovementType.Reserve,
        deltaOnHand: 0,
        deltaReserved: item.quantity,
        deltaSold: 0,
        referenceType: 'CHECKOUT_RESERVATION',
        referenceId: order._id.toHexString(),
        actorId: customerId,
        note: `Reserved for ${order.orderNumber}`,
      })),
      { session },
    );
  }

  private async releaseOrder(
    orderId: Types.ObjectId,
    target: ReleaseTarget,
    customer?: AuthenticatedCustomer,
    context?: AuthRequestContext,
  ): Promise<OrderDocument> {
    return this.connection.transaction(
      async (session): Promise<OrderDocument> => {
        const filter: Record<string, unknown> = { _id: orderId };
        if (customer) filter.customerId = new Types.ObjectId(customer.id);
        const order = await this.orders.findOne(filter).session(session).exec();
        if (!order) throw this.orderNotFound();
        if (
          order.lifecycleStatus === OrderLifecycleStatus.Cancelled ||
          order.lifecycleStatus === OrderLifecycleStatus.Expired
        ) {
          return order;
        }
        if (
          order.lifecycleStatus !== OrderLifecycleStatus.PendingPayment ||
          order.financialStatus !== FinancialStatus.Unpaid
        ) {
          if (target === 'EXPIRED') return order;
          throw new ConflictException({
            code: 'ORDER_CANNOT_BE_CANCELLED',
            message: 'Only an unpaid pending order can be cancelled',
          });
        }
        if (target === 'EXPIRED' && order.paymentExpiresAt.getTime() > Date.now()) return order;

        const activeReservations = await this.reservations
          .find({ orderId: order._id, status: InventoryReservationStatus.Active })
          .sort({ variantId: 1 })
          .session(session)
          .exec();
        await this.releaseInventory(activeReservations, order, target, session);
        await this.promotions.releaseOrder(order._id, session);
        const now = new Date();
        await this.reservations.updateMany(
          { orderId: order._id, status: InventoryReservationStatus.Active },
          {
            $set: {
              status:
                target === 'EXPIRED'
                  ? InventoryReservationStatus.Expired
                  : InventoryReservationStatus.Released,
              finalizedAt: now,
            },
          },
          { session },
        );
        const nextLifecycle =
          target === 'EXPIRED' ? OrderLifecycleStatus.Expired : OrderLifecycleStatus.Cancelled;
        order.lifecycleStatus = nextLifecycle;
        order.fulfillmentStatus = FulfillmentStatus.Cancelled;
        order.statusHistory.push({
          dimension: 'LIFECYCLE',
          from: OrderLifecycleStatus.PendingPayment,
          to: nextLifecycle,
          reason: target === 'EXPIRED' ? 'Payment window expired' : 'Cancelled by customer',
          actorType: customer ? AuditActorType.Customer : AuditActorType.System,
          actorId: customer ? new Types.ObjectId(customer.id) : undefined,
          occurredAt: now,
        });
        await order.save({ session });
        const eventSuffix = target === 'EXPIRED' ? 'expired' : 'cancelled';
        await this.outbox.create(
          [
            {
              eventId: `order-${eventSuffix}:${order.id}`,
              aggregateType: 'ORDER',
              aggregateId: order._id,
              eventType: `ORDER_${target}`,
              payload: { orderId: order.id, orderNumber: order.orderNumber },
              status: OutboxStatus.Pending,
              availableAt: now,
            },
          ],
          { session },
        );
        await this.audit.record(
          {
            action: target === 'EXPIRED' ? 'ORDER_PAYMENT_EXPIRED' : 'CUSTOMER_ORDER_CANCELLED',
            resourceType: 'ORDER',
            resourceId: order.id,
            actorId: customer?.id,
            context,
            metadata: { orderNumber: order.orderNumber },
          },
          session,
        );
        return order;
      },
      {
        readPreference: 'primary',
        readConcern: { level: 'snapshot' },
        writeConcern: { w: 'majority' },
      },
    );
  }

  private async releaseInventory(
    reservations: InventoryReservationDocument[],
    order: OrderDocument,
    target: ReleaseTarget,
    session: ClientSession,
  ): Promise<void> {
    for (const reservation of reservations) {
      const result = await this.inventory.updateOne(
        { variantId: reservation.variantId, reserved: { $gte: reservation.quantity } },
        { $inc: { reserved: -reservation.quantity, version: 1 } },
        { session },
      );
      if (result.modifiedCount !== 1) {
        throw new Error(
          `Inventory reservation invariant failed for ${reservation.variantId.toHexString()}`,
        );
      }
    }
    if (reservations.length) {
      const referenceType = target === 'EXPIRED' ? 'ORDER_EXPIRY_RELEASE' : 'ORDER_CANCEL_RELEASE';
      await this.movements.create(
        reservations.map((reservation) => ({
          productId: reservation.productId,
          variantId: reservation.variantId,
          type: InventoryMovementType.Release,
          deltaOnHand: 0,
          deltaReserved: -reservation.quantity,
          deltaSold: 0,
          referenceType,
          referenceId: order.id,
          actorId: target === 'CANCELLED' ? order.customerId : undefined,
          note:
            target === 'EXPIRED'
              ? `Released after ${order.orderNumber} payment expiry`
              : `Released after ${order.orderNumber} cancellation`,
        })),
        { session },
      );
    }
  }

  private idempotentOrder(
    order: OrderDocument,
    customerId: string,
    requestHash: string,
  ): CustomerOrderView {
    return this.toView(this.idempotentDocument(order, customerId, requestHash));
  }

  private idempotentDocument(
    order: OrderDocument,
    customerId: string,
    requestHash: string,
  ): OrderDocument {
    if (
      order.customerId?.toHexString() !== customerId ||
      order.idempotencyRequestHash !== requestHash
    ) {
      throw new ConflictException({
        code: 'IDEMPOTENCY_KEY_REUSED',
        message: 'Idempotency key was already used for a different request',
      });
    }
    return order;
  }

  private toView(order: OrderDocument): CustomerOrderView {
    return {
      id: order.id,
      orderNumber: order.orderNumber,
      customer: {
        name: order.customer.name,
        email: order.customer.email,
        mobile: order.customer.mobile,
      },
      shippingAddress: {
        fullName: order.shippingAddress.fullName,
        phone: order.shippingAddress.phone,
        line1: order.shippingAddress.line1,
        line2: order.shippingAddress.line2,
        city: order.shippingAddress.city,
        state: order.shippingAddress.state,
        postalCode: order.shippingAddress.postalCode,
        countryCode: order.shippingAddress.countryCode as 'IN',
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
              occurredAt: event.occurredAt,
            })),
            lastEventAt: order.shipping.lastEventAt,
            shippedAt: order.shipping.shippedAt,
            deliveredAt: order.shipping.deliveredAt,
          }
        : undefined,
      paymentExpiresAt: order.paymentExpiresAt,
      paymentReady:
        order.lifecycleStatus === OrderLifecycleStatus.PendingPayment &&
        order.financialStatus === FinancialStatus.Unpaid &&
        order.paymentExpiresAt.getTime() > Date.now(),
      statusHistory: order.statusHistory.map((entry) => ({
        dimension: entry.dimension,
        from: entry.from,
        to: entry.to,
        reason: entry.reason,
        occurredAt: entry.occurredAt,
      })),
      createdAt: order.get('createdAt') as Date,
      updatedAt: order.get('updatedAt') as Date,
    };
  }

  private async reservationMinutes(): Promise<number> {
    const setting = await this.settings
      .findOne({ key: 'checkout.inventoryReservationMinutes' })
      .exec();
    return typeof setting?.value === 'number' &&
      Number.isSafeInteger(setting.value) &&
      setting.value >= 1 &&
      setting.value <= 60
      ? setting.value
      : DEFAULT_RESERVATION_MINUTES;
  }

  private normalizeAddress(input: ShippingAddressDto): ShippingAddressView {
    return {
      fullName: input.fullName.trim(),
      phone: input.phone.trim(),
      line1: input.line1.trim(),
      line2: input.line2?.trim() || undefined,
      city: input.city.trim(),
      state: input.state.trim(),
      postalCode: input.postalCode,
      countryCode: 'IN',
    };
  }

  private requestHash(
    customerId: string,
    expectedCartVersion: number,
    shippingAddress: ShippingAddressView,
    couponCode?: string,
  ): string {
    return createHash('sha256')
      .update(JSON.stringify({ customerId, expectedCartVersion, shippingAddress, couponCode }))
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

  private orderNumber(): string {
    const date = new Date().toISOString().slice(0, 10).replaceAll('-', '');
    return `RC-${date}-${randomBytes(5).toString('hex').toUpperCase()}`;
  }

  private safeMultiply(left: number, right: number): number {
    const value = left * right;
    if (!Number.isSafeInteger(value)) throw this.totalOverflow();
    return value;
  }

  private safeAdd(left: number, right: number): number {
    const value = left + right;
    if (!Number.isSafeInteger(value)) throw this.totalOverflow();
    return value;
  }

  private assertCartVersion(actual: number, expected: number): void {
    if (actual !== expected) {
      throw new ConflictException({
        code: 'CART_VERSION_CONFLICT',
        message: 'Cart changed after checkout began; reload checkout and retry',
      });
    }
  }

  private cartEmpty(): ConflictException {
    return new ConflictException({ code: 'CART_EMPTY', message: 'Cart is empty' });
  }

  private checkoutUnavailable(): ConflictException {
    return new ConflictException({
      code: 'CHECKOUT_ITEMS_UNAVAILABLE',
      message: 'One or more cart items are unavailable in the requested quantity',
    });
  }

  private totalOverflow(): ConflictException {
    return new ConflictException({
      code: 'ORDER_TOTAL_INVALID',
      message: 'Order total is outside the supported range',
    });
  }

  private orderNotFound(): NotFoundException {
    return new NotFoundException({ code: 'ORDER_NOT_FOUND', message: 'Order was not found' });
  }
}
