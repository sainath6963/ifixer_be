import type { DatabaseMigration } from './migration';

export const customerSavedAddressesMigration: DatabaseMigration = {
  id: '011-customer-saved-addresses',
  description: 'Enforce bounded customer address books with one default and unique address IDs',
  async up(context): Promise<void> {
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
  },
};
