import { coreModelDefinitions } from '../core-persistence.module';
import type { DatabaseMigration } from './migration';

export const createCoreCollectionsMigration: DatabaseMigration = {
  id: '001-create-core-collections-and-indexes',
  description: 'Create all core collections and declared Mongoose indexes',
  async up({ connection }): Promise<void> {
    for (const definition of coreModelDefinitions) {
      const model = connection.model(definition.name);
      await model.createCollection();
      await model.createIndexes();
    }
  },
};
