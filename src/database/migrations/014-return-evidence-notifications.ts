import type { Document } from 'mongodb';

import type { DatabaseMigration, MigrationContext } from './migration';

const nonNegativeSafeInteger = (field: string): Document => ({
  $and: [
    { $eq: [{ $trunc: field }, field] },
    { $gte: [field, 0] },
    { $lte: [field, Number.MAX_SAFE_INTEGER] },
  ],
});

const positiveSafeInteger = (field: string): Document => ({
  $and: [nonNegativeSafeInteger(field), { $gte: [field, 1] }],
});

async function ensureCollection(context: MigrationContext): Promise<void> {
  const exists = await context.database.listCollections({ name: 'return_evidence' }).hasNext();
  if (!exists) await context.connection.model('ReturnEvidence').createCollection();
}

export const returnEvidenceNotificationsMigration: DatabaseMigration = {
  id: '014-return-evidence-notifications',
  description: 'Add private return evidence storage and lifecycle notification support',
  async up(context): Promise<void> {
    await ensureCollection(context);
    await context.database
      .collection('return_requests')
      .updateMany({ evidenceCount: { $exists: false } }, { $set: { evidenceCount: 0 } });
    await context.connection.model('ReturnEvidence').createIndexes();

    const returnRequestsInfo = await context.database
      .listCollections({ name: 'return_requests' }, { nameOnly: false })
      .next();
    const existingReturnValidator = returnRequestsInfo?.options?.validator as Document | undefined;
    await context.database.command({
      collMod: 'return_requests',
      validator: {
        $and: [
          existingReturnValidator ?? {},
          {
            $jsonSchema: {
              bsonType: 'object',
              required: ['evidenceCount'],
              properties: {
                evidenceCount: {
                  bsonType: 'number',
                  minimum: 0,
                  maximum: Number.MAX_SAFE_INTEGER,
                },
              },
            },
          },
          { $expr: nonNegativeSafeInteger('$evidenceCount') },
        ],
      },
      validationLevel: 'strict',
      validationAction: 'error',
    });

    await context.database.command({
      collMod: 'return_evidence',
      validator: {
        $and: [
          {
            $jsonSchema: {
              bsonType: 'object',
              required: [
                'returnRequestId',
                'orderId',
                'customerId',
                'storageProvider',
                'storageKey',
                'originalFilename',
                'mimeType',
                'sizeBytes',
                'width',
                'height',
                'checksumSha256',
                'status',
              ],
              properties: {
                returnRequestId: { bsonType: 'objectId' },
                orderId: { bsonType: 'objectId' },
                customerId: { bsonType: 'objectId' },
                storageProvider: { enum: ['LOCAL'] },
                storageKey: {
                  bsonType: 'string',
                  minLength: 1,
                  maxLength: 500,
                  pattern: '^private/return-evidence/[a-f0-9]{2}/[a-f0-9]{24}/[a-f0-9]{24}\\.webp$',
                },
                originalFilename: { bsonType: 'string', minLength: 1, maxLength: 255 },
                mimeType: { enum: ['image/webp'] },
                sizeBytes: { bsonType: 'number', minimum: 1 },
                width: { bsonType: 'number', minimum: 1 },
                height: { bsonType: 'number', minimum: 1 },
                checksumSha256: { bsonType: 'string', pattern: '^[a-f0-9]{64}$' },
                status: { enum: ['PENDING', 'READY', 'DELETED'] },
                deletedAt: { bsonType: 'date' },
              },
            },
          },
          {
            $expr: {
              $and: [
                positiveSafeInteger('$sizeBytes'),
                positiveSafeInteger('$width'),
                positiveSafeInteger('$height'),
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
