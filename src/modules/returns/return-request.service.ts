import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { MongoServerError } from 'mongodb';
import { createHash, randomBytes } from 'node:crypto';
import { ClientSession, Connection, Model, Types } from 'mongoose';

import { Product } from '../../database/schemas/catalog.schema';
import { OutboxEvent } from '../../database/schemas/integration.schema';
import {
  InventoryLevel,
  InventoryMovement,
  InventoryReservation,
  InventoryReservationDocument,
} from '../../database/schemas/inventory.schema';
import { Order, OrderDocument } from '../../database/schemas/order.schema';
import { Refund } from '../../database/schemas/payment.schema';
import { ReturnRequest, ReturnRequestDocument } from '../../database/schemas/return-request.schema';
import {
  AuditActorType,
  ExchangeReservationStatus,
  FinancialStatus,
  FulfillmentStatus,
  InventoryMovementType,
  InventoryReservationStatus,
  OutboxStatus,
  ProductStatus,
  RefundStatus,
  ReturnRequestStatus,
  ReturnRequestType,
  ReturnResolutionType,
} from '../../domain/enums';
import { AuthAuditService } from '../admin-auth/auth-audit.service';
import type { AuthenticatedAdmin, AuthRequestContext } from '../admin-auth/auth.types';
import { CustomerAuditService } from '../customer/customer-audit.service';
import type { AuthenticatedCustomer } from '../customer/customer.types';
import type {
  AdminReturnListQueryDto,
  CancelReturnRequestDto,
  CompleteReturnRequestDto,
  CreateReturnRequestDto,
  DecideReturnRequestDto,
  ReceiveReturnRequestDto,
} from './dto/return-request.dto';
import {
  ALLOCATED_RETURN_STATUSES,
  allocatedReturnQuantities,
  estimatedItemValue,
  returnDeadline,
} from './return-policy';
import type {
  AdminReturnRequestPage,
  AdminReturnRequestView,
  CustomerReturnsView,
  ReturnEligibilityItemView,
  ReturnRequestView,
} from './return-request.types';

