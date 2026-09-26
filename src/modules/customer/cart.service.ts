import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { MongoServerError } from 'mongodb';
import { randomBytes } from 'node:crypto';
import { Connection, Model, Types } from 'mongoose';

import { Cart, CartDocument } from '../../database/schemas/cart.schema';
import {
  MediaAsset,
  MediaAssetDocument,
  Product,
  ProductDocument,
} from '../../database/schemas/catalog.schema';
import { InventoryLevel } from '../../database/schemas/inventory.schema';
import { CartStatus, MediaStatus, ProductStatus } from '../../domain/enums';
import type { AuthRequestContext } from '../admin-auth/auth.types';
import type { StorefrontImage } from '../storefront-catalog/storefront.types';
import type { CartItemView, CartOperationResult, CartIdentity, CartView } from './cart.types';
import {
  CART_MAX_DISTINCT_ITEMS,
  CART_MAX_ITEM_QUANTITY,
  CUSTOMER_CART_TTL_SECONDS,
  GUEST_CART_TTL_SECONDS,
} from './customer.constants';
import { CustomerAuditService } from './customer-audit.service';
import { CustomerTokenService } from './customer-token.service';
import type { CartMutationVersionDto, SetCartItemDto } from './dto/cart.dto';

interface CatalogSelection {
  product: ProductDocument;
  variant: ProductDocument['variants'][number];
}

