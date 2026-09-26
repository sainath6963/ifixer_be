import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { MongoServerError } from 'mongodb';
import { Connection, Model, Types } from 'mongoose';

import { Product } from '../../database/schemas/catalog.schema';
import { Customer } from '../../database/schemas/identity.schema';
import { InventoryLevel } from '../../database/schemas/inventory.schema';
import {
  StockAlert,
  StockAlertDocument,
  WishlistItem,
} from '../../database/schemas/wishlist.schema';
import { ProductStatus, StockAlertStatus } from '../../domain/enums';
import type { AuthRequestContext } from '../admin-auth/auth.types';
import { CustomerAuditService } from '../customer/customer-audit.service';
import type { AuthenticatedCustomer } from '../customer/customer.types';
import { StorefrontCatalogService } from '../storefront-catalog/storefront-catalog.service';
import type { StockDemandQueryDto, WishlistPageQueryDto } from './dto/wishlist.dto';
import type {
  ProductStockAlertState,
  StockAlertView,
  StockDemandPage,
  WishlistPage,
} from './wishlist.types';

interface WishlistAggregateRow {
  items: Array<{ _id: Types.ObjectId; productId: Types.ObjectId; createdAt: Date }>;
  metadata: Array<{ total: number }>;
}

interface DemandAggregateRow {
  items: Array<{
    _id: { productId: Types.ObjectId; variantId: Types.ObjectId };
    productName: string;
    productSlug: string;
    variantTitle: string;
    sku: string;
    subscriberCount: number;
    lastRequestedAt: Date;
    inventory: Array<{ onHand: number; reserved: number }>;
  }>;
  metadata: Array<{ total: number }>;
}

