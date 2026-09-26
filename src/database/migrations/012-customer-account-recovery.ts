import type { DatabaseMigration, MigrationContext } from './migration';

async function ensureCollection(context: MigrationContext, collectionName: string): Promise<void> {
  const exists = await context.database.listCollections({ name: collectionName }).hasNext();
  if (!exists) await context.connection.model('CustomerActionToken').createCollection();
}

export const customerAccountRecoveryMigration: DatabaseMigration = {
  id: '012-customer-account-recovery',
  description: 'Add one-time customer verification and password-reset token constraints',
  async up(context): Promise<void> {
    await ensureCollection(context, 'customer_action_tokens');
    await context.connection.model('CustomerActionToken').createIndexes();

    await context.database.command({
      collMod: 'customers',
      validator: {
        $and: [
          {
            $jsonSchema: {
              bsonType: 'object',
              required: ['status', 'addresses'],
              properties: {
                name: { bsonType: 'string', minLength: 1, maxLength: 120 },
                email: { bsonType: 'string', minLength: 3, maxLength: 254 },
                mobile: { bsonType: 'string', minLength: 8, maxLength: 16 },
                passwordHash: { bsonType: 'string', minLength: 20 },
                status: { enum: ['ACTIVE', 'DISABLED'] },
                addresses: {
                  bsonType: 'array',
                  maxItems: 10,
                  items: {
                    bsonType: 'object',
                    additionalProperties: false,
                    required: [
                      'addressId',
                      'label',
                      'fullName',
                      'phone',
                      'line1',
                      'city',
                      'state',
                      'postalCode',
                      'countryCode',
                      'isDefault',
                    ],
                    properties: {
                      addressId: { bsonType: 'objectId' },
                      label: { bsonType: 'string', minLength: 1, maxLength: 50 },
                      fullName: { bsonType: 'string', minLength: 1, maxLength: 120 },
                      phone: { bsonType: 'string', minLength: 8, maxLength: 16 },
                      line1: { bsonType: 'string', minLength: 1, maxLength: 200 },
                      line2: { bsonType: 'string', maxLength: 200 },
                      city: { bsonType: 'string', minLength: 1, maxLength: 100 },
                      state: { bsonType: 'string', minLength: 1, maxLength: 100 },
                      postalCode: { bsonType: 'string', minLength: 6, maxLength: 6 },
                      countryCode: { enum: ['IN'] },
                      isDefault: { bsonType: 'bool' },
                    },
                  },
                },
                lastLoginAt: { bsonType: 'date' },
                passwordChangedAt: { bsonType: 'date' },
                emailVerifiedAt: { bsonType: 'date' },
              },
            },
          },
          {
            $expr: {
              $eq: [
                { $size: '$addresses' },
                { $size: { $setUnion: ['$addresses.addressId', []] } },
              ],
            },
          },
          {
            $expr: {
              $eq: [
                {
                  $sum: {
                    $map: {
                      input: '$addresses',
                      as: 'address',
                      in: { $cond: ['$$address.isDefault', 1, 0] },
                    },
                  },
                },
                { $cond: [{ $gt: [{ $size: '$addresses' }, 0] }, 1, 0] },
              ],
            },
          },
        ],
      },
      validationLevel: 'strict',
      validationAction: 'error',
    });

    await context.database.command({
      collMod: 'customer_action_tokens',
      validator: {
        $jsonSchema: {
          bsonType: 'object',
          required: ['customerId', 'purpose', 'tokenHash', 'targetEmail', 'expiresAt', 'active'],
          properties: {
            customerId: { bsonType: 'objectId' },
            purpose: { enum: ['EMAIL_VERIFICATION', 'PASSWORD_RESET'] },
            tokenHash: { bsonType: 'string', pattern: '^[a-f0-9]{64}$' },
            targetEmail: {
              bsonType: 'string',
              minLength: 3,
              maxLength: 254,
              pattern: '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$',
            },
            expiresAt: { bsonType: 'date' },
            active: { bsonType: 'bool' },
            usedAt: { bsonType: 'date' },
            invalidatedAt: { bsonType: 'date' },
          },
        },
      },
      validationLevel: 'strict',
      validationAction: 'error',
    });
  },
};