@Injectable()
export class CartService {
  private readonly mediaUrlPrefix: string;

  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(Cart.name) private readonly carts: Model<Cart>,
    @InjectModel(Product.name) private readonly products: Model<Product>,
    @InjectModel(MediaAsset.name) private readonly mediaAssets: Model<MediaAsset>,
    @InjectModel(InventoryLevel.name) private readonly inventory: Model<InventoryLevel>,
    private readonly tokens: CustomerTokenService,
    private readonly audit: CustomerAuditService,
    config: ConfigService,
  ) {
    const apiPrefix = config.getOrThrow<string>('API_PREFIX').replace(/^\/+|\/+$/g, '');
    this.mediaUrlPrefix = `/${apiPrefix}/media`;
  }

  async get(identity: CartIdentity): Promise<CartOperationResult> {
    const cart = await this.findActiveCart(identity);
    return { cart: await this.toView(cart) };
  }

  async setItem(
    identity: CartIdentity,
    variantId: string,
    input: SetCartItemDto,
    context: AuthRequestContext,
  ): Promise<CartOperationResult> {
    const selection = await this.validateSelection(input.productId, variantId, input.quantity);
    const existing = await this.findActiveCart(identity);
    this.assertVersion(existing, input.expectedVersion);
    let guestTokenToSet: string | undefined;
    const cart =
      existing ??
      (await this.createCart(identity, (token) => {
        guestTokenToSet = token;
      }));
    const item = cart.items.find(
      (candidate) =>
        candidate.productId.equals(selection.product._id) &&
        candidate.variantId.equals(selection.variant.variantId),
    );
    if (item) {
      item.quantity = input.quantity;
    } else {
      if (cart.items.length >= CART_MAX_DISTINCT_ITEMS) {
        throw new ConflictException({
          code: 'CART_ITEM_LIMIT_REACHED',
          message: `A cart cannot contain more than ${CART_MAX_DISTINCT_ITEMS} distinct items`,
        });
      }
      cart.items.push({
        productId: selection.product._id,
        variantId: selection.variant.variantId,
        quantity: input.quantity,
        addedAt: new Date(),
      });
    }
    cart.expiresAt = this.cartExpiry(Boolean(cart.customerId));
    await this.saveCart(cart);
    await this.audit.record({
      action: 'CART_ITEM_SET',
      resourceType: 'CART',
      resourceId: cart.id,
      actorId: identity.customerId,
      context,
      metadata: { productId: input.productId, variantId, quantity: input.quantity },
    });
    return { cart: await this.toView(cart), guestTokenToSet };
  }

  async removeItem(
    identity: CartIdentity,
    variantId: string,
    input: CartMutationVersionDto,
    context: AuthRequestContext,
  ): Promise<CartOperationResult> {
    const cart = await this.findActiveCart(identity);
    if (!cart) return { cart: this.emptyView() };
    this.assertVersion(cart, input.expectedVersion);
    const initialLength = cart.items.length;
    cart.items = cart.items.filter((item) => !item.variantId.equals(variantId));
    if (cart.items.length !== initialLength) {
      cart.expiresAt = this.cartExpiry(Boolean(cart.customerId));
      await this.saveCart(cart);
      await this.audit.record({
        action: 'CART_ITEM_REMOVED',
        resourceType: 'CART',
        resourceId: cart.id,
        actorId: identity.customerId,
        context,
        metadata: { variantId },
      });
    }
    return { cart: await this.toView(cart) };
  }

  async clear(
    identity: CartIdentity,
    input: CartMutationVersionDto,
    context: AuthRequestContext,
  ): Promise<CartOperationResult> {
    const cart = await this.findActiveCart(identity);
    if (!cart) return { cart: this.emptyView() };
    this.assertVersion(cart, input.expectedVersion);
    if (cart.items.length) {
      cart.items = [];
      cart.expiresAt = this.cartExpiry(Boolean(cart.customerId));
      await this.saveCart(cart);
      await this.audit.record({
        action: 'CART_CLEARED',
        resourceType: 'CART',
        resourceId: cart.id,
        actorId: identity.customerId,
        context,
      });
    }
    return { cart: await this.toView(cart) };
  }

  async claimGuestCart(rawGuestToken: string | undefined, customerId: string): Promise<boolean> {
    if (!rawGuestToken || !Types.ObjectId.isValid(customerId)) return false;
    const tokenHash = this.tokens.hashToken(rawGuestToken);
    try {
      await this.connection.transaction(async (session): Promise<void> => {
        const guestCart = await this.carts
          .findOne({
            guestTokenHash: tokenHash,
            status: CartStatus.Active,
            expiresAt: { $gt: new Date() },
          })
          .select('+guestTokenHash')
          .session(session)
          .exec();
        if (!guestCart) return;

        const customerObjectId = new Types.ObjectId(customerId);
        const customerCart = await this.carts
          .findOne({
            customerId: customerObjectId,
            status: CartStatus.Active,
          })
          .session(session)
          .exec();
        if (!customerCart) {
          guestCart.customerId = customerObjectId;
          guestCart.guestTokenHash = undefined;
          guestCart.expiresAt = this.cartExpiry(true);
          await guestCart.save({ session });
          return;
        }

        if (customerCart.expiresAt.getTime() <= Date.now()) {
          customerCart.items = [];
        }
        const itemMap = new Map(
          customerCart.items.map((item) => [
            `${item.productId.toHexString()}:${item.variantId.toHexString()}`,
            item,
          ]),
        );
        for (const guestItem of guestCart.items) {
          const key = `${guestItem.productId.toHexString()}:${guestItem.variantId.toHexString()}`;
          const customerItem = itemMap.get(key);
          if (customerItem) {
            customerItem.quantity = Math.min(
              CART_MAX_ITEM_QUANTITY,
              customerItem.quantity + guestItem.quantity,
            );
          } else if (customerCart.items.length < CART_MAX_DISTINCT_ITEMS) {
            customerCart.items.push({
              productId: guestItem.productId,
              variantId: guestItem.variantId,
              quantity: guestItem.quantity,
              addedAt: guestItem.addedAt,
            });
          }
        }
        customerCart.expiresAt = this.cartExpiry(true);
        await customerCart.save({ session });
        await this.carts.deleteOne({ _id: guestCart._id }, { session });
      });
      return true;
    } catch (error: unknown) {
      if (error instanceof MongoServerError && error.code === 11000) {
        return false;
      }
      throw error;
    }
  }

  private async validateSelection(
    productId: string,
    variantId: string,
    quantity: number,
  ): Promise<CatalogSelection> {
    const product = await this.products
      .findOne({
        _id: productId,
        status: ProductStatus.Active,
        visibility: { $ne: 'REPAIR_INTERNAL' },
        publishedAt: { $lte: new Date() },
        variants: { $elemMatch: { variantId, isActive: true } },
      })
      .exec();
    if (!product) {
      throw new NotFoundException({
        code: 'CART_PRODUCT_UNAVAILABLE',
        message: 'Product or variant is unavailable',
      });
    }
    const variant = product.variants.find(
      (candidate) => candidate.variantId.equals(variantId) && candidate.isActive,
    );
    if (!variant) {
      throw new NotFoundException({
        code: 'CART_PRODUCT_UNAVAILABLE',
        message: 'Product or variant is unavailable',
      });
    }
    const level = await this.inventory.findOne({ productId: product._id, variantId }).exec();
    if (!level || level.onHand - level.reserved < quantity) {
      throw new ConflictException({
        code: 'CART_INSUFFICIENT_STOCK',
        message: 'Requested quantity is not currently available',
      });
    }
    return { product, variant };
  }

  private async findActiveCart(identity: CartIdentity): Promise<CartDocument | null> {
    const identityFilter = identity.customerId
      ? { customerId: new Types.ObjectId(identity.customerId) }
      : identity.guestToken
        ? { guestTokenHash: this.tokens.hashToken(identity.guestToken) }
        : undefined;
    if (!identityFilter) return null;
    return this.carts
      .findOne({ ...identityFilter, status: CartStatus.Active, expiresAt: { $gt: new Date() } })
      .select('+guestTokenHash')
      .exec();
  }

  private async createCart(
    identity: CartIdentity,
    onGuestToken: (token: string) => void,
  ): Promise<CartDocument> {
    if (identity.customerId) {
      const staleCart = await this.carts
        .findOne({
          customerId: new Types.ObjectId(identity.customerId),
          status: CartStatus.Active,
          expiresAt: { $lte: new Date() },
        })
        .exec();
      if (staleCart) {
        staleCart.items = [];
        staleCart.expiresAt = this.cartExpiry(true);
        await this.saveCart(staleCart);
        return staleCart;
      }
    }
    const guestToken = identity.customerId ? undefined : randomBytes(32).toString('base64url');
    if (guestToken) onGuestToken(guestToken);
    try {
      return await this.carts.create({
        customerId: identity.customerId ? new Types.ObjectId(identity.customerId) : undefined,
        guestTokenHash: guestToken ? this.tokens.hashToken(guestToken) : undefined,
        items: [],
        status: CartStatus.Active,
        expiresAt: this.cartExpiry(Boolean(identity.customerId)),
      });
    } catch (error: unknown) {
      if (error instanceof MongoServerError && error.code === 11000) {
        throw this.cartConflict();
      }
      throw error;
    }
  }

  private async toView(cart: CartDocument | null): Promise<CartView> {
    if (!cart) return this.emptyView();
    const productIds = cart.items.map((item) => item.productId);
    const documents = await this.products
      .find({
        _id: { $in: productIds },
        status: ProductStatus.Active,
        visibility: { $ne: 'REPAIR_INTERNAL' },
        publishedAt: { $lte: new Date() },
      })
      .exec();
    const productMap = new Map(documents.map((product) => [product.id, product]));
    const levels = await this.inventory.find({ productId: { $in: productIds } }).exec();
    const levelMap = new Map(
      levels.map((level) => [
        `${level.productId.toHexString()}:${level.variantId.toHexString()}`,
        level,
      ]),
    );
    const primaryMediaIds = documents.flatMap((product) => {
      const primary = product.images.find((image) => image.isPrimary);
      return primary ? [primary.mediaAssetId] : [];
    });
    const mediaMap = await this.loadMediaMap(primaryMediaIds);

    const items: CartItemView[] = cart.items.map((item) => {
      const product = productMap.get(item.productId.toHexString());
      const variant = product?.variants.find(
        (candidate) => candidate.variantId.equals(item.variantId) && candidate.isActive,
      );
      if (!product || !variant) {
        return {
          productId: item.productId.toHexString(),
          variantId: item.variantId.toHexString(),
          quantity: item.quantity,
          availability: 'UNAVAILABLE',
        };
      }
      const level = levelMap.get(`${item.productId.toHexString()}:${item.variantId.toHexString()}`);
      const primary = product.images.find((image) => image.isPrimary);
      const media = primary ? mediaMap.get(primary.mediaAssetId.toHexString()) : undefined;
      return {
        productId: product.id,
        variantId: variant.variantId.toHexString(),
        quantity: item.quantity,
        availability:
          level && level.onHand - level.reserved >= item.quantity
            ? 'AVAILABLE'
            : 'INSUFFICIENT_STOCK',
        productName: product.name,
        productSlug: product.slug,
        variantTitle: variant.title,
        sku: variant.sku,
        attributes: variant.attributes.map((attribute) => ({
          name: attribute.name,
          value: attribute.value,
        })),
        unitPriceInPaise: variant.priceInPaise,
        lineTotalInPaise: variant.priceInPaise * item.quantity,
        primaryImage: media ? this.toImage(media, primary?.altText || product.name) : undefined,
      };
    });
    const subtotalInPaise = items.reduce((total, item) => total + (item.lineTotalInPaise ?? 0), 0);
    return {
      id: cart.id,
      version: cart.get('version') as number,
      items,
      distinctItemCount: items.length,
      totalQuantity: items.reduce((total, item) => total + item.quantity, 0),
      subtotalInPaise,
      currency: 'INR',
      readyForCheckout:
        items.length > 0 && items.every((item) => item.availability === 'AVAILABLE'),
      expiresAt: cart.expiresAt,
    };
  }

  private async loadMediaMap(ids: Types.ObjectId[]): Promise<Map<string, MediaAssetDocument>> {
    const uniqueIds = [...new Set(ids.map((id) => id.toHexString()))].map(
      (id) => new Types.ObjectId(id),
    );
    if (!uniqueIds.length) return new Map();
    const documents = await this.mediaAssets
      .find({ _id: { $in: uniqueIds }, status: MediaStatus.Ready })
      .exec();
    return new Map(documents.map((media) => [media.id, media]));
  }

  private toImage(media: MediaAssetDocument, altText: string): StorefrontImage {
    const base = `${this.mediaUrlPrefix}/${media.id}`;
    return {
      mediaAssetId: media.id,
      altText,
      width: media.width,
      height: media.height,
      sources: {
        original: `${base}/original`,
        thumbnail: `${base}/thumbnail`,
        card: `${base}/card`,
        large: `${base}/large`,
      },
    };
  }

  private assertVersion(cart: CartDocument | null, expectedVersion?: number): void {
    if (expectedVersion === undefined) return;
    const actualVersion = cart ? (cart.get('version') as number) : 0;
    if (actualVersion !== expectedVersion) throw this.cartConflict();
  }

  private async saveCart(cart: CartDocument): Promise<void> {
    try {
      await cart.save();
    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'VersionError') throw this.cartConflict();
      throw error;
    }
  }

  private cartExpiry(authenticated: boolean): Date {
    const ttl = authenticated ? CUSTOMER_CART_TTL_SECONDS : GUEST_CART_TTL_SECONDS;
    return new Date(Date.now() + ttl * 1000);
  }

  private emptyView(): CartView {
    return {
      version: 0,
      items: [],
      distinctItemCount: 0,
      totalQuantity: 0,
      subtotalInPaise: 0,
      currency: 'INR',
      readyForCheckout: false,
    };
  }

  private cartConflict(): ConflictException {
    return new ConflictException({
      code: 'CART_VERSION_CONFLICT',
      message: 'Cart changed in another request; reload it and retry',
    });
  }
}
