import type { DatabaseMigration, MigrationContext } from './migration';

async function ensureCollection(context: MigrationContext): Promise<void> {
  if (!(await context.database.listCollections({ name: 'customer_mobile_challenges' }).hasNext())) {
    await context.connection.model('CustomerMobileChallenge').createCollection();
  }
}

export const customerProfileManagementMigration: DatabaseMigration = {
  id: '019-customer-profile-management',
  description: 'Add verified customer profile changes, preferences, and safe deactivation',
  async up(context): Promise<void> {
    await ensureCollection(context);
    await context.database.collection('customers').updateMany(
      { communicationPreferences: { $exists: false } },
      {
        $set: {
          communicationPreferences: {
            marketingEmail: false,
            backInStockEmail: true,
          },
        },
      },
    );
    await context.connection.model('Customer').createIndexes();
    await context.connection.model('CustomerMobileChallenge').createIndexes();

    await context.database.command({
      collMod: 'customers',
      validator: {
        $and: [
          {
            $jsonSchema: {
              bsonType: 'object',
              required: ['status', 'addresses', 'communicationPreferences'],
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
                communicationPreferences: {
                  bsonType: 'object',
                  additionalProperties: false,
                  required: ['marketingEmail', 'backInStockEmail'],
                  properties: {
                    marketingEmail: { bsonType: 'bool' },
                    backInStockEmail: { bsonType: 'bool' },
                  },
                },
                lastOrderAt: { bsonType: 'date' },
                lastLoginAt: { bsonType: 'date' },
                passwordChangedAt: { bsonType: 'date' },
                emailVerifiedAt: { bsonType: 'date' },
                mobileVerifiedAt: { bsonType: 'date' },
                deactivatedAt: { bsonType: 'date' },
                deactivationReason: { bsonType: 'string', maxLength: 500 },
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
          {
            $expr: {
              $or: [
                { $ne: [{ $type: '$mobileVerifiedAt' }, 'date'] },
                { $eq: [{ $type: '$mobile' }, 'string'] },
              ],
            },
          },
          {
            $expr: {
              $or: [
                { $ne: [{ $type: '$deactivatedAt' }, 'date'] },
                { $eq: ['$status', 'DISABLED'] },
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
            purpose: { enum: ['EMAIL_VERIFICATION', 'EMAIL_CHANGE', 'PASSWORD_RESET'] },
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

    await context.database.command({
      collMod: 'customer_mobile_challenges',
      validator: {
        $and: [
          {
            $jsonSchema: {
              bsonType: 'object',
              required: [
                'customerId',
                'targetMobile',
                'codeHash',
                'expiresAt',
                'active',
                'attempts',
              ],
              properties: {
                customerId: { bsonType: 'objectId' },
                targetMobile: {
                  bsonType: 'string',
                  minLength: 8,
                  maxLength: 16,
                  pattern: '^\\+?[1-9]\\d{7,14}$',
                },
                codeHash: { bsonType: 'string', pattern: '^[a-f0-9]{64}$' },
                expiresAt: { bsonType: 'date' },
                active: { bsonType: 'bool' },
                attempts: { bsonType: 'int', minimum: 0 },
                usedAt: { bsonType: 'date' },
                invalidatedAt: { bsonType: 'date' },
              },
            },
          },
          {
            $expr: {
              $or: [
                {
                  $and: [
                    { $eq: ['$active', true] },
                    { $eq: [{ $type: '$usedAt' }, 'missing'] },
                    { $eq: [{ $type: '$invalidatedAt' }, 'missing'] },
                  ],
                },
                {
                  $and: [
                    { $eq: ['$active', false] },
                    {
                      $eq: [
                        {
                          $add: [
                            { $cond: [{ $eq: [{ $type: '$usedAt' }, 'date'] }, 1, 0] },
                            {
                              $cond: [{ $eq: [{ $type: '$invalidatedAt' }, 'date'] }, 1, 0],
                            },
                          ],
                        },
                        1,
                      ],
                    },
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
