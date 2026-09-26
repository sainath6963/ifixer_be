import type { Document } from 'mongodb';

import type { DatabaseMigration, MigrationContext } from './migration';

const nonNegativeSafeInteger = (field: string): Document => ({
  $and: [
    { $eq: [{ $trunc: field }, field] },
    { $gte: [field, 0] },
    { $lte: [field, Number.MAX_SAFE_INTEGER] },
  ],
});

async function extendCustomerPreferenceValidator(context: MigrationContext): Promise<void> {
  const collection = (await context.database
    .listCollections({ name: 'customers' })
    .next()) as Document | null;
  const options = collection?.options as Document | undefined;
  const validator = structuredClone(options?.validator) as Document | undefined;
  const clauses: unknown = validator?.$and;
  if (!Array.isArray(clauses)) throw new Error('Customer validator shape is not supported');
  const schemaClause = clauses.find((clause): clause is Document =>
    Boolean(clause && typeof clause === 'object' && '$jsonSchema' in clause),
  );
  const jsonSchema = schemaClause?.$jsonSchema as Document | undefined;
  const properties = jsonSchema?.properties as Document | undefined;
  const preferences = properties?.communicationPreferences as Document | undefined;
  if (!preferences) throw new Error('Customer communication preference validator is missing');
  const preferenceProperties = preferences.properties as Document | undefined;
  if (!preferenceProperties) throw new Error('Customer preference properties are missing');

  preferences.required = [
    'marketingEmail',
    'backInStockEmail',
    'orderUpdatesSms',
    'orderUpdatesWhatsapp',
  ];
  preferenceProperties.orderUpdatesSms = { bsonType: 'bool' };
  preferenceProperties.orderUpdatesWhatsapp = { bsonType: 'bool' };
  await context.database.command({
    collMod: 'customers',
    validator,
    validationLevel: 'strict',
    validationAction: 'error',
  });
}

export const mobileCommunicationChannelsMigration: DatabaseMigration = {
  id: '022-mobile-communication-channels',
  description: 'Add SMS and WhatsApp notification delivery with explicit customer opt-ins',
  async up(context): Promise<void> {
    await context.database
      .collection('customers')
      .updateMany(
        { 'communicationPreferences.orderUpdatesSms': { $exists: false } },
        { $set: { 'communicationPreferences.orderUpdatesSms': false } },
      );
    await context.database
      .collection('customers')
      .updateMany(
        { 'communicationPreferences.orderUpdatesWhatsapp': { $exists: false } },
        { $set: { 'communicationPreferences.orderUpdatesWhatsapp': false } },
      );
    await extendCustomerPreferenceValidator(context);
    await context.connection.model('Customer').createIndexes();
    await context.connection.model('Notification').createIndexes();

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
                'textBody',
                'status',
                'attempts',
                'nextAttemptAt',
              ],
              properties: {
                outboxEventId: { bsonType: 'objectId' },
                sourceEventId: { bsonType: 'string', minLength: 1, maxLength: 100 },
                channel: { enum: ['EMAIL', 'SMS', 'WHATSAPP'] },
                templateKey: { bsonType: 'string', minLength: 1, maxLength: 160 },
                recipient: { bsonType: 'string', minLength: 3, maxLength: 254 },
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
          {
            $or: [
              {
                channel: 'EMAIL',
                recipient: { $regex: '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$' },
                subject: { $type: 'string' },
                htmlBody: { $type: 'string' },
              },
              {
                channel: { $in: ['SMS', 'WHATSAPP'] },
                recipient: { $regex: '^\\+?[1-9]\\d{7,14}$' },
              },
            ],
          },
          { $expr: nonNegativeSafeInteger('$attempts') },
        ],
      },
      validationLevel: 'strict',
      validationAction: 'error',
    });
  },
};
