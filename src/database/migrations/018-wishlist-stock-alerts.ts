import type { DatabaseMigration, MigrationContext } from './migration';

async function ensureCollection(
  context: MigrationContext,
  name: string,
  model: string,
): Promise<void> {
  if (!(await context.database.listCollections({ name }).hasNext())) {
    await context.connection.model(model).createCollection();
  }
}

export const wishlistStockAlertsMigration: DatabaseMigration = {
  id: '018-wishlist-stock-alerts',
  description: 'Add customer wishlists and verified-email back-in-stock subscriptions',
  async up(context): Promise<void> {
    await ensureCollection(context, 'wishlist_items', 'WishlistItem');
    await ensureCollection(context, 'stock_alerts', 'StockAlert');
    await context.connection.model('WishlistItem').createIndexes();
    await context.connection.model('StockAlert').createIndexes();

    await context.database.command({
      collMod: 'wishlist_items',
      validator: {
        $jsonSchema: {
          bsonType: 'object',
          required: ['customerId', 'productId'],
          properties: {
            customerId: { bsonType: 'objectId' },
            productId: { bsonType: 'objectId' },
          },
        },
      },
      validationLevel: 'strict',
      validationAction: 'error',
    });

    await context.database.command({
      collMod: 'stock_alerts',
      validator: {
        $and: [
          {
            $jsonSchema: {
              bsonType: 'object',
              required: [
                'customerId',
                'productId',
                'variantId',
                'productName',
                'productSlug',
                'variantTitle',
                'sku',
                'status',
                'active',
                'requestedAt',
              ],
              properties: {
                customerId: { bsonType: 'objectId' },
                productId: { bsonType: 'objectId' },
                variantId: { bsonType: 'objectId' },
                productName: { bsonType: 'string', minLength: 1, maxLength: 180 },
                productSlug: { bsonType: 'string', minLength: 1, maxLength: 220 },
                variantTitle: { bsonType: 'string', minLength: 1, maxLength: 160 },
                sku: { bsonType: 'string', minLength: 1, maxLength: 100 },
                status: { enum: ['ACTIVE', 'NOTIFIED', 'CANCELLED'] },
                active: { bsonType: 'bool' },
                requestedAt: { bsonType: 'date' },
                notifiedAt: { bsonType: 'date' },
                cancelledAt: { bsonType: 'date' },
              },
            },
          },
          {
            $expr: {
              $or: [
                {
                  $and: [
                    { $eq: ['$status', 'ACTIVE'] },
                    { $eq: ['$active', true] },
                    { $eq: [{ $type: '$notifiedAt' }, 'missing'] },
                    { $eq: [{ $type: '$cancelledAt' }, 'missing'] },
                  ],
                },
                {
                  $and: [
                    { $eq: ['$status', 'NOTIFIED'] },
                    { $eq: ['$active', false] },
                    { $eq: [{ $type: '$notifiedAt' }, 'date'] },
                    { $eq: [{ $type: '$cancelledAt' }, 'missing'] },
                  ],
                },
                {
                  $and: [
                    { $eq: ['$status', 'CANCELLED'] },
                    { $eq: ['$active', false] },
                    { $eq: [{ $type: '$cancelledAt' }, 'date'] },
                    { $eq: [{ $type: '$notifiedAt' }, 'missing'] },
                  ],
                },
              ],
            },
          },
        ],
      },
      validationLevel: 'strict',
      validationAction: 'error',
    });
  },
};