@Injectable()
export class ReturnRequestService {
  private readonly windowDays: number;
  private readonly exchangeReservationTtlMs: number;

  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(Order.name) private readonly orders: Model<Order>,
    @InjectModel(Product.name) private readonly products: Model<Product>,
    @InjectModel(InventoryLevel.name) private readonly inventory: Model<InventoryLevel>,
    @InjectModel(InventoryMovement.name) private readonly movements: Model<InventoryMovement>,
    @InjectModel(InventoryReservation.name)
    private readonly reservations: Model<InventoryReservation>,
    @InjectModel(Refund.name) private readonly refunds: Model<Refund>,
    @InjectModel(ReturnRequest.name) private readonly requests: Model<ReturnRequest>,
    @InjectModel(OutboxEvent.name) private readonly outbox: Model<OutboxEvent>,
    private readonly customerAudit: CustomerAuditService,
    private readonly adminAudit: AuthAuditService,
    config: ConfigService,
  ) {
    this.windowDays = config.getOrThrow<number>('CUSTOMER_RETURN_WINDOW_DAYS');
    this.exchangeReservationTtlMs =
      config.getOrThrow<number>('EXCHANGE_RESERVATION_TTL_DAYS') * 24 * 60 * 60 * 1000;
  }

  async customerOrderReturns(
    customer: AuthenticatedCustomer,
    orderNumber: string,
  ): Promise<CustomerReturnsView> {
    const order = await this.ownedOrder(customer.id, orderNumber);
    const requests = await this.requests
      .find({ orderId: order._id, customerId: order.customerId })
      .sort({ createdAt: -1, _id: -1 })
      .exec();
    const allocated = allocatedReturnQuantities(requests);
    const items = await this.eligibilityItems(order, allocated);
    const deadline = order.shipping?.deliveredAt
      ? returnDeadline(order.shipping.deliveredAt, this.windowDays)
      : undefined;
    const reason = this.ineligibilityReason(order, deadline, items);
    return {
      eligibility: {
        eligible: !reason,
        reason,
        deliveredAt: order.shipping?.deliveredAt,
        deadline,
        windowDays: this.windowDays,
        items,
      },
      requests: requests.map((request) => this.toCustomerView(request)),
    };
  }

  async create(
    customer: AuthenticatedCustomer,
    orderNumber: string,
    input: CreateReturnRequestDto,
    idempotencyValue: string | undefined,
    context: AuthRequestContext,
  ): Promise<ReturnRequestView> {
    const idempotencyKey = this.validateIdempotencyKey(idempotencyValue);
    const normalized = this.normalizedInput(input);
    const requestHash = createHash('sha256')
      .update(JSON.stringify({ orderNumber, ...normalized }))
      .digest('hex');
    const existing = await this.requests
      .findOne({ customerId: new Types.ObjectId(customer.id), idempotencyKey })
      .exec();
    if (existing) return this.idempotentCustomerView(existing, orderNumber, requestHash);

    try {
      const created = await this.connection.transaction(async (session) => {
        const order = await this.orders
          .findOne({ customerId: new Types.ObjectId(customer.id), orderNumber })
          .session(session)
          .exec();
        if (!order) throw this.notFound('ORDER_NOT_FOUND', 'Order was not found');
        const existingRequests = await this.requests
          .find({ orderId: order._id, status: { $in: ALLOCATED_RETURN_STATUSES } })
          .session(session)
          .exec();
        const allocated = allocatedReturnQuantities(existingRequests);
        const eligibilityItems = await this.eligibilityItems(order, allocated, session);
        const deadline = order.shipping?.deliveredAt
          ? returnDeadline(order.shipping.deliveredAt, this.windowDays)
          : undefined;
        const ineligibility = this.ineligibilityReason(order, deadline, eligibilityItems);
        if (ineligibility) {
          throw new ConflictException({
            code: 'RETURN_NOT_ELIGIBLE',
            message: ineligibility,
          });
        }

        const byVariant = new Map(order.items.map((item) => [item.variantId.toHexString(), item]));
        const eligibilityByVariant = new Map(
          eligibilityItems.map((item) => [item.variantId, item]),
        );
        const requestedIds = normalized.items.map((item) => item.variantId);
        if (new Set(requestedIds).size !== requestedIds.length) {
          throw new BadRequestException({
            code: 'RETURN_ITEM_DUPLICATE',
            message: 'Each ordered variant may be requested only once',
          });
        }

        const preparedItems = [];
        for (const requested of normalized.items) {
          const orderItem = byVariant.get(requested.variantId);
          const eligibility = eligibilityByVariant.get(requested.variantId);
          if (!orderItem || !eligibility) {
            throw new BadRequestException({
              code: 'RETURN_ITEM_NOT_IN_ORDER',
              message: 'A requested item does not belong to this order',
            });
          }
          if (requested.quantity > eligibility.availableQuantity) {
            throw new ConflictException({
              code: 'RETURN_QUANTITY_UNAVAILABLE',
              message: `Only ${eligibility.availableQuantity} unit(s) of ${orderItem.sku} remain eligible`,
            });
          }
          const requestedExchangeVariant = await this.exchangeTarget(
            input.type,
            orderItem.productId,
            orderItem.variantId,
            requested.requestedExchangeVariantId,
            session,
          );
          preparedItems.push({
            productId: orderItem.productId,
            variantId: orderItem.variantId,
            productName: orderItem.productName,
            sku: orderItem.sku,
            variantTitle: orderItem.variantTitle,
            quantity: requested.quantity,
            reason: requested.reason,
            reasonDetail: requested.reasonDetail,
            requestedExchangeVariant,
            estimatedValueInPaise: estimatedItemValue(orderItem, requested.quantity),
            restockedQuantity: 0,
          });
        }

        const now = new Date();
        order.returnAllocationRevision = (order.returnAllocationRevision ?? 0) + 1;
        await order.save({ session });
        const [request] = await this.requests.create(
          [
            {
              returnNumber: this.returnNumber(now),
              orderId: order._id,
              orderNumber: order.orderNumber,
              customerId: order.customerId,
              type: input.type,
              status: ReturnRequestStatus.Requested,
              items: preparedItems,
              customerNote: normalized.customerNote,
              idempotencyKey,
              idempotencyRequestHash: requestHash,
              requestedAt: now,
              statusHistory: [
                {
                  status: ReturnRequestStatus.Requested,
                  actorType: AuditActorType.Customer,
                  actorId: order.customerId,
                  occurredAt: now,
                },
              ],
            },
          ],
          { session },
        );
        await this.customerAudit.record(
          {
            action: 'RETURN_REQUEST_CREATED',
            resourceType: 'RETURN_REQUEST',
            resourceId: request.id,
            actorId: customer.id,
            context,
            metadata: {
              returnNumber: request.returnNumber,
              orderNumber,
              type: request.type,
              itemCount: request.items.length,
            },
          },
          session,
        );
        await this.emitLifecycleEvent(request, session);
        return request;
      }, this.transactionOptions());
      return this.toCustomerView(created);
    } catch (error: unknown) {
      if (error instanceof MongoServerError && error.code === 11000) {
        const duplicate = await this.requests
          .findOne({ customerId: new Types.ObjectId(customer.id), idempotencyKey })
          .exec();
        if (duplicate) return this.idempotentCustomerView(duplicate, orderNumber, requestHash);
      }
      throw error;
    }
  }

  async cancel(
    customer: AuthenticatedCustomer,
    orderNumber: string,
    returnNumber: string,
    input: CancelReturnRequestDto,
    context: AuthRequestContext,
  ): Promise<ReturnRequestView> {
    await this.connection.transaction(async (session) => {
      const request = await this.requests
        .findOne({
          customerId: new Types.ObjectId(customer.id),
          orderNumber,
          returnNumber,
        })
        .session(session)
        .exec();
      if (!request) throw this.notFound('RETURN_REQUEST_NOT_FOUND', 'Return request was not found');
      this.assertVersion(request, input.expectedVersion);
      if (request.status !== ReturnRequestStatus.Requested) {
        throw new ConflictException({
          code: 'RETURN_CANNOT_BE_CANCELLED',
          message: 'Only a pending return request can be cancelled',
        });
      }
      const now = new Date();
      request.status = ReturnRequestStatus.Cancelled;
      request.cancelledAt = now;
      request.statusHistory.push({
        status: ReturnRequestStatus.Cancelled,
        actorType: AuditActorType.Customer,
        actorId: request.customerId,
        occurredAt: now,
      });
      await request.save({ session });
      await this.touchOrder(request.orderId, session);
      await this.customerAudit.record(
        {
          action: 'RETURN_REQUEST_CANCELLED',
          resourceType: 'RETURN_REQUEST',
          resourceId: request.id,
          actorId: customer.id,
          context,
          metadata: { returnNumber, orderNumber },
        },
        session,
      );
      await this.emitLifecycleEvent(request, session);
    }, this.transactionOptions());
    return this.customerRequest(customer.id, orderNumber, returnNumber);
  }

  async adminList(query: AdminReturnListQueryDto): Promise<AdminReturnRequestPage> {
    const filter: Record<string, unknown> = {};
    if (query.status) filter.status = query.status;
    if (query.type) filter.type = query.type;
    const search = query.search?.trim();
    if (search) {
      const pattern = new RegExp(this.escapeRegex(search), 'i');
      filter.$or = [
        { returnNumber: pattern },
        { orderNumber: pattern },
        { 'items.productName': pattern },
        { 'items.sku': pattern },
      ];
    }
    const [documents, total] = await Promise.all([
      this.requests
        .find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip((query.page - 1) * query.limit)
        .limit(query.limit)
        .exec(),
      this.requests.countDocuments(filter),
    ]);
    return {
      items: documents.map((request) => this.toAdminView(request)),
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.ceil(total / query.limit),
    };
  }

  async adminGet(returnNumber: string): Promise<AdminReturnRequestView> {
    const request = await this.requests.findOne({ returnNumber }).exec();
    if (!request) throw this.notFound('RETURN_REQUEST_NOT_FOUND', 'Return request was not found');
    return this.toAdminView(request);
  }

  async decide(
    returnNumber: string,
    input: DecideReturnRequestDto,
    admin: AuthenticatedAdmin,
    context: AuthRequestContext,
  ): Promise<AdminReturnRequestView> {
    if (![ReturnRequestStatus.Approved, ReturnRequestStatus.Rejected].includes(input.status)) {
      throw new BadRequestException({
        code: 'RETURN_DECISION_INVALID',
        message: 'Decision status must be APPROVED or REJECTED',
      });
    }
    if (input.status === ReturnRequestStatus.Rejected && !input.customerMessage?.trim()) {
      throw new BadRequestException({
        code: 'RETURN_REJECTION_MESSAGE_REQUIRED',
        message: 'A customer-facing rejection reason is required',
      });
    }
    await this.connection.transaction(async (session) => {
      const request = await this.adminDocument(returnNumber, session);
      this.assertVersion(request, input.expectedVersion);
      this.assertStatus(request, ReturnRequestStatus.Requested);
      const now = new Date();
      if (input.status === ReturnRequestStatus.Approved) {
        await this.reserveExchangeInventory(request, admin, now, session);
      }
      request.status = input.status;
      request.decidedAt = now;
      request.customerMessage = input.customerMessage?.trim() || undefined;
      request.internalNote = input.internalNote?.trim() || request.internalNote;
      request.lastAdminId = new Types.ObjectId(admin.id);
      request.statusHistory.push({
        status: input.status,
        actorType: AuditActorType.Admin,
        actorId: request.lastAdminId,
        message: request.customerMessage,
        occurredAt: now,
      });
      await request.save({ session });
      await this.touchOrder(request.orderId, session);
      await this.adminAudit.record(
        {
          action: `RETURN_REQUEST_${input.status}`,
          resourceType: 'RETURN_REQUEST',
          resourceId: request.id,
          actorId: admin.id,
          context,
          metadata: { returnNumber, orderNumber: request.orderNumber },
        },
        session,
      );
      await this.emitLifecycleEvent(request, session);
    }, this.transactionOptions());
    return this.adminGet(returnNumber);
  }

  async receive(
    returnNumber: string,
    input: ReceiveReturnRequestDto,
    admin: AuthenticatedAdmin,
    context: AuthRequestContext,
  ): Promise<AdminReturnRequestView> {
    await this.connection.transaction(async (session) => {
      const request = await this.adminDocument(returnNumber, session);
      this.assertVersion(request, input.expectedVersion);
      this.assertStatus(request, ReturnRequestStatus.Approved);
      await this.assertExchangeReservationCanReceive(request, session);
      const order = await this.orders.findById(request.orderId).session(session).exec();
      if (!order || order.fulfillmentStatus !== FulfillmentStatus.Delivered) {
        throw new ConflictException({
          code: 'RETURN_ORDER_STATE_CHANGED',
          message: 'The order is no longer in a state that can receive item returns',
        });
      }
      const receivedByVariant = new Map(input.items.map((item) => [item.variantId, item]));
      if (
        receivedByVariant.size !== input.items.length ||
        receivedByVariant.size !== request.items.length
      ) {
        throw new BadRequestException({
          code: 'RETURN_RECEIPT_ITEMS_INVALID',
          message: 'Provide one inspection quantity for every requested variant',
        });
      }
      const movementRows = [];
      for (const item of request.items) {
        const receipt = receivedByVariant.get(item.variantId.toHexString());
        if (!receipt || receipt.restockQuantity > item.quantity) {
          throw new BadRequestException({
            code: 'RETURN_RECEIPT_QUANTITY_INVALID',
            message: `Restock quantity for ${item.sku} is invalid`,
          });
        }
        item.restockedQuantity = receipt.restockQuantity;
        if (!receipt.restockQuantity) continue;
        const updated = await this.inventory.updateOne(
          {
            productId: item.productId,
            variantId: item.variantId,
            sold: { $gte: receipt.restockQuantity },
          },
          {
            $inc: {
              onHand: receipt.restockQuantity,
              sold: -receipt.restockQuantity,
              version: 1,
            },
          },
          { session },
        );
        if (updated.modifiedCount !== 1) {
          throw new ConflictException({
            code: 'RETURN_RESTOCK_INVARIANT_FAILED',
            message: `Inventory for ${item.sku} could not be restored safely`,
          });
        }
        movementRows.push({
          productId: item.productId,
          variantId: item.variantId,
          type: InventoryMovementType.Return,
          deltaOnHand: receipt.restockQuantity,
          deltaReserved: 0,
          deltaSold: -receipt.restockQuantity,
          referenceType: 'RETURN_REQUEST_RECEIPT',
          referenceId: request.id,
          actorId: new Types.ObjectId(admin.id),
          note: `Inspected return ${request.returnNumber}`,
        });
      }
      if (movementRows.length) await this.movements.create(movementRows, { session });
      const now = new Date();
      request.status = ReturnRequestStatus.Received;
      request.receivedAt = now;
      request.customerMessage = input.customerMessage?.trim() || request.customerMessage;
      request.internalNote = input.internalNote?.trim() || request.internalNote;
      request.lastAdminId = new Types.ObjectId(admin.id);
      request.statusHistory.push({
        status: ReturnRequestStatus.Received,
        actorType: AuditActorType.Admin,
        actorId: request.lastAdminId,
        message: request.customerMessage,
        occurredAt: now,
      });
      order.returnAllocationRevision = (order.returnAllocationRevision ?? 0) + 1;
      await order.save({ session });
      await request.save({ session });
      await this.adminAudit.record(
        {
          action: 'RETURN_REQUEST_RECEIVED',
          resourceType: 'RETURN_REQUEST',
          resourceId: request.id,
          actorId: admin.id,
          context,
          metadata: {
            returnNumber,
            orderNumber: request.orderNumber,
            restockedQuantity: request.items.reduce(
              (total, item) => total + item.restockedQuantity,
              0,
            ),
          },
        },
        session,
      );
      await this.emitLifecycleEvent(request, session);
    }, this.transactionOptions());
    return this.adminGet(returnNumber);
  }

  async complete(
    returnNumber: string,
    input: CompleteReturnRequestDto,
    admin: AuthenticatedAdmin,
    context: AuthRequestContext,
  ): Promise<AdminReturnRequestView> {
    await this.connection.transaction(async (session) => {
      const request = await this.adminDocument(returnNumber, session);
      this.assertVersion(request, input.expectedVersion);
      this.assertStatus(request, ReturnRequestStatus.Received);
      if (
        (request.type === ReturnRequestType.Return &&
          input.resolutionType !== ReturnResolutionType.Refund) ||
        (request.type === ReturnRequestType.Exchange &&
          input.resolutionType !== ReturnResolutionType.Exchange)
      ) {
        throw new BadRequestException({
          code: 'RETURN_RESOLUTION_TYPE_INVALID',
          message: 'Resolution must match the original request type',
        });
      }

      let refundId: Types.ObjectId | undefined;
      if (input.resolutionType === ReturnResolutionType.Refund) {
        if (!input.refundId) {
          throw new BadRequestException({
            code: 'RETURN_REFUND_REQUIRED',
            message: 'A succeeded Razorpay refund is required to complete this return',
          });
        }
        const refund = await this.refunds.findById(input.refundId).session(session).exec();
        if (!refund || refund.orderId.toHexString() !== request.orderId.toHexString()) {
          throw new BadRequestException({
            code: 'RETURN_REFUND_INVALID',
            message: 'The selected refund does not belong to this order',
          });
        }
        if (refund.status !== RefundStatus.Succeeded) {
          throw new ConflictException({
            code: 'RETURN_REFUND_NOT_SETTLED',
            message: 'The Razorpay refund must succeed before the return is completed',
          });
        }
        refundId = refund._id;
      } else if (!input.courierName?.trim() || !input.trackingNumber?.trim()) {
        throw new BadRequestException({
          code: 'EXCHANGE_SHIPPING_REQUIRED',
          message: 'Replacement courier and tracking number are required',
        });
      }

      const now = new Date();
      if (request.type === ReturnRequestType.Exchange) {
        await this.commitExchangeInventory(request, admin, now, session);
      }
      request.status = ReturnRequestStatus.Completed;
      request.completedAt = now;
      request.customerMessage = input.customerMessage?.trim() || request.customerMessage;
      request.internalNote = input.internalNote?.trim() || request.internalNote;
      request.lastAdminId = new Types.ObjectId(admin.id);
      request.resolution = {
        type: input.resolutionType,
        refundId,
        courierName: input.courierName?.trim(),
        trackingNumber: input.trackingNumber?.trim(),
        trackingUrl: input.trackingUrl?.trim(),
      };
      request.statusHistory.push({
        status: ReturnRequestStatus.Completed,
        actorType: AuditActorType.Admin,
        actorId: request.lastAdminId,
        message: request.customerMessage,
        occurredAt: now,
      });
      await request.save({ session });
      await this.adminAudit.record(
        {
          action: 'RETURN_REQUEST_COMPLETED',
          resourceType: 'RETURN_REQUEST',
          resourceId: request.id,
          actorId: admin.id,
          context,
          metadata: {
            returnNumber,
            orderNumber: request.orderNumber,
            resolutionType: input.resolutionType,
            refundId: refundId?.toHexString(),
          },
        },
        session,
      );
      await this.emitLifecycleEvent(request, session);
    }, this.transactionOptions());
    return this.adminGet(returnNumber);
  }

  async expireExchangeReservations(limit = 50): Promise<number> {
    const candidates = await this.requests
      .find({
        type: ReturnRequestType.Exchange,
        status: ReturnRequestStatus.Approved,
        exchangeReservationStatus: ExchangeReservationStatus.Active,
        exchangeReservationExpiresAt: { $lte: new Date() },
      })
      .sort({ exchangeReservationExpiresAt: 1, _id: 1 })
      .limit(limit)
      .select('_id')
      .exec();
    let expired = 0;
    for (const candidate of candidates) {
      if (await this.expireExchangeReservation(candidate._id)) expired += 1;
    }
    return expired;
  }

  private async eligibilityItems(
    order: OrderDocument,
    allocated: Map<string, number>,
    session?: ClientSession,
  ): Promise<ReturnEligibilityItemView[]> {
    const productIds = [...new Set(order.items.map((item) => item.productId.toHexString()))].map(
      (id) => new Types.ObjectId(id),
    );
    const productQuery = this.products.find({
      _id: { $in: productIds },
      status: ProductStatus.Active,
    });
    if (session) productQuery.session(session);
    const products = await productQuery.exec();
    const targetVariantIds = products.flatMap((product) =>
      product.variants.filter((variant) => variant.isActive).map((variant) => variant.variantId),
    );
    const inventoryQuery = this.inventory.find({ variantId: { $in: targetVariantIds } });
    if (session) inventoryQuery.session(session);
    const levels = await inventoryQuery.exec();
    const availableByVariant = new Map(
      levels.map((level) => [level.variantId.toHexString(), level.onHand - level.reserved > 0]),
    );
    const productById = new Map(products.map((product) => [product.id, product]));
    return order.items.map((item) => {
      const variantId = item.variantId.toHexString();
      const allocatedQuantity = allocated.get(variantId) ?? 0;
      const product = productById.get(item.productId.toHexString());
      const exchangeOptions = product
        ? product.variants
            .filter((variant) => variant.isActive && !variant.variantId.equals(item.variantId))
            .sort((left, right) => left.sortOrder - right.sortOrder)
            .map((variant) => ({
              variantId: variant.variantId.toHexString(),
              sku: variant.sku,
              title: variant.title,
              attributes: variant.attributes.map((attribute) => ({
                name: attribute.name,
                value: attribute.value,
              })),
              currentlyAvailable: availableByVariant.get(variant.variantId.toHexString()) ?? false,
            }))
        : [];
      return {
        productId: item.productId.toHexString(),
        variantId,
        productName: item.productName,
        sku: item.sku,
        variantTitle: item.variantTitle,
        orderedQuantity: item.quantity,
        allocatedQuantity,
        availableQuantity: Math.max(0, item.quantity - allocatedQuantity),
        exchangeOptions,
      };
    });
  }

  private replacementGroups(request: ReturnRequestDocument): Array<{
    productId: Types.ObjectId;
    variantId: Types.ObjectId;
    sku: string;
    quantity: number;
  }> {
    const groups = new Map<
      string,
      { productId: Types.ObjectId; variantId: Types.ObjectId; sku: string; quantity: number }
    >();
    for (const item of request.items) {
      const target = item.requestedExchangeVariant;
      if (!target) throw new Error(`Exchange target missing for return ${request.id}`);
      const key = target.variantId.toHexString();
      const current = groups.get(key);
      if (current) {
        if (!current.productId.equals(item.productId)) {
          throw new Error(`Exchange target product mismatch for return ${request.id}`);
        }
        current.quantity += item.quantity;
      } else {
        groups.set(key, {
          productId: item.productId,
          variantId: target.variantId,
          sku: target.sku,
          quantity: item.quantity,
        });
      }
    }
    return [...groups.values()].sort((left, right) =>
      left.variantId.toHexString().localeCompare(right.variantId.toHexString()),
    );
  }

  private async reserveExchangeInventory(
    request: ReturnRequestDocument,
    admin: AuthenticatedAdmin,
    now: Date,
    session: ClientSession,
  ): Promise<void> {
    if (request.type !== ReturnRequestType.Exchange) return;
    const groups = this.replacementGroups(request);
    const productIds = [...new Set(groups.map((group) => group.productId.toHexString()))].map(
      (id) => new Types.ObjectId(id),
    );
    const products = await this.products
      .find({ _id: { $in: productIds }, status: ProductStatus.Active })
      .session(session)
      .exec();
    const productById = new Map(products.map((product) => [product.id, product]));
    const expiresAt = new Date(now.getTime() + this.exchangeReservationTtlMs);

    for (const group of groups) {
      const product = productById.get(group.productId.toHexString());
      const variant = product?.variants.find(
        (candidate) => candidate.variantId.equals(group.variantId) && candidate.isActive,
      );
      if (!variant) {
        throw new ConflictException({
          code: 'EXCHANGE_TARGET_UNAVAILABLE',
          message: `${group.sku} is no longer an active replacement option`,
        });
      }
      const reserved = await this.inventory
        .findOneAndUpdate(
          {
            productId: group.productId,
            variantId: group.variantId,
            $expr: { $gte: [{ $subtract: ['$onHand', '$reserved'] }, group.quantity] },
          },
          { $inc: { reserved: group.quantity, version: 1 } },
          { session, returnDocument: 'after' },
        )
        .exec();
      if (!reserved) {
        throw new ConflictException({
          code: 'EXCHANGE_TARGET_OUT_OF_STOCK',
          message: `${group.sku} does not have enough replacement stock`,
        });
      }
    }

    await this.reservations.create(
      groups.map((group) => ({
        reservationGroupId: `exchange:${request.id}`,
        returnRequestId: request._id,
        productId: group.productId,
        variantId: group.variantId,
        quantity: group.quantity,
        status: InventoryReservationStatus.Active,
        expiresAt,
      })),
      { session },
    );
    await this.movements.create(
      groups.map((group) => ({
        productId: group.productId,
        variantId: group.variantId,
        type: InventoryMovementType.Reserve,
        deltaOnHand: 0,
        deltaReserved: group.quantity,
        deltaSold: 0,
        referenceType: 'EXCHANGE_REPLACEMENT_RESERVE',
        referenceId: request.id,
        actorId: new Types.ObjectId(admin.id),
        note: `Reserved replacement stock for ${request.returnNumber}`,
      })),
      { session },
    );
    request.exchangeReservationStatus = ExchangeReservationStatus.Active;
    request.exchangeReservationExpiresAt = expiresAt;
    request.exchangeReservationFinalizedAt = undefined;
  }

  private async assertExchangeReservationCanReceive(
    request: ReturnRequestDocument,
    session: ClientSession,
  ): Promise<void> {
    if (
      request.type !== ReturnRequestType.Exchange ||
      !request.exchangeReservationStatus // Legacy pre-Phase-15 exchange.
    ) {
      return;
    }
    if (
      request.exchangeReservationStatus !== ExchangeReservationStatus.Active ||
      !request.exchangeReservationExpiresAt ||
      request.exchangeReservationExpiresAt.getTime() <= Date.now()
    ) {
      throw new ConflictException({
        code: 'EXCHANGE_RESERVATION_EXPIRED',
        message: 'The replacement stock reservation has expired',
      });
    }
    const reservations = await this.activeExchangeReservations(request, session);
    this.assertExchangeReservationSnapshot(request, reservations);
  }

  private async commitExchangeInventory(
    request: ReturnRequestDocument,
    admin: AuthenticatedAdmin,
    now: Date,
    session: ClientSession,
  ): Promise<void> {
    if (!request.exchangeReservationStatus) return; // Legacy pre-Phase-15 exchange.
    if (request.exchangeReservationStatus !== ExchangeReservationStatus.Active) {
      throw new ConflictException({
        code: 'EXCHANGE_RESERVATION_NOT_ACTIVE',
        message: 'Replacement stock is not actively reserved',
      });
    }
    const reservations = await this.activeExchangeReservations(request, session);
    this.assertExchangeReservationSnapshot(request, reservations);
    for (const reservation of reservations) {
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
        throw new ConflictException({
          code: 'EXCHANGE_RESERVATION_INVARIANT_FAILED',
          message: `Replacement inventory for ${reservation.variantId.toHexString()} changed unexpectedly`,
        });
      }
    }
    const finalized = await this.reservations.updateMany(
      { returnRequestId: request._id, status: InventoryReservationStatus.Active },
      { $set: { status: InventoryReservationStatus.Committed, finalizedAt: now } },
      { session },
    );
    if (finalized.modifiedCount !== reservations.length) {
      throw new Error(`Exchange reservation commit invariant failed for return ${request.id}`);
    }
    await this.movements.create(
      reservations.map((reservation) => ({
        productId: reservation.productId,
        variantId: reservation.variantId,
        type: InventoryMovementType.Sale,
        deltaOnHand: -reservation.quantity,
        deltaReserved: -reservation.quantity,
        deltaSold: reservation.quantity,
        referenceType: 'EXCHANGE_REPLACEMENT_COMMIT',
        referenceId: request.id,
        actorId: new Types.ObjectId(admin.id),
        note: `Committed replacement dispatch for ${request.returnNumber}`,
      })),
      { session },
    );
    request.exchangeReservationStatus = ExchangeReservationStatus.Committed;
    request.exchangeReservationFinalizedAt = now;
  }

  private activeExchangeReservations(
    request: ReturnRequestDocument,
    session: ClientSession,
  ): Promise<InventoryReservationDocument[]> {
    return this.reservations
      .find({ returnRequestId: request._id, status: InventoryReservationStatus.Active })
      .sort({ variantId: 1 })
      .session(session)
      .exec();
  }

  private assertExchangeReservationSnapshot(
    request: ReturnRequestDocument,
    reservations: InventoryReservationDocument[],
  ): void {
    const expected = new Map(
      this.replacementGroups(request).map((group) => [
        group.variantId.toHexString(),
        group.quantity,
      ]),
    );
    if (expected.size !== reservations.length) {
      throw new Error(`Exchange reservation snapshot incomplete for return ${request.id}`);
    }
    for (const reservation of reservations) {
      if (expected.get(reservation.variantId.toHexString()) !== reservation.quantity) {
        throw new Error(`Exchange reservation quantity mismatch for return ${request.id}`);
      }
    }
  }

  private async expireExchangeReservation(requestId: Types.ObjectId): Promise<boolean> {
    return this.connection.transaction(async (session): Promise<boolean> => {
      const request = await this.requests.findById(requestId).session(session).exec();
      if (
        !request ||
        request.type !== ReturnRequestType.Exchange ||
        request.status !== ReturnRequestStatus.Approved ||
        request.exchangeReservationStatus !== ExchangeReservationStatus.Active ||
        !request.exchangeReservationExpiresAt ||
        request.exchangeReservationExpiresAt.getTime() > Date.now()
      ) {
        return false;
      }
      const reservations = await this.activeExchangeReservations(request, session);
      this.assertExchangeReservationSnapshot(request, reservations);
      for (const reservation of reservations) {
        const released = await this.inventory.updateOne(
          { variantId: reservation.variantId, reserved: { $gte: reservation.quantity } },
          { $inc: { reserved: -reservation.quantity, version: 1 } },
          { session },
        );
        if (released.modifiedCount !== 1) {
          throw new Error(`Exchange reservation release invariant failed for return ${request.id}`);
        }
      }
      const now = new Date();
      const finalized = await this.reservations.updateMany(
        { returnRequestId: request._id, status: InventoryReservationStatus.Active },
        { $set: { status: InventoryReservationStatus.Expired, finalizedAt: now } },
        { session },
      );
      if (finalized.modifiedCount !== reservations.length) {
        throw new Error(`Exchange reservation expiry invariant failed for return ${request.id}`);
      }
      await this.movements.create(
        reservations.map((reservation) => ({
          productId: reservation.productId,
          variantId: reservation.variantId,
          type: InventoryMovementType.Release,
          deltaOnHand: 0,
          deltaReserved: -reservation.quantity,
          deltaSold: 0,
          referenceType: 'EXCHANGE_REPLACEMENT_EXPIRE',
          referenceId: request.id,
          note: `Expired replacement stock for ${request.returnNumber}`,
        })),
        { session },
      );
      request.status = ReturnRequestStatus.Expired;
      request.exchangeReservationStatus = ExchangeReservationStatus.Expired;
      request.exchangeReservationFinalizedAt = now;
      request.statusHistory.push({
        status: ReturnRequestStatus.Expired,
        actorType: AuditActorType.System,
        message: 'Replacement stock reservation expired before the return was received.',
        occurredAt: now,
      });
      await request.save({ session });
      await this.touchOrder(request.orderId, session);
      await this.adminAudit.record(
        {
          action: 'RETURN_REQUEST_EXPIRED',
          resourceType: 'RETURN_REQUEST',
          resourceId: request.id,
          metadata: { returnNumber: request.returnNumber, orderNumber: request.orderNumber },
        },
        session,
      );
      await this.emitLifecycleEvent(request, session);
      return true;
    }, this.transactionOptions());
  }

  private async emitLifecycleEvent(
    request: ReturnRequestDocument,
    session: ClientSession,
  ): Promise<void> {
    await this.outbox.create(
      [
        {
          eventId: `return-request:${request.id}:${request.status}`,
          aggregateType: 'RETURN_REQUEST',
          aggregateId: request._id,
          eventType: `RETURN_REQUEST_${request.status}`,
          payload: {
            returnNumber: request.returnNumber,
            orderNumber: request.orderNumber,
            type: request.type,
            status: request.status,
            itemCount: request.items.length,
            customerMessage: request.customerMessage,
            exchangeReservationExpiresAt: request.exchangeReservationExpiresAt,
            resolution: request.resolution
              ? {
                  type: request.resolution.type,
                  courierName: request.resolution.courierName,
                  trackingNumber: request.resolution.trackingNumber,
                  trackingUrl: request.resolution.trackingUrl,
                }
              : undefined,
          },
          status: OutboxStatus.Pending,
          processingAttempts: 0,
          availableAt: new Date(),
        },
      ],
      { session },
    );
  }

  private async exchangeTarget(
    requestType: ReturnRequestType,
    productId: Types.ObjectId,
    originalVariantId: Types.ObjectId,
    requestedVariantId: string | undefined,
    session: ClientSession,
  ): Promise<
    | {
        variantId: Types.ObjectId;
        sku: string;
        title: string;
        attributes: Array<{ name: string; value: string }>;
      }
    | undefined
  > {
    if (requestType === ReturnRequestType.Return) {
      if (requestedVariantId) {
        throw new BadRequestException({
          code: 'RETURN_EXCHANGE_TARGET_NOT_ALLOWED',
          message: 'A normal return cannot contain an exchange target',
        });
      }
      return undefined;
    }
    if (!requestedVariantId || requestedVariantId === originalVariantId.toHexString()) {
      throw new BadRequestException({
        code: 'EXCHANGE_TARGET_REQUIRED',
        message: 'Choose a different active variant for each exchange item',
      });
    }
    const product = await this.products
      .findOne({ _id: productId, status: ProductStatus.Active })
      .session(session)
      .exec();
    const target = product?.variants.find(
      (variant) => variant.variantId.toHexString() === requestedVariantId && variant.isActive,
    );
    if (!target) {
      throw new ConflictException({
        code: 'EXCHANGE_TARGET_UNAVAILABLE',
        message: 'The requested exchange variant is no longer available',
      });
    }
    const stock = await this.inventory
      .findOne({ variantId: target.variantId })
      .session(session)
      .exec();
    if (!stock || stock.onHand - stock.reserved < 1) {
      throw new ConflictException({
        code: 'EXCHANGE_TARGET_OUT_OF_STOCK',
        message: 'The requested exchange variant is currently out of stock',
      });
    }
    return {
      variantId: target.variantId,
      sku: target.sku,
      title: target.title,
      attributes: target.attributes.map((attribute) => ({
        name: attribute.name,
        value: attribute.value,
      })),
    };
  }

  private ineligibilityReason(
    order: OrderDocument,
    deadline: Date | undefined,
    items: ReturnEligibilityItemView[],
  ): string | undefined {
    if (order.fulfillmentStatus !== FulfillmentStatus.Delivered || !order.shipping?.deliveredAt) {
      return 'Returns become available after this order is delivered.';
    }
    if (
      ![FinancialStatus.Paid, FinancialStatus.PartiallyRefunded].includes(order.financialStatus)
    ) {
      return 'This order has no refundable paid balance.';
    }
    if (!deadline || deadline.getTime() < Date.now()) {
      return `The ${this.windowDays}-day return window has closed.`;
    }
    if (!items.some((item) => item.availableQuantity > 0)) {
      return 'All eligible quantities are already part of a return or exchange request.';
    }
    return undefined;
  }

  private normalizedInput(input: CreateReturnRequestDto): CreateReturnRequestDto {
    return {
      type: input.type,
      items: input.items
        .map((item) => ({
          variantId: item.variantId,
          quantity: item.quantity,
          reason: item.reason,
          reasonDetail: item.reasonDetail?.trim() || undefined,
          requestedExchangeVariantId: item.requestedExchangeVariantId,
        }))
        .sort((left, right) => left.variantId.localeCompare(right.variantId)),
      customerNote: input.customerNote?.trim() || undefined,
    };
  }

  private async ownedOrder(customerId: string, orderNumber: string): Promise<OrderDocument> {
    const order = await this.orders
      .findOne({ customerId: new Types.ObjectId(customerId), orderNumber })
      .exec();
    if (!order) throw this.notFound('ORDER_NOT_FOUND', 'Order was not found');
    return order;
  }

  private async customerRequest(
    customerId: string,
    orderNumber: string,
    returnNumber: string,
  ): Promise<ReturnRequestView> {
    const request = await this.requests
      .findOne({ customerId: new Types.ObjectId(customerId), orderNumber, returnNumber })
      .exec();
    if (!request) throw this.notFound('RETURN_REQUEST_NOT_FOUND', 'Return request was not found');
    return this.toCustomerView(request);
  }

  private async adminDocument(
    returnNumber: string,
    session: ClientSession,
  ): Promise<ReturnRequestDocument> {
    const request = await this.requests.findOne({ returnNumber }).session(session).exec();
    if (!request) throw this.notFound('RETURN_REQUEST_NOT_FOUND', 'Return request was not found');
    return request;
  }

  private async touchOrder(orderId: Types.ObjectId, session: ClientSession): Promise<void> {
    const result = await this.orders.updateOne(
      { _id: orderId },
      { $inc: { returnAllocationRevision: 1, version: 1 } },
      { session },
    );
    if (result.modifiedCount !== 1) {
      throw new ConflictException({
        code: 'RETURN_ORDER_STATE_CHANGED',
        message: 'The order changed while the return request was being updated',
      });
    }
  }

  private idempotentCustomerView(
    request: ReturnRequestDocument,
    orderNumber: string,
    requestHash: string,
  ): ReturnRequestView {
    if (request.orderNumber !== orderNumber || request.idempotencyRequestHash !== requestHash) {
      throw new ConflictException({
        code: 'IDEMPOTENCY_KEY_REUSED',
        message: 'Idempotency key was already used for a different request',
      });
    }
    return this.toCustomerView(request);
  }

  private toCustomerView(request: ReturnRequestDocument): ReturnRequestView {
    const base = this.baseView(request);
    return {
      ...base,
      statusHistory: request.statusHistory.map((entry) => ({
        status: entry.status,
        message: entry.message,
        occurredAt: entry.occurredAt,
      })),
    };
  }

  private toAdminView(request: ReturnRequestDocument): AdminReturnRequestView {
    const base = this.baseView(request);
    return {
      ...base,
      customerId: request.customerId.toHexString(),
      internalNote: request.internalNote,
      lastAdminId: request.lastAdminId?.toHexString(),
      statusHistory: request.statusHistory.map((entry) => ({
        status: entry.status,
        actorType: entry.actorType,
        actorId: entry.actorId?.toHexString(),
        message: entry.message,
        occurredAt: entry.occurredAt,
      })),
    };
  }

  private baseView(request: ReturnRequestDocument): Omit<ReturnRequestView, 'statusHistory'> {
    return {
      id: request.id,
      returnNumber: request.returnNumber,
      orderNumber: request.orderNumber,
      type: request.type,
      status: request.status,
      items: request.items.map((item) => ({
        productId: item.productId.toHexString(),
        variantId: item.variantId.toHexString(),
        productName: item.productName,
        sku: item.sku,
        variantTitle: item.variantTitle,
        quantity: item.quantity,
        reason: item.reason,
        reasonDetail: item.reasonDetail,
        requestedExchangeVariant: item.requestedExchangeVariant
          ? {
              variantId: item.requestedExchangeVariant.variantId.toHexString(),
              sku: item.requestedExchangeVariant.sku,
              title: item.requestedExchangeVariant.title,
              attributes: item.requestedExchangeVariant.attributes.map((attribute) => ({
                name: attribute.name,
                value: attribute.value,
              })),
              currentlyAvailable: true,
            }
          : undefined,
        estimatedValueInPaise: item.estimatedValueInPaise,
        restockedQuantity: item.restockedQuantity,
      })),
      estimatedTotalInPaise: request.items.reduce(
        (total, item) => total + item.estimatedValueInPaise,
        0,
      ),
      customerNote: request.customerNote,
      customerMessage: request.customerMessage,
      requestedAt: request.requestedAt,
      decidedAt: request.decidedAt,
      receivedAt: request.receivedAt,
      completedAt: request.completedAt,
      cancelledAt: request.cancelledAt,
      exchangeReservation: request.exchangeReservationStatus
        ? {
            status: request.exchangeReservationStatus,
            expiresAt: request.exchangeReservationExpiresAt,
            finalizedAt: request.exchangeReservationFinalizedAt,
          }
        : undefined,
      resolution: request.resolution
        ? {
            type: request.resolution.type,
            refundId: request.resolution.refundId?.toHexString(),
            courierName: request.resolution.courierName,
            trackingNumber: request.resolution.trackingNumber,
            trackingUrl: request.resolution.trackingUrl,
          }
        : undefined,
      version: request.get('version') as number,
      createdAt: request.get('createdAt') as Date,
      updatedAt: request.get('updatedAt') as Date,
    };
  }

  private assertVersion(request: ReturnRequestDocument, expectedVersion: number): void {
    if ((request.get('version') as number) !== expectedVersion) {
      throw new ConflictException({
        code: 'RETURN_VERSION_CONFLICT',
        message: 'Return request changed since it was loaded; reload and retry',
      });
    }
  }

  private assertStatus(request: ReturnRequestDocument, expected: ReturnRequestStatus): void {
    if (request.status !== expected) {
      throw new ConflictException({
        code: 'RETURN_STATUS_TRANSITION_INVALID',
        message: `Return request must be ${expected} for this operation`,
      });
    }
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

  private returnNumber(now: Date): string {
    const date = now.toISOString().slice(0, 10).replaceAll('-', '');
    return `RT-${date}-${randomBytes(6).toString('hex').toUpperCase()}`;
  }

  private escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private notFound(code: string, message: string): NotFoundException {
    return new NotFoundException({ code, message });
  }

  private transactionOptions(): {
    readPreference: 'primary';
    readConcern: { level: 'snapshot' };
    writeConcern: { w: 'majority' };
  } {
    return {
      readPreference: 'primary' as const,
      readConcern: { level: 'snapshot' as const },
      writeConcern: { w: 'majority' as const },
    };
  }
}
