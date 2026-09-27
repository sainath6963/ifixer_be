import type { DatabaseMigration, MigrationContext } from './migration';

const validator = {
  $jsonSchema: {
    bsonType: 'object',
    additionalProperties: false,
    required: [
      '_id',
      'eventType',
      'visitorHash',
      'sessionHash',
      'path',
      'source',
      'referrerHost',
      'device',
      'recordedAt',
      'expiresAt',
    ],
    properties: {
      _id: { bsonType: 'objectId' },
      eventType: { enum: ['PAGE_VIEW', 'GOOGLE_REVIEW_CLICK'] },
      visitorHash: { bsonType: 'string', pattern: '^[a-f0-9]{64}$' },
      sessionHash: { bsonType: 'string', pattern: '^[a-f0-9]{64}$' },
      path: { bsonType: 'string', minLength: 1, maxLength: 200 },
      source: { enum: ['DIRECT', 'GOOGLE', 'INSTAGRAM', 'FACEBOOK', 'WHATSAPP', 'OTHER'] },
      referrerHost: { bsonType: 'string', maxLength: 253 },
      device: { enum: ['MOBILE', 'TABLET', 'DESKTOP'] },
      recordedAt: { bsonType: 'date' },
      expiresAt: { bsonType: 'date' },
    },
  },
};

async function ensureCollection(context: MigrationContext): Promise<void> {
  if (!(await context.database.listCollections({ name: 'website_events' }).hasNext())) {
    await context.database.createCollection('website_events', {
      validator,
      validationLevel: 'strict',
      validationAction: 'error',
    });
  }
}

export const websiteInsightsMigration: DatabaseMigration = {
  id: '028-website-insights',
  description: 'Privacy-conscious storefront traffic events and Google review settings',
  async up(context): Promise<void> {
    await ensureCollection(context);
    await context.connection.model('WebsiteEvent').createIndexes();
    await context.database.command({
      collMod: 'website_events',
      validator,
      validationLevel: 'strict',
      validationAction: 'error',
    });
  },
};