@Injectable()
export class WishlistService {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(WishlistItem.name) private readonly wishlist: Model<WishlistItem>,
    @InjectModel(StockAlert.name) private readonly alerts: Model<StockAlert>,
    @InjectModel(Product.name) private readonly products: Model<Product>,
    @InjectModel(InventoryLevel.name) private readonly inventory: Model<InventoryLevel>,
    @InjectModel(Customer.name) private readonly customers: Model<Customer>,
    private readonly catalog: StorefrontCatalogService,
    private readonly audit: CustomerAuditService,
  ) {}

  async list(customerId: string, query: WishlistPageQueryDto): Promise<WishlistPage> {
    const [result] = await this.wishlist
      .aggregate<WishlistAggregateRow>([
        { $match: { customerId: new Types.ObjectId(customerId) } },
        {
          $lookup: {
            from: 'products',
            localField: 'productId',
            foreignField: '_id',
            as: 'product',
          },
        },
        { $unwind: '$product' },
        {
          $match: {
            'product.status': ProductStatus.Active,
            'product.publishedAt': { $lte: new Date() },
          },
        },
        { $sort: { createdAt: -1, _id: -1 } },
        {
          $facet: {
            items: [
              { $skip: (query.page - 1) * query.limit },
              { $limit: query.limit },
              { $project: { _id: 1, productId: 1, createdAt: 1 } },
            ],
            metadata: [{ $count: 'total' }],
          },
        },
      ])
      .exec();
    const rows = result?.items ?? [];
    const cards = await this.catalog.productCardsByIds(rows.map((row) => row.productId));
    const items = rows.flatMap((row) => {
      const product = cards.get(row.productId.toHexString());
      return product ? [{ id: row._id.toHexString(), addedAt: row.createdAt, product }] : [];
    });
    const total = result?.metadata[0]?.total ?? 0;
    return {
      items,
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.ceil(total / query.limit),
    };
  }

  async membership(customerId: string, productId: string): Promise<{ wishlisted: boolean }> {
    const id = this.productId(productId);
    return {
      wishlisted: Boolean(
        await this.wishlist.exists({ customerId: new Types.ObjectId(customerId), productId: id }),
      ),
    };
  }

  async add(
    customerId: string,
    productId: string,
    context: AuthRequestContext,
  ): Promise<{ wishlisted: true }> {
    const id = this.productId(productId);
    await this.connection.transaction(async (session) => {
      if (
        !(await this.products
          .exists({
            _id: id,
            status: ProductStatus.Active,
            visibility: { $ne: 'REPAIR_INTERNAL' },
            publishedAt: { $lte: new Date() },
          })
          .session(session))
      ) {
        throw this.productNotFound();
      }
      const result = await this.wishlist.updateOne(
        { customerId: new Types.ObjectId(customerId), productId: id },
        { $setOnInsert: { customerId: new Types.ObjectId(customerId), productId: id } },
        { upsert: true, session },
      );
      if (result.upsertedCount === 1) {
        await this.audit.record(
          {
            action: 'WISHLIST_ITEM_ADDED',
            resourceType: 'WISHLIST',
            resourceId: id.toHexString(),
            actorId: customerId,
            context,
          },
          session,
        );
      }
    });
    return { wishlisted: true };
  }

  async remove(
    customerId: string,
    productId: string,
    context: AuthRequestContext,
  ): Promise<{ wishlisted: false }> {
    const id = this.productId(productId);
    await this.connection.transaction(async (session) => {
      const result = await this.wishlist.deleteOne(
        { customerId: new Types.ObjectId(customerId), productId: id },
        { session },
      );
      if (result.deletedCount === 1) {
        await this.audit.record(
          {
            action: 'WISHLIST_ITEM_REMOVED',
            resourceType: 'WISHLIST',
            resourceId: id.toHexString(),
            actorId: customerId,
            context,
          },
          session,
        );
      }
    });
    return { wishlisted: false };
  }

  async productAlertState(
    customer: AuthenticatedCustomer,
    productId: string,
  ): Promise<ProductStockAlertState> {
    const id = this.productId(productId);
    if (!(await this.products.exists({ _id: id }))) throw this.productNotFound();
    const customerDocument = await this.customers.findById(customer.id).exec();
    const emailVerified = Boolean(customerDocument?.email && customerDocument.emailVerifiedAt);
    const emailEligible = Boolean(
      emailVerified && customerDocument?.communicationPreferences?.backInStockEmail !== false,
    );
    const active = await this.alerts
      .find({ customerId: new Types.ObjectId(customer.id), productId: id, active: true })
      .select('variantId')
      .exec();
    return {
      emailEligible,
      emailEligibilityReason: emailEligible
        ? undefined
        : emailVerified
          ? 'Enable back-in-stock emails in communication preferences first.'
          : 'Verify your email address before requesting stock alerts.',
      activeVariantIds: active.map((alert) => alert.variantId.toHexString()),
    };
  }

  async listAlerts(customerId: string): Promise<{ alerts: StockAlertView[] }> {
    const documents = await this.alerts
      .find({ customerId: new Types.ObjectId(customerId), active: true })
      .sort({ requestedAt: -1, _id: -1 })
      .exec();
    return { alerts: documents.map((document) => this.toAlertView(document)) };
  }

  async subscribe(
    customer: AuthenticatedCustomer,
    productId: string,
    variantId: string,
    context: AuthRequestContext,
  ): Promise<StockAlertView> {
    const productObjectId = this.productId(productId);
    const variantObjectId = this.variantId(variantId);
    try {
      const alert = await this.connection.transaction(async (session) => {
        const customerDocument = await this.customers.findById(customer.id).session(session).exec();
        if (!customerDocument?.email || !customerDocument.emailVerifiedAt) {
          throw new ConflictException({
            code: 'STOCK_ALERT_EMAIL_VERIFICATION_REQUIRED',
            message: 'Verify your email address before requesting stock alerts',
          });
        }
        if (customerDocument.communicationPreferences?.backInStockEmail === false) {
          throw new ConflictException({
            code: 'STOCK_ALERT_PREFERENCE_REQUIRED',
            message: 'Enable back-in-stock emails in communication preferences first',
          });
        }
        const product = await this.products
          .findOne({
            _id: productObjectId,
            status: ProductStatus.Active,
            visibility: { $ne: 'REPAIR_INTERNAL' },
            publishedAt: { $lte: new Date() },
          })
          .session(session)
          .exec();
        if (!product) throw this.productNotFound();
        const variant = product.variants.find(
          (item) => item.variantId.equals(variantObjectId) && item.isActive,
        );
        if (!variant) throw this.variantNotFound();
        const level = await this.inventory
          .findOne({ productId: productObjectId, variantId: variantObjectId })
          .session(session)
          .exec();
        if (!level) throw this.variantNotFound();
        if (level.onHand - level.reserved > 0) {
          throw new ConflictException({
            code: 'STOCK_ALREADY_AVAILABLE',
            message: 'This option is already available to order',
          });
        }
        const existing = await this.alerts
          .findOne({
            customerId: new Types.ObjectId(customer.id),
            variantId: variantObjectId,
            active: true,
          })
          .session(session)
          .exec();
        if (existing) return existing;
        const [created] = await this.alerts.create(
          [
            {
              customerId: new Types.ObjectId(customer.id),
              productId: productObjectId,
              variantId: variantObjectId,
              productName: product.name,
              productSlug: product.slug,
              variantTitle: variant.title,
              sku: variant.sku,
              status: StockAlertStatus.Active,
              active: true,
              requestedAt: new Date(),
            },
          ],
          { session },
        );
        await this.audit.record(
          {
            action: 'STOCK_ALERT_SUBSCRIBED',
            resourceType: 'STOCK_ALERT',
            resourceId: created.id,
            actorId: customer.id,
            context,
            metadata: { productId, variantId },
          },
          session,
        );
        return created;
      });
      return this.toAlertView(alert);
    } catch (error: unknown) {
      if (error instanceof MongoServerError && error.code === 11000) {
        const existing = await this.alerts
          .findOne({
            customerId: new Types.ObjectId(customer.id),
            variantId: variantObjectId,
            active: true,
          })
          .exec();
        if (existing) return this.toAlertView(existing);
      }
      throw error;
    }
  }

  async cancelAlert(
    customer: AuthenticatedCustomer,
    productId: string,
    variantId: string,
    context: AuthRequestContext,
  ): Promise<{ active: false }> {
    const productObjectId = this.productId(productId);
    const variantObjectId = this.variantId(variantId);
    await this.connection.transaction(async (session) => {
      const alert = await this.alerts
        .findOne({
          customerId: new Types.ObjectId(customer.id),
          productId: productObjectId,
          variantId: variantObjectId,
          active: true,
        })
        .session(session)
        .exec();
      if (!alert) return;
      alert.status = StockAlertStatus.Cancelled;
      alert.active = false;
      alert.cancelledAt = new Date();
      await alert.save({ session });
      await this.audit.record(
        {
          action: 'STOCK_ALERT_CANCELLED',
          resourceType: 'STOCK_ALERT',
          resourceId: alert.id,
          actorId: customer.id,
          context,
          metadata: { productId, variantId },
        },
        session,
      );
    });
    return { active: false };
  }

  async demand(query: StockDemandQueryDto): Promise<StockDemandPage> {
    const match: Record<string, unknown> = { active: true };
    const search = query.search?.trim();
    if (search) {
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      match.$or = [
        { productName: { $regex: escaped, $options: 'i' } },
        { variantTitle: { $regex: escaped, $options: 'i' } },
        { sku: { $regex: escaped, $options: 'i' } },
      ];
    }
    const [result] = await this.alerts
      .aggregate<DemandAggregateRow>([
        { $match: match },
        {
          $group: {
            _id: { productId: '$productId', variantId: '$variantId' },
            productName: { $first: '$productName' },
            productSlug: { $first: '$productSlug' },
            variantTitle: { $first: '$variantTitle' },
            sku: { $first: '$sku' },
            subscriberCount: { $sum: 1 },
            lastRequestedAt: { $max: '$requestedAt' },
          },
        },
        {
          $lookup: {
            from: 'inventory_levels',
            localField: '_id.variantId',
            foreignField: 'variantId',
            as: 'inventory',
          },
        },
        { $sort: { subscriberCount: -1, lastRequestedAt: -1, _id: 1 } },
        {
          $facet: {
            items: [{ $skip: (query.page - 1) * query.limit }, { $limit: query.limit }],
            metadata: [{ $count: 'total' }],
          },
        },
      ])
      .exec();
    const total = result?.metadata[0]?.total ?? 0;
    return {
      items: (result?.items ?? []).map((row) => ({
        productId: row._id.productId.toHexString(),
        variantId: row._id.variantId.toHexString(),
        productName: row.productName,
        productSlug: row.productSlug,
        variantTitle: row.variantTitle,
        sku: row.sku,
        subscriberCount: row.subscriberCount,
        available: Math.max(0, (row.inventory[0]?.onHand ?? 0) - (row.inventory[0]?.reserved ?? 0)),
        lastRequestedAt: row.lastRequestedAt,
      })),
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.ceil(total / query.limit),
    };
  }

  private toAlertView(document: StockAlertDocument): StockAlertView {
    return {
      id: document.id,
      productId: document.productId.toHexString(),
      variantId: document.variantId.toHexString(),
      productName: document.productName,
      productSlug: document.productSlug,
      variantTitle: document.variantTitle,
      sku: document.sku,
      status: document.status,
      requestedAt: document.requestedAt,
      notifiedAt: document.notifiedAt,
      cancelledAt: document.cancelledAt,
      version: document.get('version') as number,
    };
  }

  private productId(value: string): Types.ObjectId {
    if (!Types.ObjectId.isValid(value)) throw this.productNotFound();
    return new Types.ObjectId(value);
  }

  private variantId(value: string): Types.ObjectId {
    if (!Types.ObjectId.isValid(value)) throw this.variantNotFound();
    return new Types.ObjectId(value);
  }

  private productNotFound(): NotFoundException {
    return new NotFoundException({ code: 'PRODUCT_NOT_FOUND', message: 'Product not found' });
  }

  private variantNotFound(): NotFoundException {
    return new NotFoundException({
      code: 'VARIANT_NOT_FOUND',
      message: 'Product option not found',
    });
  }
}
