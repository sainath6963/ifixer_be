import type { DatabaseMigration } from './migration';

export const instagramReelsMigration: DatabaseMigration = {
  id: '027-instagram-reels',
  description: 'Admin-managed Instagram Reel links for the public workshop section',
  async up({ connection, database }): Promise<void> {
    const model = connection.model('InstagramReel');
    await model.createCollection();
    await model.createIndexes();
    await database.command({
      collMod: 'instagram_reels',
      validator: {
        $jsonSchema: {
          bsonType: 'object',
          required: ['url', 'title', 'active', 'sortOrder', 'version', 'createdAt', 'updatedAt'],
          properties: {
            url: {
              bsonType: 'string',
              pattern: '^https://www\\.instagram\\.com/reel/[A-Za-z0-9_-]{5,64}/$',
            },
            title: { bsonType: 'string', maxLength: 120 },
            active: { bsonType: 'bool' },
            sortOrder: { bsonType: 'number', minimum: 0, maximum: 9999, multipleOf: 1 },
            version: { bsonType: 'number', minimum: 0, multipleOf: 1 },
            createdAt: { bsonType: 'date' },
            updatedAt: { bsonType: 'date' },
          },
        },
      },
      validationLevel: 'strict',
      validationAction: 'error',
    });
  },
};
