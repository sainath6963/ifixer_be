import type { Document } from 'mongodb';

import type { DatabaseMigration } from './migration';

const nonNegativeSafeInteger = (field: string): Document => ({
  $and: [
    { $eq: [{ $trunc: field }, field] },
    { $gte: [field, 0] },
    { $lte: [field, Number.MAX_SAFE_INTEGER] },
  ],
});

export const reliableNotificationOutboxMigration: DatabaseMigration = {
  id: '010-reliable-notification-outbox',
  description: 'Add leased outbox processing and durable transactional email delivery',
  async up(context): Promise<void> {
    await context.database
      .collection('outbox_events')
      .updateMany({ processingAttempts: { $exists: false } }, { $set: { processingAttempts: 0 } });
    const existing = await context.database
      .listCollections({ name: 'notifications' }, { nameOnly: true })
      .hasNext();
    if (!existing) await context.connection.model('Notification').createCollection();

    await context.connection.model('OutboxEvent').createIndexes();
    await context.connection.model('Notification').createIndexes();

    await context.database.command({
      collMod: 'outbox_events',
      validator: {
        $and: [
          {
            $jsonSchema: {
              bsonType: 'object',
              required: [
                'eventId',
                'aggregateType',
                'aggregateId',
                'eventType',
                'payload',
                'status',
                'processingAttempts',
                'availableAt',
              ],
              properties: {
                eventId: { bsonType: 'string', minLength: 1, maxLength: 100 },
                aggregateType: { bsonType: 'string', minLength: 1, maxLength: 100 },
                aggregateId: { bsonType: 'objectId' },
                eventType: { bsonType: 'string', minLength: 1, maxLength: 160 },
                payload: { bsonType: 'object' },
                status: { enum: ['PENDING', 'PROCESSING', 'PUBLISHED', 'FAILED', 'DEAD'] },
                processingAttempts: { bsonType: 'number', minimum: 0 },
                availableAt: { bsonType: 'date' },
                lockedAt: { bsonType: 'date' },
                lockToken: { bsonType: 'string', minLength: 1, maxLength: 100 },
                publishedAt: { bsonType: 'date' },
                lastError: { bsonType: 'string', minLength: 1, maxLength: 2000 },
              },
            },
          },
          { $expr: nonNegativeSafeInteger('$processingAttempts') },
        ],
      },
      validationLevel: 'strict',
      validationAction: 'error',
    });

    await context.database.command({
      collMod: 'notifications',
      validator: {
        $and: [
          {
            $jsonSchema: {
              bsonType: 'object',
              required: [
                'outboxEventId',
                'sourceEventId',
                'channel',
                'templateKey',
                'recipient',
                'deliveryKey',
                'subject',
                'textBody',
                'htmlBody',
                'status',
                'attempts',
                'nextAttemptAt',
              ],
              properties: {
                outboxEventId: { bsonType: 'objectId' },
                sourceEventId: { bsonType: 'string', minLength: 1, maxLength: 100 },
                channel: { enum: ['EMAIL'] },
                templateKey: { bsonType: 'string', minLength: 1, maxLength: 160 },
                recipient: {
                  bsonType: 'string',
                  minLength: 3,
                  maxLength: 254,
                  pattern: '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$',
                },
                deliveryKey: { bsonType: 'string', pattern: '^[a-f0-9]{64}$' },
                subject: { bsonType: 'string', minLength: 1, maxLength: 300 },
                textBody: { bsonType: 'string', minLength: 1, maxLength: 20000 },
                htmlBody: { bsonType: 'string', minLength: 1, maxLength: 50000 },
                status: { enum: ['PENDING', 'PROCESSING', 'SENT', 'FAILED', 'DEAD'] },
                attempts: { bsonType: 'number', minimum: 0 },
                nextAttemptAt: { bsonType: 'date' },
                lockedAt: { bsonType: 'date' },
                lockToken: { bsonType: 'string', minLength: 1, maxLength: 100 },
                providerMessageId: { bsonType: 'string', minLength: 1, maxLength: 500 },
                sentAt: { bsonType: 'date' },
                lastError: { bsonType: 'string', minLength: 1, maxLength: 2000 },
              },
            },
          },
          { $expr: nonNegativeSafeInteger('$attempts') },
        ],
      },
      validationLevel: 'strict',
      validationAction: 'error',
    });
  },
};
