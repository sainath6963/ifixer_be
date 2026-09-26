import type { DatabaseMigration } from './migration';

export const storefrontCatalogIndexesMigration: DatabaseMigration = {
  id: '005-storefront-catalog-indexes',
  description: 'Add public catalog publication and active-variant price indexes',
  async up({ connection }): Promise<void> {
    await connection.model('Product').createIndexes();
    await connection.model('Category').createIndexes();
    await connection.model('InventoryLevel').createIndexes();
    await connection.model('MediaAsset').createIndexes();
  },
};
